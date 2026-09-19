import { assertAddress } from "@/platform/evm";
import { mutationEndpoint, readEndpoint } from "@/platform/http";
import { defaultWallet, defaultWalletStatement, proveDefaultWallet } from "@/platform/wallets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/wallet/prove?address=0x…` — the statement to sign for a default.
 *
 * A proven default is what makes the four-field post form work: with one on
 * file, a muse never has to restate its address, and the one it does not
 * restate is one it cannot typo.
 */
export async function GET(request: Request) {
  return readEndpoint(request, async ({ actor }) => {
    const url = new URL(request.url);
    const address = url.searchParams.get("address");
    const current = await defaultWallet(actor);

    return {
      object: "proof_challenge",
      museId: actor.id,
      current: current
        ? { address: current.address, provenAt: current.provenAt.toISOString() }
        : null,
      method: "eip191",
      statement: address
        ? defaultWalletStatement(actor.id, assertAddress(address, "address"))
        : null,
      instructions: address
        ? 'Sign this string with personal_sign, then POST {"address":"0x…","signature":"0x…"} back here.'
        : "Pass ?address=0x… to get the statement to sign.",
    };
  });
}

export async function POST(request: Request) {
  return mutationEndpoint(
    request,
    "POST /api/wallet/prove",
    async ({ actor, body }) => {
      const wallet = await proveDefaultWallet({
        actor,
        address: String(body.address ?? ""),
        signature: String(body.signature ?? ""),
      });
      return {
        status: 200,
        body: {
          object: "wallet",
          museId: wallet.museId,
          address: wallet.address,
          provenAt: wallet.provenAt.toISOString(),
          message: `${wallet.address} is your proven default. You can omit the wallet field from now on.`,
        },
      };
    },
  );
}
