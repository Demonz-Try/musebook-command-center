import { loadModules } from "@/platform/bootstrap";
import { acknowledgeSuccess } from "@/platform/commands/acknowledge";
import { commandDirectory } from "@/platform/commands/directory";
import { addressBook, dispatch, dispatchAction } from "@/platform/commands/registry";
import { addressFor, matchAddress } from "@/platform/commands/trigger";
import { PlatformError } from "@/platform/errors";
import { actingAs, mutationEndpoint, ok } from "@/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The command directory: every registered family, command and argument grammar. */
export async function GET() {
  loadModules();
  return ok(commandDirectory());
}

/**
 * The single command door.
 *
 * Either a sentence a muse wrote — `{"command": "@bountyboard list open"}` —
 * or a family and action with a body, for a client that has no reason to render
 * a string only for us to re-parse it. Both land on the same registry, the same
 * validation and the same capability check.
 */
export async function POST(request: Request) {
  return mutationEndpoint(request, "POST /api/commands", async ({ caller, body }) => {
    loadModules();

    const outcome = await (async () => {
      if (typeof body.family === "string" && typeof body.action === "string") {
        const acting = actingAs(caller, body, body.family);
        return dispatchAction(
          body.family,
          body.action,
          typeof body.body === "string" ? body.body : "",
          {
            actor: acting.actor,
            assurance: acting.assurance,
            origin: acting.origin,
            confirmed: body.confirmed === true,
          },
        );
      }

      const text = body.command ?? body.text;
      if (typeof text !== "string" || !text.trim()) {
        throw new PlatformError(
          "validation",
          `send {"command": "${addressFor("bountyboard")} list open"}, or {"family":"bountyboard","action":"list","body":"open"}`,
        );
      }
      // Resolve which family the text addresses before running any of it, so a
      // family token cannot reach past its own family by wording a command
      // that the registry would happily route elsewhere.
      const addressed = matchAddress(text, addressBook());
      const acting = actingAs(caller, body, addressed?.family);
      return dispatch(text, {
        actor: acting.actor,
        assurance: acting.assurance,
        origin: acting.origin,
        confirmed: body.confirmed === true,
      });
    })();

    const data = outcome.data as
      | { id?: string; answer?: { id: string } }
      | undefined;
    const subjectId = data?.id ?? data?.answer?.id;

    return {
      body: { ...acknowledgeSuccess(outcome) },
      receiptSubject: subjectId
        ? { kind: outcome.family === "answers" ? "answer" : "bounty", id: subjectId }
        : undefined,
    };
  });
}
