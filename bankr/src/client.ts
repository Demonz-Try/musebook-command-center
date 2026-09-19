import {
  BANKR_API_KEY_ENV,
  BANKR_API_URL_DEFAULT,
  BANKR_API_URL_ENV,
  ROBINHOOD_CHAIN_SELECTOR,
  robinhoodNetwork,
  type RobinhoodNetwork,
} from "./chains.js";
import {
  BankrError,
  type FetchLike,
  type RobinhoodAddress,
  type SignResult,
  type SubmitRequest,
  type SubmitResult,
  type UnsignedTransaction,
  type WalletMe,
} from "./types.js";

export type BankrClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  fetch?: FetchLike;
};

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export function resolveApiKey(explicit?: string): string {
  const key = explicit ?? readEnv(BANKR_API_KEY_ENV);
  if (!key) {
    throw new BankrError(
      `${BANKR_API_KEY_ENV} is not set. Mint a bk_… key at https://bankr.bot/api-keys (do not run bankr login from this repo).`,
      { code: "missing_api_key" },
    );
  }
  if (!key.startsWith("bk_")) {
    throw new BankrError(`${BANKR_API_KEY_ENV} must be a Bankr API key starting with bk_. Never an EVM private key.`, {
      code: "invalid_api_key",
    });
  }
  return key;
}

/**
 * Pick the Robinhood Chain address out of `GET /wallet/me`.
 *
 * Expected field: `wallets[].address` where `chain` is `"evm"`. Bankr uses one
 * EVM address across every EVM chain it supports, including Robinhood Chain
 * (selector `robinhood`, mainnet 4663). A `chain: "robinhood"` entry, if Bankr
 * ever emits one, wins.
 */
export function resolveRobinhoodAddress(me: WalletMe, network: RobinhoodNetwork = "mainnet"): RobinhoodAddress {
  const wallets = me.wallets ?? [];
  const robinhood = wallets.find((w) => w.chain === "robinhood" && isHexAddress(w.address));
  const evm = wallets.find((w) => w.chain === "evm" && isHexAddress(w.address));
  const matched = robinhood ?? evm;
  if (!matched) {
    throw new BankrError(
      'GET /wallet/me did not include an EVM address. Expected wallets[].address where chain is "evm" (Robinhood Chain uses that address).',
      { code: "missing_evm_wallet", body: me },
    );
  }
  const net = robinhoodNetwork(network);
  return {
    address: matched.address,
    field: "wallets[].address",
    walletChain: matched.chain === "robinhood" ? "robinhood" : "evm",
    chainSelector: ROBINHOOD_CHAIN_SELECTOR,
    chainId: net.chainId,
    network,
  };
}

function isHexAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function createBankrClient(options: BankrClientOptions = {}) {
  const apiKey = resolveApiKey(options.apiKey);
  const baseUrl = (options.baseUrl ?? readEnv(BANKR_API_URL_ENV) ?? BANKR_API_URL_DEFAULT).replace(/\/$/, "");
  const fetchImpl: FetchLike = options.fetch ?? (globalThis.fetch as FetchLike);

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      "X-API-Key": apiKey,
      Accept: "application/json",
    };
    const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(`${baseUrl}${path}`, init);
    const text = await res.text();
    const parsed = text.length === 0 ? undefined : parseJson(text);
    if (!res.ok) {
      throw new BankrError(httpErrorMessage(res.status, parsed, text), {
        status: res.status,
        code: errorCode(parsed, res.status),
        body: parsed ?? text,
      });
    }
    return (parsed as T) ?? ({} as T);
  }

  function signPersonal(message: string): Promise<SignResult> {
    if (!message) {
      throw new BankrError("personal_sign requires a message", { code: "missing_message" });
    }
    return request<SignResult>("POST", "/wallet/sign", {
      signatureType: "personal_sign",
      message,
    });
  }

  function submit(input: SubmitRequest): Promise<SubmitResult> {
    assertChainId(input.transaction.chainId);
    const transaction = compactTransaction(input.transaction);
    const body: Record<string, unknown> = { transaction };
    if (input.description !== undefined) body.description = input.description;
    if (input.waitForConfirmation !== undefined) body.waitForConfirmation = input.waitForConfirmation;
    return request<SubmitResult>("POST", "/wallet/submit", body);
  }

  function submitCreate(opts: {
    data: string;
    chainId: number;
    value?: string;
    description?: string;
    waitForConfirmation?: boolean;
  }): Promise<SubmitResult> {
    if (!opts.data || !opts.data.startsWith("0x")) {
      throw new BankrError("CREATE data must be 0x-prefixed init bytecode", { code: "invalid_bytecode" });
    }
    const tx: UnsignedTransaction = { chainId: opts.chainId, data: opts.data };
    if (opts.value !== undefined) tx.value = opts.value;
    const req: SubmitRequest = {
      transaction: tx,
      description: opts.description ?? "MusebookBountyEscrow CREATE",
      waitForConfirmation: opts.waitForConfirmation ?? true,
    };
    return submit(req);
  }

  return {
    /**
     * `GET /wallet/me` — read. Any valid key with a wallet, including read-only.
     */
    getMe(): Promise<WalletMe> {
      return request<WalletMe>("GET", "/wallet/me");
    },

    async getRobinhoodAddress(network: RobinhoodNetwork = "mainnet"): Promise<RobinhoodAddress> {
      const me = await request<WalletMe>("GET", "/wallet/me");
      return resolveRobinhoodAddress(me, network);
    },

    /**
     * `POST /wallet/sign` with `personal_sign` — EIP-191. Write: rejected by a
     * read-only key. Bankr holds the secp256k1 key; we only store the API key.
     *
     * For a `cc-submit-v1` payout proof, pass the 32-byte **struct hash** as a
     * `0x`-prefixed hex string (not the already-wrapped on-chain digest). The
     * contract wraps that hash with `toEthSignedMessageHash`; `personal_sign`
     * does the same wrap once.
     */
    signPersonal,

    /** Alias used by bounty payout-proof callers. */
    signPayoutProof: signPersonal,

    signTransaction(transaction: UnsignedTransaction): Promise<SignResult> {
      assertChainId(transaction.chainId);
      return request<SignResult>("POST", "/wallet/sign", {
        signatureType: "eth_signTransaction",
        transaction: compactTransaction(transaction),
      });
    },

    /**
     * `POST /wallet/submit` — Bankr signs and broadcasts. Write. For CREATE,
     * omit `to` and put init bytecode in `data`.
     */
    submit,
    submitCreate,
  };
}

export type BankrClient = ReturnType<typeof createBankrClient>;

function compactTransaction(tx: UnsignedTransaction): Record<string, unknown> {
  const out: Record<string, unknown> = { chainId: tx.chainId };
  if (tx.to !== undefined) out.to = tx.to;
  if (tx.value !== undefined) out.value = tx.value;
  if (tx.data !== undefined) out.data = tx.data;
  if (tx.gas !== undefined) out.gas = tx.gas;
  if (tx.gasPrice !== undefined) out.gasPrice = tx.gasPrice;
  if (tx.maxFeePerGas !== undefined) out.maxFeePerGas = tx.maxFeePerGas;
  if (tx.maxPriorityFeePerGas !== undefined) out.maxPriorityFeePerGas = tx.maxPriorityFeePerGas;
  if (tx.nonce !== undefined) out.nonce = tx.nonce;
  return out;
}

function assertChainId(chainId: number) {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new BankrError(`invalid chainId ${chainId}`, { code: "invalid_chain_id" });
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorCode(parsed: unknown, status: number): string {
  if (parsed && typeof parsed === "object") {
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.errorCode === "string") return rec.errorCode;
    if (typeof rec.error === "string" && /read-only/i.test(rec.error)) return "read_only_key";
  }
  if (status === 403) return "forbidden";
  if (status === 401) return "unauthorized";
  return `http_${status}`;
}

function httpErrorMessage(status: number, parsed: unknown, text: string): string {
  if (parsed && typeof parsed === "object") {
    const rec = parsed as Record<string, unknown>;
    const err = typeof rec.error === "string" ? rec.error : undefined;
    const msg = typeof rec.message === "string" ? rec.message : undefined;
    if (err && msg) return `Bankr ${status}: ${err}: ${msg}`;
    if (err) return `Bankr ${status}: ${err}`;
    if (msg) return `Bankr ${status}: ${msg}`;
  }
  if (status === 403) {
    return "Bankr 403: write endpoint rejected this key (read-only, Wallet API off, IP allowlist, or wallet security).";
  }
  return `Bankr ${status}: ${text.slice(0, 240)}`;
}
