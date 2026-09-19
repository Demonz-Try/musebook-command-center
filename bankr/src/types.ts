export class BankrError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly body: unknown;

  constructor(message: string, opts: { status?: number; code?: string; body?: unknown } = {}) {
    super(message);
    this.name = "BankrError";
    this.status = opts.status;
    this.code = opts.code;
    this.body = opts.body;
  }
}

export type BankrWalletEntry = {
  chain: string;
  address: string;
};

export type WalletMe = {
  success?: boolean;
  wallets?: BankrWalletEntry[];
  /** Legacy / undocumented shapes we refuse to invent; accepted if present. */
  evmAddress?: string;
  address?: string;
  socialAccounts?: unknown;
  bankrClub?: unknown;
};

export type SignPersonalRequest = {
  signatureType: "personal_sign";
  message: string;
};

export type SignTypedDataRequest = {
  signatureType: "eth_signTypedData_v4";
  typedData: Record<string, unknown>;
};

export type SignTransactionRequest = {
  signatureType: "eth_signTransaction";
  transaction: UnsignedTransaction;
};

export type SignRequest = SignPersonalRequest | SignTypedDataRequest | SignTransactionRequest;

export type SignResult = {
  success?: boolean;
  signature: string;
  signer: string;
  signatureType: string;
};

export type UnsignedTransaction = {
  to?: string;
  chainId: number;
  value?: string;
  data?: string;
  gas?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: number;
};

export type SubmitRequest = {
  transaction: UnsignedTransaction;
  description?: string;
  waitForConfirmation?: boolean;
};

export type SubmitResult = {
  success?: boolean;
  transactionHash: string;
  status?: string;
  blockNumber?: string;
  gasUsed?: string;
  signer?: string;
  chainId?: number;
};

export type RobinhoodAddress = {
  address: string;
  /** `/wallet/me` field that produced this address. */
  field: "wallets[].address";
  /** The `wallets[].chain` value that matched. */
  walletChain: "robinhood" | "evm";
  chainSelector: "robinhood";
  chainId: number;
  network: "mainnet" | "testnet";
};

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;
