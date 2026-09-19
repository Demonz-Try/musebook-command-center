import { afterEach, describe, expect, it } from "vitest";
import { createBankrClient, resolveApiKey, resolveRobinhoodAddress } from "../src/client.js";
import { BankrError } from "../src/types.js";
import { declaredFunderAddress } from "../src/muse.js";
import { ROBINHOOD_CHAIN_SELECTOR, ROBINHOOD_MAINNET, ROBINHOOD_TESTNET } from "../src/chains.js";
import type { FetchLike } from "../src/types.js";

const EVM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const KEY = "bk_test_readonly_or_write_key";

const meBody = {
  success: true,
  wallets: [
    { chain: "evm", address: EVM },
    { chain: "solana", address: "5DcK1111111111111111111111111111111111NdR" },
  ],
};

type Call = { url: string; method?: string; headers?: Record<string, string>; body?: string };

function mockFetch(handler: (call: Call) => { status: number; body: unknown }): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = { url };
    if (init?.method !== undefined) call.method = init.method;
    if (init?.headers !== undefined) call.headers = init.headers;
    if (init?.body !== undefined) call.body = init.body;
    calls.push(call);
    const result = handler(call);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      async text() {
        return typeof result.body === "string" ? result.body : JSON.stringify(result.body);
      },
    };
  };
  return { fetch, calls };
}

afterEach(() => {
  delete process.env.BANKR_API_KEY;
  delete process.env.BANKR_API_URL;
});

describe("resolveApiKey", () => {
  it("requires BANKR_API_KEY and rejects a value that is not a bk_ key", () => {
    expect(() => resolveApiKey()).toThrow(/BANKR_API_KEY is not set/);
    expect(() => resolveApiKey("0xabc")).toThrow(/Never an EVM private key/);
    expect(resolveApiKey("bk_live_ok")).toBe("bk_live_ok");
  });
});

describe("resolveRobinhoodAddress", () => {
  it("reads wallets[].address where chain is evm", () => {
    const resolved = resolveRobinhoodAddress(meBody);
    expect(resolved).toEqual({
      address: EVM,
      field: "wallets[].address",
      walletChain: "evm",
      chainSelector: ROBINHOOD_CHAIN_SELECTOR,
      chainId: ROBINHOOD_MAINNET.chainId,
      network: "mainnet",
    });
  });

  it("prefers a robinhood chain entry if Bankr ever emits one", () => {
    const rh = "0x1111111111111111111111111111111111111111";
    const resolved = resolveRobinhoodAddress({
      wallets: [
        { chain: "evm", address: EVM },
        { chain: "robinhood", address: rh },
      ],
    });
    expect(resolved.address).toBe(rh);
    expect(resolved.walletChain).toBe("robinhood");
  });

  it("uses testnet chainId 46630 without changing the address", () => {
    const resolved = resolveRobinhoodAddress(meBody, "testnet");
    expect(resolved.address).toBe(EVM);
    expect(resolved.chainId).toBe(ROBINHOOD_TESTNET.chainId);
  });

  it("errors when there is no EVM wallet", () => {
    expect(() => resolveRobinhoodAddress({ wallets: [{ chain: "solana", address: "abc" }] })).toThrow(
      /Expected wallets\[\]\.address/,
    );
  });
});

describe("createBankrClient HTTP", () => {
  it("GET /wallet/me with X-API-Key and returns the Robinhood address", async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 200, body: meBody }));
    const client = createBankrClient({ apiKey: KEY, fetch });
    const resolved = await client.getRobinhoodAddress();
    expect(resolved.address).toBe(EVM);
    expect(resolved.field).toBe("wallets[].address");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.bankr.bot/wallet/me");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers?.["X-API-Key"]).toBe(KEY);
    expect(JSON.stringify(calls[0])).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });

  it("POST /wallet/sign personal_sign for a payout-proof digest", async () => {
    const digest = "0x" + "ab".repeat(32);
    const { fetch, calls } = mockFetch(() => ({
      status: 200,
      body: { success: true, signature: "0xsig", signer: EVM, signatureType: "personal_sign" },
    }));
    const client = createBankrClient({ apiKey: KEY, fetch });
    const result = await client.signPayoutProof(digest);
    expect(result.signature).toBe("0xsig");
    expect(result.signer).toBe(EVM);
    expect(calls[0]?.url).toBe("https://api.bankr.bot/wallet/sign");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      signatureType: "personal_sign",
      message: digest,
    });
    expect(calls[0]?.headers?.["X-API-Key"]).toBe(KEY);
    expect(calls[0]?.body).not.toMatch(/privateKey|mnemonic|keystore/i);
  });

  it("POST /wallet/submit CREATE with Robinhood mainnet chainId 4663 and no to", async () => {
    const { fetch, calls } = mockFetch(() => ({
      status: 200,
      body: { success: true, transactionHash: "0xhash", status: "success", signer: EVM, chainId: 4663 },
    }));
    const client = createBankrClient({ apiKey: KEY, fetch });
    const result = await client.submitCreate({ data: "0x60806040", chainId: 4663 });
    expect(result.transactionHash).toBe("0xhash");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(calls[0]?.url).toBe("https://api.bankr.bot/wallet/submit");
    expect(body.transaction).toEqual({ chainId: 4663, data: "0x60806040" });
    expect(body.transaction.to).toBeUndefined();
    expect(body.waitForConfirmation).toBe(true);
  });

  it("maps a read-only 403 on /wallet/sign", async () => {
    const { fetch } = mockFetch(() => ({
      status: 403,
      body: { error: "Read-only API key", message: "This API key has read-only access." },
    }));
    const client = createBankrClient({ apiKey: KEY, fetch });
    await expect(client.signPersonal("hello")).rejects.toMatchObject({
      name: "BankrError",
      status: 403,
      code: "read_only_key",
    });
  });

  it("honours BANKR_API_URL", async () => {
    process.env.BANKR_API_URL = "https://example.test/bankr/";
    const { fetch, calls } = mockFetch(() => ({ status: 200, body: meBody }));
    const client = createBankrClient({ apiKey: KEY, fetch });
    await client.getMe();
    expect(calls[0]?.url).toBe("https://example.test/bankr/wallet/me");
  });
});

describe("declaredFunderAddress", () => {
  it("returns the EVM address a bounty command should declare", async () => {
    const { fetch } = mockFetch(() => ({ status: 200, body: meBody }));
    await expect(declaredFunderAddress({ apiKey: KEY, fetch })).resolves.toBe(EVM);
  });
});

describe("BankrError on missing key via env", () => {
  it("createBankrClient reads BANKR_API_KEY", () => {
    process.env.BANKR_API_KEY = KEY;
    const { fetch } = mockFetch(() => ({ status: 200, body: meBody }));
    expect(() => createBankrClient({ fetch })).not.toThrow();
  });

  it("refuses to treat a hex key as an API key", () => {
    expect(() => createBankrClient({ apiKey: "0x" + "ab".repeat(32) })).toThrow(BankrError);
  });
});
