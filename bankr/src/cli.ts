#!/usr/bin/env node
/**
 * bankr-wallet — resolve the Robinhood Chain address Bankr holds, request an
 * EIP-191 signature, or ask Bankr to sign+submit. No EVM private key ever
 * enters this process.
 *
 *   BANKR_API_KEY=bk_… npx tsx src/cli.ts address
 *   BANKR_API_KEY=bk_… npx tsx src/cli.ts sign --message "0x…"
 *   BANKR_API_KEY=bk_… npx tsx src/cli.ts submit-create --data 0x… --chain-id 46630
 */
import { parseArgs } from "node:util";
import { createBankrClient } from "./client.js";
import { ROBINHOOD_MAINNET, ROBINHOOD_TESTNET } from "./chains.js";
import { BankrError } from "./types.js";

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv.slice(2),
    options: {
      network: { type: "string", default: "mainnet" },
      message: { type: "string" },
      data: { type: "string" },
      to: { type: "string" },
      value: { type: "string" },
      "chain-id": { type: "string" },
      description: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const command = positionals[0] ?? "help";
  if (values.help || command === "help") {
    process.stdout.write(usage());
    return;
  }

  const network = values.network === "testnet" ? "testnet" : "mainnet";
  const client = createBankrClient();

  if (command === "address") {
    const resolved = await client.getRobinhoodAddress(network);
    if (values.json) {
      process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${resolved.address}\n`);
    process.stderr.write(
      `field ${resolved.field} chain=${resolved.walletChain} selector=${resolved.chainSelector} chainId=${resolved.chainId}\n`,
    );
    return;
  }

  if (command === "sign" || command === "sign-payout-proof") {
    const message = values.message;
    if (!message) throw new BankrError("sign requires --message", { code: "missing_message" });
    const result = await client.signPayoutProof(message);
    if (values.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${result.signature}\n`);
    process.stderr.write(`signer ${result.signer} type ${result.signatureType}\n`);
    return;
  }

  if (command === "submit-create") {
    const data = values.data;
    if (!data) throw new BankrError("submit-create requires --data (init bytecode)", { code: "invalid_bytecode" });
    const chainId = parseChainId(values["chain-id"], network);
    const result = await client.submitCreate({
      data,
      chainId,
      ...(values.value !== undefined ? { value: values.value } : {}),
      ...(values.description !== undefined ? { description: values.description } : {}),
    });
    writeSubmit(result, values.json === true);
    return;
  }

  if (command === "submit") {
    const chainId = parseChainId(values["chain-id"], network);
    const result = await client.submit({
      transaction: {
        chainId,
        ...(values.to !== undefined ? { to: values.to } : {}),
        ...(values.data !== undefined ? { data: values.data } : {}),
        ...(values.value !== undefined ? { value: values.value } : {}),
      },
      ...(values.description !== undefined ? { description: values.description } : {}),
    });
    writeSubmit(result, values.json === true);
    return;
  }

  throw new BankrError(`unknown command ${command}`, { code: "unknown_command" });
}

function parseChainId(raw: string | undefined, network: "mainnet" | "testnet"): number {
  if (raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new BankrError(`invalid --chain-id ${raw}`, { code: "invalid_chain_id" });
    return n;
  }
  return network === "testnet" ? ROBINHOOD_TESTNET.chainId : ROBINHOOD_MAINNET.chainId;
}

function writeSubmit(result: { transactionHash: string; status?: string; signer?: string; chainId?: number }, json: boolean) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.transactionHash}\n`);
  process.stderr.write(`status ${result.status ?? "unknown"} signer ${result.signer ?? "?"} chainId ${result.chainId ?? "?"}\n`);
}

function usage(): string {
  return `bankr-wallet — Bankr holds the keys; we store only BANKR_API_KEY.

Commands:
  address [--network mainnet|testnet] [--json]
      GET /wallet/me and print the Robinhood Chain EVM address
      (wallets[].address where chain is "evm").

  sign --message <text-or-0x-digest> [--json]
      POST /wallet/sign personal_sign. For a cc-submit-v1 payout proof,
      pass the 32-byte struct hash as 0x-prefixed hex.

  submit-create --data 0x<init> [--chain-id 4663|46630] [--json]
      POST /wallet/submit with no 'to' (CREATE). Read-write key.
      Bankr wallet security must allow arbitrary contract calls.

  submit [--to 0x…] [--data 0x…] [--value wei] [--chain-id N] [--json]
      POST /wallet/submit a call. Omit --to for CREATE.

Env:
  BANKR_API_KEY   bk_… from https://bankr.bot/api-keys  (required)
  BANKR_API_URL   default https://api.bankr.bot

Never pass an EVM private key. Do not run bankr login from this repo.
`;
}

main(process.argv).catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
