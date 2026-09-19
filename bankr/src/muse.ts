/**
 * Thin muse-facing adapter. The family agent never imports this with a
 * read-write key — it would let a compromised poll loop sign payout proofs
 * and submit funding transactions. A muse (or an operator machine) calls
 * this, then pastes the address into the bounty command.
 */
import { createBankrClient, type BankrClientOptions } from "./client.js";
import type { RobinhoodNetwork } from "./chains.js";

export async function declaredFunderAddress(
  options: BankrClientOptions & { network?: RobinhoodNetwork } = {},
): Promise<string> {
  const { network, ...clientOpts } = options;
  const client = createBankrClient(clientOpts);
  const resolved = await client.getRobinhoodAddress(network ?? "mainnet");
  return resolved.address;
}

/**
 * Fifth pipe field of `@bountydesk post | …`. The contract records this and
 * refuses funding from any other address. Checksummed 0x addresses pass
 * through byte-identical; this helper returns whatever Bankr returned.
 */
export function bountyFundingField(address: string): string {
  return address;
}
