/**
 * Robinhood Chain is the escrow target. Bankr's Wallet API names it
 * `robinhood` and signs from a single EVM address that is the same on every
 * EVM chain Bankr supports (Base, Ethereum, Polygon, Unichain, World Chain,
 * Arbitrum, BNB, Robinhood).
 *
 * `/wallet/me` does not return a per-chain address. The Robinhood address is
 * the EVM wallet: `wallets[].address` where `chain === "evm"` (or, if Bankr
 * ever splits it out, `chain === "robinhood"`).
 */
export const BANKR_API_URL_DEFAULT = "https://api.bankr.bot";
export const BANKR_API_KEY_ENV = "BANKR_API_KEY";
export const BANKR_API_URL_ENV = "BANKR_API_URL";

/** Bankr's chain selector string, used by portfolio / swap / CLI `--chain`. */
export const ROBINHOOD_CHAIN_SELECTOR = "robinhood" as const;

export const ROBINHOOD_MAINNET = {
  selector: ROBINHOOD_CHAIN_SELECTOR,
  name: "Robinhood Chain",
  chainId: 4663,
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
} as const;

export const ROBINHOOD_TESTNET = {
  selector: ROBINHOOD_CHAIN_SELECTOR,
  name: "Robinhood Chain Testnet",
  chainId: 46630,
  rpc: "https://rpc.testnet.chain.robinhood.com",
  explorer: "https://explorer.testnet.chain.robinhood.com",
  faucet: "https://faucet.testnet.chain.robinhood.com",
} as const;

export type RobinhoodNetwork = "mainnet" | "testnet";

export function robinhoodNetwork(network: RobinhoodNetwork) {
  return network === "testnet" ? ROBINHOOD_TESTNET : ROBINHOOD_MAINNET;
}

/**
 * Bankr's documented `/wallet/submit` chainId table lists 4663 (mainnet) and
 * does not list 46630 (testnet). We still send 46630 for a testnet CREATE;
 * if Bankr rejects it, sign the CREATE with `/wallet/sign`
 * (`eth_signTransaction`) and broadcast the signed payload via the public RPC
 * — still no EVM key in our process.
 */
export const BANKR_SUBMIT_DOCUMENTED_CHAIN_IDS = [
  8453, // Base
  1, // Ethereum
  137, // Polygon
  130, // Unichain
  480, // World Chain
  42161, // Arbitrum
  56, // BNB Chain
  4663, // Robinhood Chain mainnet
] as const;
