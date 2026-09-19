import type { Actor } from "@/platform/identity";
import { resolveWallet } from "@/platform/wallets";
import { PlatformError } from "@/platform/errors";
import { mutationEndpoint, readEndpoint } from "@/platform/http";
import { displayMoney, money, parseAmount, type Money } from "@/platform/money";
import {
  arbiterRecommended,
  createBounty,
  listBounties,
} from "@/modules/bounty/escrow";
import { bountyView } from "@/modules/bounty/view";
import { SUBJECT_KIND } from "@/modules/bounty/escrow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = [
  "OPEN",
  "FUNDED",
  "IN_REVIEW",
  "PAID",
  "REFUNDED",
  "DISPUTED",
] as const;

export async function GET(request: Request) {
  return readEndpoint(request, async () => {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    if (status && !STATUSES.includes(status as (typeof STATUSES)[number])) {
      throw new PlatformError(
        "validation",
        `status must be one of: ${STATUSES.join(", ")}`,
      );
    }
    const rows = await listBounties({
      status: (status as (typeof STATUSES)[number]) ?? undefined,
      owner: url.searchParams.get("owner") ?? undefined,
    });
    return { object: "list", data: rows.map(bountyView) };
  });
}

/**
 * Amounts arrive either as exact minor units with a currency — the shape a
 * script should send, because it cannot be misread — or as a string a human
 * wrote, which goes through the same refuse-to-guess parser the commands use.
 */
function amountFrom(body: Record<string, unknown>): Money {
  if (body.amountMinor !== undefined) {
    if (typeof body.currency !== "string") {
      throw new PlatformError(
        "ambiguous_amount",
        "amountMinor needs an explicit currency",
      );
    }
    return money(BigInt(String(body.amountMinor)), body.currency);
  }
  if (typeof body.amount === "string") return parseAmount(body.amount);
  throw new PlatformError(
    "ambiguous_amount",
    'send {"amount":"0.005 ETH"} or {"amountMinor":"25000","currency":"USD"}',
  );
}

/** Written out, or the caller's proven default. Never guessed. */
async function fundingAddressFor(actor: Actor, body: Record<string, unknown>) {
  const declared = body.fundingAddress ?? body.wallet;
  const { address } = await resolveWallet({
    actor,
    declared: declared ? String(declared) : undefined,
    purpose: "funding wallet address",
  });
  return address;
}

export async function POST(request: Request) {
  return mutationEndpoint(request, "POST /api/bounties", async ({ actor, body }) => {
    const amount = amountFrom(body);
    const arbiter = typeof body.arbiter === "string" ? body.arbiter : undefined;

    // The same question `@bountyboard post` asks, asked the way an API can.
    // Skipping it here would make this route the quiet way to do the thing the
    // other route stops to warn about, which is the only way a warning like
    // this ever actually fails.
    if (!arbiter && arbiterRecommended(amount) && body.confirmed !== true) {
      throw new PlatformError(
        "confirmation_required",
        `${displayMoney(amount)} with no arbiter. Once a submission proves its reward address the on-chain refund closes for good, ` +
          `and without an arbiter nobody but the owner can settle a dispute after that. ` +
          `Send "arbiter", or resend with {"confirmed": true} and a fresh Idempotency-Key.`,
      );
    }

    const bounty = await createBounty({
      title: String(body.title ?? ""),
      brief: String(body.brief ?? ""),
      amount,
      creator: actor,
      fundingAddress: await fundingAddressFor(actor, body),
      arbiter,
      councilQuorum:
        typeof body.councilQuorum === "number" ? body.councilQuorum : undefined,
      deadlineAt: String(body.deadlineAt ?? ""),
    });
    return {
      status: 201,
      body: { bounty: bountyView(bounty) },
      receiptSubject: { kind: SUBJECT_KIND, id: bounty.id },
    };
  });
}
