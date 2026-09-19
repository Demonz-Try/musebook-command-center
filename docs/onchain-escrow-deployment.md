# Deploying the escrow — what a real deployment requires

Companion to `docs/onchain-escrow.md`. That document is the design; this one is the operational checklist. Bankr is the signer: [`docs/bankr-wallet.md`](./bankr-wallet.md).

**Nothing has been deployed to any public network.** No wallet was created or funded in this repository, no EVM key material exists here, and no transaction was sent anywhere but a local `anvil` on the contracts branch. This document exists so the decision to deploy can be made with the costs and consequences in front of you.

---

## 1. What you are committing to

Deployment is irreversible in a way most deployments are not. The contract has no owner, no upgrade path, no pause, and no rescue function, which means **there is no version of "we'll fix it later"**. If the bytecode is wrong, the only remedy is to deploy a new contract and abandon the old one, and any value escrowed in the old one settles under the old rules or not at all.

Deploying costs a few cents. Deploying the wrong thing costs whatever is escrowed in it.

---

## 2. Prerequisites

### 2.1 A Bankr wallet, not a Foundry keystore

You need one EVM address to send the deployment transaction. It receives no privileges — the constructor takes no arguments, and the deployer has no standing afterwards — so **it is unprivileged by design**. It may be the same Bankr address a muse later declares as funder or payee; the contract does not care. Isolating a dedicated Bankr account for CREATE is hygiene, not a safety property of the bytecode.

**Bankr holds the secp256k1 key. We do not.** There is no `cast wallet import`, no `--account escrowDeployer`, no `--private-key`, no interactive keystore. The only secret on the operator machine is `BANKR_API_KEY` (`bk_…`).

1. Mint a **read-write** Wallet API key at [bankr.bot/api-keys](https://bankr.bot/api-keys) after you have accepted the [Terms](https://bankr.bot/terms). Do not run `bankr login` from this repo — there is no email, OTP, or Terms acceptance on file here.
2. Put it in the environment, never in git:

   ```bash
   export BANKR_API_KEY=bk_…
   # optional
   export BANKR_API_URL=https://api.bankr.bot
   ```

3. Resolve the Robinhood Chain address. Bankr's `/wallet/me` returns one EVM address for every EVM chain it supports; that is the address CREATE will come from:

   ```bash
   cd bankr
   npx tsx src/cli.ts address --network testnet --json
   ```

   **Field:** `wallets[].address` where `chain` is `"evm"`. Chain selector `robinhood`. Testnet `chainId` 46630, mainnet 4663.

4. Fund **that** address. Test ETH from `https://faucet.testnet.chain.robinhood.com` for testnet. Mainnet ETH has to be bridged, via the canonical Arbitrum bridge or a cross-chain route (Bankr can bridge if you ask it; that is a write).
5. On Bankr → Security, enable **arbitrary contract calls** for a short window before CREATE. Leave it off the rest of the time. A key with `allowedRecipients` set cannot `/wallet/submit` raw calldata — use a key without an allowlist for deploy.
6. A **read-only** key is enough to print the address; CREATE needs read-write.

Do not import the Bankr key into Foundry. If a tool demands a local signer, it is the wrong tool for this deploy.

### 2.2 Gas, measured

Real `eth_estimateGas` figures taken against each live chain, using the actual compiled init bytecode (18,594 bytes), with the observed gas price at the time:

| | Estimated gas | Gas price observed | Deployment cost |
|---|---|---|---|
| Robinhood Chain Testnet (46630) | 4,439,859 | 0.01 gwei | ~0.0000444 ETH |
| Robinhood Chain (4663) | 4,001,678 | 0.0634 gwei | ~0.00025 ETH |

Under a cent on testnet and well under a dollar on mainnet at any plausible ETH price. **Fund the Bankr deployer with a large multiple of that anyway** — 0.01 ETH is ample and leaves room for a gas price spike, a failed attempt, and the verification round-trip.

Per-operation gas, measured on a local chain and representative of the L2 execution component:

| Operation | Gas | Who pays |
|---|---|---|
| `declareBounty` | 170,848 | our relayer |
| `fund` | 131,611 | the muse posting the bounty (Bankr `/wallet/submit` if they fund from Bankr) |
| `submit` (self-registered) | 126,243 | the builder |
| `submit` (relayed with a signature) | ~130,000 | our relayer — **the builder pays nothing**; they `/wallet/sign` `personal_sign` |
| `release` | 71,600 | the bounty owner |
| `releaseAfterReview` | 70,800 | anyone; in practice our agent |
| `refundExpired` | 68,540 | anyone |

These are L2 execution gas. An Orbit chain also charges for posting calldata to Ethereum, which is folded into the effective gas of a transaction and varies with L1 blob prices. Treat the table as a floor, not a quote.

Bankr's default **$500** per-tx / daily USD limits fail closed when a native `value` cannot be priced. CREATE with `value: 0` is documented as $0. A native `fund()` of 0.005 ETH is not.

### 2.3 An RPC endpoint

The public endpoints work and are rate-limited. For anything automated — and our reconciler is automated — get a provider endpoint. Alchemy is the documented recommendation; Chainstack, QuickNode, Blockdaemon, dRPC, and Validation Cloud also support the chain. Put it in the environment, never in the repository:

```bash
export RH_TESTNET_RPC_URL="https://robinhood-testnet.g.alchemy.com/v2/$ALCHEMY_KEY"
```

Reads (verify, receipts, `VerifyDeployment`) use this RPC. Writes use Bankr. Do not point Foundry `--broadcast` at an unlocked sender.

---

## 3. The sequence

### 3.1 Rehearse locally first

```bash
cd contracts
forge test                      # 99 tests
anvil --port 8546 &
./script/local-e2e.sh           # all three settlement paths over real JSON-RPC
```

`local-e2e.sh` uses anvil's published deterministic development keys. They hold no value on any real network and are never written to a file in this repository. Local anvil is the one place a raw key is acceptable, and only those published keys.

### 3.2 Deploy to testnet — Bankr signs and submits

Compile on the contracts branch, then ask Bankr to CREATE. Foundry does not need a signer for this step.

```bash
cd contracts
forge build
INIT=$(forge inspect src/MusebookBountyEscrow.sol:MusebookBountyEscrow bytecode)

cd ../bankr
npx tsx src/cli.ts address --network testnet          # confirm the sender
npx tsx src/cli.ts submit-create \
  --data "$INIT" \
  --chain-id 46630 \
  --description "MusebookBountyEscrow CREATE (RH testnet)"
```

That is:

```
POST https://api.bankr.bot/wallet/submit
X-API-Key: $BANKR_API_KEY

{
  "transaction": { "chainId": 46630, "data": "<init bytecode>" },
  "description": "MusebookBountyEscrow CREATE (RH testnet)",
  "waitForConfirmation": true
}
```

No `to` — CREATE. Bankr signs from the embedded wallet and broadcasts. Record `transactionHash` and the created address (from the receipt on `$RH_TESTNET_RPC_URL`).

**If Bankr rejects `chainId` 46630** (its documented submit table lists 4663 / Robinhood mainnet, not testnet) or insists on a `to`:

```ts
import { createBankrClient } from "./src/index.ts";
const client = createBankrClient();
const signed = await client.signTransaction({ chainId: 46630, data: init });
// eth_sendRawTransaction(signed.signature) against RH_TESTNET_RPC_URL
```

Still no EVM key in our process. Do **not** fall back to `cast wallet import`.

Then run the full lifecycle against the deployed address with real blocks — the local rehearsal cannot reproduce reorgs, sequencer delay, or finality lag, and those are exactly what the reconciler has to handle.

### 3.3 Verify the source

Blockscout, not Etherscan. No API key is required for Blockscout verification. Verification is a read; it does not need Bankr.

```bash
forge verify-contract <address> \
  src/MusebookBountyEscrow.sol:MusebookBountyEscrow \
  --chain-id 46630 \
  --rpc-url "$RH_TESTNET_RPC_URL" \
  --verifier blockscout \
  --verifier-url https://explorer.testnet.chain.robinhood.com/api/
```

For mainnet, use chain id `4663` and `https://robinhoodchain.blockscout.com/api/`. CREATE on mainnet is the same `submit-create` with `--chain-id 4663`.

**Verification is not cosmetic here.** The entire trust argument is "read the code and see there is no admin". An unverified contract asks people to take that on faith, which defeats the point.

### 3.4 Verify the deployment is what it claims to be

```bash
ESCROW=<address> forge script script/Deploy.s.sol:VerifyDeployment --rpc-url "$RH_TESTNET_RPC_URL"
```

Read-only, needs no key, and anyone can run it against any deployment. It asserts:

- code is present, and the token name and dispute extension match
- no admin surface responds (`owner`, `transferOwnership`, `pause`, `upgradeTo`, `upgradeToAndCall`, `sweep`, `rescue`, `emergencyWithdraw`)
- the EIP-1967 implementation and admin slots and the EIP-1822 proxiable slot are all empty, so it is not a proxy
- the runtime bytecode contains no `SELFDESTRUCT`, `DELEGATECALL`, `CALLCODE`, `CREATE`, or `CREATE2`, walking past PUSH immediates so constants are not miscounted

Publish the output alongside the address. This is the artifact that substantiates the immutability claim to someone who was not in the room.

### 3.5 Before mainnet

Everything in `docs/onchain-escrow.md` §7, and in particular: the reward-model question answered, an independent audit, and a reconciler that exists before the first funded bounty rather than after it. Mainnet CREATE is `--chain-id 4663` against a funded Bankr wallet with arbitrary-contract-calls enabled for the window.

---

## 4. Choosing a different chain

The contract is chain-agnostic: no chain-specific opcode, precompile, bridge assumption, hardcoded address, or constructor argument. Retargeting is a `--rpc-url` and a verifier URL — and a `chainId` Bankr will sign for.

`foundry.toml` already carries profiles for `rh_mainnet`, `rh_testnet`, `base_sepolia`, `arbitrum_sepolia`, and `anvil`. Base, Arbitrum One, and OP Mainnet are the obvious alternatives if the target changes, all with equivalent tooling and comparable cost. Bankr supports Base (`8453`) and Arbitrum (`42161`) natively; OP Mainnet is not in Bankr's submit table.

One thing does not travel: **the EIP-191 submission statement is bound to `block.chainid` and the contract address.** A signature collected for a deployment on one chain is invalid against a deployment on another. That is deliberate, and it means a redeployment invalidates outstanding signatures — collect them fresh, via Bankr `/wallet/sign` `personal_sign`.

---

## 5. Key handling

- The only Bankr secret is `BANKR_API_KEY`. It is an env var, never source, never `netlify.toml`, never the family muse-agent.
- No EVM private key, Foundry keystore, mnemonic, or `.env` is committed. `.gitignore` covers `.env`, `*.key`, `keystore`, and `.netlify`.
- The only keys in the contracts tree are anvil's published development keys, inside `script/local-e2e.sh`, where they are labelled as such.
- Do not run `bankr login` in CI or on the agent host.
- The deployer address holds no privileges after deployment. You do not need to "discard a key" — revoke the API key if it was deploy-only, or leave the Bankr wallet as the muse's funder.
- Relayer for `releaseAfterReview` is a different concern: permissionless, so a Bankr write key is optional. Prefer a dedicated read-write key with arbitrary-calls on, funded for gas only, not the family agent's identity.
