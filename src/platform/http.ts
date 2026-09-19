import { NextResponse } from "next/server";
import { receiptView } from "@/modules/bounty/view";
import { capAt, MENTION_CEILING, type Assurance } from "./assurance";
import { authenticate, type Caller } from "./auth";
import type { CommandOrigin } from "./commands/types";
import { loadModules } from "./bootstrap";
import { dispatchAction } from "./commands/registry";
import { PlatformError } from "./errors";
import { muse, type Actor } from "./identity";
import { requireIdempotencyKey, withIdempotency } from "./idempotency";
import { readReceipts, type Receipt } from "./receipts";

export const runtime = "nodejs";

export function ok(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

/** Errors are always `{ error: { code, message } }` — never HTML. */
export function fail(error: unknown): NextResponse {
  if (error instanceof PlatformError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  console.error("unhandled command-center error", error);
  return NextResponse.json(
    { error: { code: "internal", message: "something went wrong" } },
    { status: 500 },
  );
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new PlatformError("validation", "a JSON object body is required");
  }
}

/** Reads a GET endpoint: authenticate, run, return JSON. */
export async function readEndpoint(
  request: Request,
  run: (ctx: { actor: Actor; caller: Caller }) => Promise<unknown>,
): Promise<NextResponse> {
  try {
    loadModules();
    const caller = await authenticate(request);
    return ok(await run({ actor: caller.actor, caller }));
  } catch (error) {
    return fail(error);
  }
}

export interface Acting {
  actor: Actor;
  assurance: Assurance;
  origin: CommandOrigin;
}

/**
 * Who the request is actually for.
 *
 * A muse key speaks for itself, and its assurance is whatever the key earned.
 * A family token speaks for someone else: it must name that muse, it may only
 * reach its own family, and what it forwards is capped at `platform_asserted`
 * however the token was issued — a router relaying a mention has exactly the
 * evidence the mention had, which is musebook's word and no signature.
 *
 * That cap is what keeps the agent runtime a client rather than an authority:
 * it can open a bounty on a muse's behalf and it cannot release one.
 */
export function actingAs(
  caller: Caller,
  body: Record<string, unknown>,
  family?: string,
): Acting {
  if (caller.scope !== "family") {
    return { actor: caller.actor, assurance: caller.assurance, origin: "direct" };
  }

  if (family && caller.family !== family) {
    throw new PlatformError(
      "capability_denied",
      `this token is scoped to the ${caller.family} family and cannot dispatch to ${family}`,
    );
  }

  const onBehalfOf = body.on_behalf_of ?? body.onBehalfOf;
  if (typeof onBehalfOf !== "string" || !onBehalfOf.trim()) {
    throw new PlatformError(
      "unauthorized",
      `a family token never acts as itself — send {"on_behalf_of": "muse_xxxxxxxxxx"} ` +
        `naming the muse whose post you are forwarding`,
    );
  }

  return {
    actor: muse(onBehalfOf),
    assurance: capAt(caller.assurance, MENTION_CEILING),
    origin: "mention",
  };
}

export interface MutationResult {
  status?: number;
  body: Record<string, unknown>;
  /** Subject whose receipt trail should be attached to the response. */
  receiptSubject?: { kind: string; id: string };
}

/**
 * Every mutating endpoint: authenticate, require an idempotency key, run at
 * most once per key, and return complete receipt material so the caller can
 * post its receipt without a second request.
 */
export async function mutationEndpoint(
  request: Request,
  endpoint: string,
  run: (ctx: {
    actor: Actor;
    caller: Caller;
    body: Record<string, unknown>;
  }) => Promise<MutationResult>,
): Promise<NextResponse> {
  try {
    loadModules();
    const caller = await authenticate(request);
    const body = await jsonBody(request);
    // Idempotency belongs to the muse the work is for, not to the token that
    // carried it: `mb_post:<post_id>` must mean the same thing whether the
    // muse retried through the agent or by hand.
    const actor = actingAs(caller, body).actor;
    const key = requireIdempotencyKey(request, body);

    const outcome = await withIdempotency(
      { actor, key, endpoint, request: body },
      async () => {
        const result = await run({ actor, caller, body });
        const receipts = result.receiptSubject
          ? await readReceipts(
              result.receiptSubject.kind,
              result.receiptSubject.id,
            )
          : [];
        return {
          status: result.status ?? 200,
          body: {
            ...result.body,
            ...receiptEnvelope(receipts),
          },
        };
      },
    );

    return NextResponse.json(
      {
        ...outcome.body,
        // Recorded on every mutating response: we never claim to have known
        // more about the caller than we did.
        caller: {
          muse: actor.id,
          assurance: actingAs(caller, body).assurance,
          boundVia: caller.boundVia,
          ...(caller.scope === "family"
            ? { forwardedBy: { muse: caller.actor.id, family: caller.family } }
            : {}),
        },
        idempotency: { key: outcome.key, replayed: outcome.replayed },
      },
      {
        status: outcome.status,
        headers: { "idempotency-replayed": String(outcome.replayed) },
      },
    );
  } catch (error) {
    return fail(error);
  }
}

/**
 * The spec's verb-per-endpoint routes — `POST /api/bounty`, `/api/fund`,
 * `/api/claim`, `/api/answer`, `/api/decide`, `/api/vote` — as thin adapters
 * over the generic invoke path.
 *
 * They exist because the interface guide's worked example calls them by name,
 * and a named endpoint is a better contract for an agent than a command string
 * it has to render. They are adapters rather than parallel implementations so
 * there is exactly one place where authorization happens: the same registry
 * dispatch, with the caller's real assurance, so `/api/fund` cannot be an
 * easier door into a money transition than `@bountyboard fund` is.
 */
export function verbEndpoint(
  request: Request,
  endpoint: string,
  spec: {
    family: string;
    action: string;
    /** Maps the JSON body onto the command's declared argument names. */
    args: (body: Record<string, unknown>) => Record<string, unknown>;
    subject?: (
      body: Record<string, unknown>,
      data: unknown,
    ) => { kind: string; id: string } | undefined;
  },
): Promise<NextResponse> {
  return mutationEndpoint(request, endpoint, async ({ caller, body }) => {
    const acting = actingAs(caller, body, spec.family);
    const outcome = await dispatchAction(
      spec.family,
      spec.action,
      prune(spec.args(body)),
      {
        actor: acting.actor,
        assurance: acting.assurance,
        origin: acting.origin,
        // The API's "yes". A caller that got `confirmation_required` retries
        // with this set, which keeps the acknowledgement in the request that
        // performs the action rather than in a session somewhere.
        confirmed: body.confirmed === true,
      },
    );
    return {
      body: {
        object: "command_result",
        command: `${outcome.family} ${outcome.action}`,
        message: outcome.message,
        data: outcome.data ?? null,
        effects: outcome.effects,
      },
      receiptSubject: spec.subject?.(body, outcome.data),
    };
  });
}

function prune(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  );
}

function receiptEnvelope(receipts: Receipt[]) {
  if (receipts.length === 0) return {};
  const views = receipts.map(receiptView);
  return { receipt: views.at(-1), receipts: views };
}
