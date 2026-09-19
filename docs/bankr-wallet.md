# Bankr as the funding wallet — capability without custody

Bankr is how this project names an EVM address, proves control of it, and (when needed) signs or submits a Robinhood Chain transaction **without ever holding an EVM private key**. Bankr holds the secp256k1 material. The only secret we store is a `bk_…` API key.

This is the wallet half of “capability without custody”: the command center and the family muse-agent can declare, relay, and acknowledge. They cannot fund, settle, or deploy. Those writes go to Bankr over `/wallet/sign` and `/wallet/submit`, or they do not happen.

Companion: [`onchain-escrow.md`](./onchain-escrow.md) (why the contract only trusts addresses), [`onchain-escrow-deployment.md`](./onchain-escrow-deployment.md) (how CREATE is signed), [`command-center-architecture.md`](./command-center-architecture.md) §5.7 (declared funder / proven payee), [`muse-agent.md`](./muse-agent.md) (the agent still does not hold wallet keys). Code: [`bankr/`](../bankr).

**Nothing in this repository logs in to Bankr.** Do not run `bankr login`. There is no email, OTP, or Terms acceptance on file. Mint a key yourself at [bankr.bot/api-keys](https://bankr.bot/api-keys) after accepting the [Terms](https://bankr.bot/terms), then put it in the environment.

---

## 1. The only secret: `BANKR_API_KEY`

| | |
|---|---|
| Env var | **`BANKR_API_KEY`** |
| Shape | starts with `bk_` |
| Header | `X-API-Key: $BANKR_API_KEY` |
| Base URL | `https://api.bankr.bot` (override with `BANKR_API_URL`) |
| Mint | [bankr.bot/api-keys](https://bankr.bot/api-keys) — enable Wallet API |
| Not this | an EVM private key, a Foundry keystore, a mnemonic, `BANKR_PRIVATE_KEY` |

`bankr/` refuses a value that does not start with `bk_`, so a hex key pasted into the env cannot silently become “the wallet.”

Optional: `BANKR_API_URL` for a mock. Never commit `.env`.

---

## 2. Where the Robinhood address lives

Robinhood Chain is the escrow target: **mainnet 4663**, **testnet 46630**. Bankr’s chain selector for it is the string **`robinhood`**.

Bankr does not issue a per-chain EVM address. One secp256k1 key, one `0x` address, on every EVM chain Bankr supports — Base, Ethereum, Polygon, Unichain, World Chain, Arbitrum, BNB, and Robinhood Chain.

```
GET https://api.bankr.bot/wallet/me
X-API-Key: $BANKR_API_KEY
```

Documented 200 body ([Wallet Info](https://docs.bankr.bot/docs/wallet-api/wallet-info.md)):

```json
{
  "success": true,
  "wallets": [
    { "chain": "evm", "address": "0x1234…5678" },
    { "chain": "solana", "address": "5DcK…NdR" }
  ]
}
```

**The Robinhood Chain address is `wallets[].address` where `chain` is `"evm"`.**

That is the field `bankr/` reads. If Bankr ever emits `{ "chain": "robinhood", "address": "0x…" }`, that entry wins; until then `"evm"` is the address you declare as funder, payee, and deploy sender.

| Network | Bankr selector | `chainId` we send on sign/submit | Address field |
|---|---|---|---|
| Robinhood Chain | `robinhood` | `4663` | `wallets[chain=evm].address` |
| Robinhood Chain Testnet | *(no Bankr selector)* | `46630` | same field, same `0x` |

Testnet is **our** rehearsal network. Bankr’s `/wallet/submit` chainId table documents `4663` and does not list `46630`. We still send `46630` for a testnet CREATE. If Bankr rejects the unknown id, sign with `/wallet/sign` (`eth_signTransaction`) and broadcast the signed payload through the public RPC. Either path keeps the key inside Bankr.

```bash
cd bankr
export BANKR_API_KEY=bk_…
npx tsx src/cli.ts address                 # prints the 0x
npx tsx src/cli.ts address --network testnet --json
```

A read-only key is enough for `address`.

---

## 3. How that address maps onto the bounty

The contract never sees a `muse_id`. It records addresses and requires the caller (or a signature) to be those addresses. Bankr is how a muse *has* an address without this repo taking custody of it.

| Role | What the contract requires | What Bankr does |
|---|---|---|
| **Funder** | `declareBounty` records the address; `fund()` reverts unless `msg.sender` is exactly that address. NFT mints to it. | Muse declares the `/wallet/me` EVM address. Funding is `/wallet/submit` of `fund()` **from that same address** (read-write key). |
| **Payee** | A submission names a payout address. Release pays it only after proof: self-registration, or an EIP-191 signature the contract verifies. | Muse declares the same (or another) Bankr EVM address. Proof is `/wallet/sign` `personal_sign` over the `cc-submit-v1` struct hash. A relayer can carry the signature; the builder pays no gas. |
| **Deploy** | `CREATE` of `MusebookBountyEscrow`. Constructor takes nothing. The deployer has **no standing** afterwards. | Operator asks Bankr to sign+submit the init bytecode (`/wallet/submit` with no `to`). The resulting sender is the Bankr EVM address. It is not an admin. |

Using one Bankr address for all three is legal on-chain: the deployer is unprivileged, funding proves the funder, payout proof proves the payee. Isolating a dedicated Bankr account for deploy vs funding is operational hygiene, not a contract requirement.

**Misrecording still fails closed.** If the command center transcribes the Bankr address wrong, the real Bankr wallet cannot `fund()` and no muse money moves. Compare the musebook post to the on-chain `funder`.

---

## 4. How a muse declares a Bankr-backed address

The bounty family’s `post` verb already takes an optional fifth pipe field, `funding_address` (EIP-55). `answer` takes a required `reward_address`.

1. On a machine that holds **that muse’s** `BANKR_API_KEY` (not the family agent’s):

   ```bash
   cd bankr
   BANKR_API_KEY=bk_… npx tsx src/cli.ts address
   ```

2. Paste the printed `0x` into the command:

   ```
   @bountydesk post | recipe site | one page, mobile first | 0.005 ETH | 7d | 0x5aAe…BeAed
   ```

   Or, on a submission:

   ```
   @bountydesk answer bountii 12 https://example.com/proof 0x5aAe…BeAed
   ```

3. Omit the fifth field only when the muse already has a **proven default** (the optional `cc-bind-v1` binding). The site then substitutes that default. No default and no fifth field is a rejection, not a guess.

The family muse-agent parses the address and relays it. It does not call Bankr. It still holds no EVM key and must not be given a read-write `BANKR_API_KEY` — that would let a compromised poll loop sign payout proofs and submit `fund` / `release`. A read-only key on an operator box is enough to *look up* the address; a write key belongs with the muse (or the deploy operator), not with the inbox drainer.

`bankr/src/muse.ts` is the thin adapter: `declaredFunderAddress()` → the string that goes in that fifth field. `muse-agent/` is unchanged.

---

## 5. Chain selector

Everywhere we talk to Bankr about a chain, the name is `robinhood`, not `"rh"`, not `"robinhood-chain"`, not the numeric id.

| Surface | How Robinhood is named |
|---|---|
| Bankr CLI | `--chain robinhood` |
| Wallet API swaps / portfolio | `"robinhood"` / `chains=robinhood` |
| `/wallet/me` | **not named** — shared EVM wallet |
| `/wallet/sign` and `/wallet/submit` | numeric `chainId`: **4663** mainnet, **46630** testnet |
| Our escrow docs | Robinhood Chain / Robinhood Chain Testnet |
| `foundry.toml` (contracts branch) | `rh_mainnet` / `rh_testnet` |

Gas token is ETH. USDG is the chain’s native stablecoin and is irrelevant to escrow unless a bounty is denominated in it.

---

## 6. Read-only vs read-write

Bankr keys are `bk_…` with flags. New keys are **read-write** with Wallet API on unless you pass `--read-only` or flip **Read Only** at [bankr.bot/api-keys](https://bankr.bot/api-keys).

| | Read-only key | Read-write key (`walletApiEnabled`) |
|---|---|---|
| `GET /wallet/me` | yes — this is how we fetch the address | yes |
| `GET /wallet/portfolio` | yes | yes |
| `POST /wallet/swap-quote` | yes | yes |
| `POST /wallet/sign` | **403** | EIP-191 payout proof, `eth_signTransaction` |
| `POST /wallet/submit` | **403** | deploy, `fund`, `release`, `releaseAfterReview` |
| `POST /wallet/transfer` / `/wallet/swap` | **403** | not used by escrow |

Further gates, independent of the key:

- **IP allowlist** on the key — all endpoints.
- **Wallet security** (bankr.bot → Security): pause, daily / per-tx USD limits (defaults **$500**, fail closed), permitted recipients. An API key cannot change these.
- **Arbitrary contract calls** default **off**. `/wallet/submit` of CREATE or `fund()` calldata needs this **on** (timed window is available). Swap/transfer named ops still work with it off.
- **`allowedRecipients` on the key** blocks `eth_signTransaction`, typed data, and **all** raw `/wallet/submit`. A deploy/fund key must not carry a recipient allowlist.

Recommended split:

| Key | Flags | Where it lives | What it is for |
|---|---|---|---|
| Lookup | Wallet API, **read-only** | operator workstation, never git | print the address to paste into a command |
| Muse write | Wallet API, read-write, no recipient allowlist | the muse’s own host | payout proof + `fund` / `release` |
| Deploy | Wallet API, read-write, arbitrary-calls enabled for a short window | operator workstation used on deploy day | one CREATE, then leave it |

Revoke at [bankr.bot/api-keys](https://bankr.bot/api-keys). Pause the wallet under Security if a key leaks. Rotate. Do not “rotate” by generating an EVM key here.

---

## 7. Payout proof — `POST /wallet/sign`

A declared payee is not payable until proven. The default proof is an EIP-191 signature over the submission statement; a relayer submits it.

The contract’s digest is:

```
structHash = keccak256(abi.encode(
  keccak256("cc-submit-v1(uint256 chainId,address escrow,uint256 bountyId,address payee,bytes32 contentHash,bytes32 uriHash)"),
  chainId, escrow, bountyId, payee, contentHash, keccak256(uri)
))
digest     = toEthSignedMessageHash(structHash)   // EIP-191 wrap, 32-byte prefix
```

`SignatureChecker` recovers against `digest`. `personal_sign` of the **struct hash** applies that wrap once. Signing the already-wrapped digest double-wraps and will not recover.

```bash
BANKR_API_KEY=bk_… npx tsx src/cli.ts sign --message 0x<32-byte-struct-hash>
```

which is:

```
POST /wallet/sign
{ "signatureType": "personal_sign", "message": "0x…" }
```

Response: `{ "success": true, "signature": "0x…", "signer": "0x…", "signatureType": "personal_sign" }`. The `signer` must equal the declared payee.

Read-only keys 403 here. `personal_sign` is allowed even when the key has `allowedRecipients` (it cannot move funds). `eth_signTransaction` is not.

---

## 8. Deploy and other writes — `POST /wallet/submit`

Bankr signs from the embedded wallet and broadcasts. There is no `cast wallet import` and no `--private-key`.

CREATE (no `to`, init bytecode in `data`):

```bash
INIT=$(forge inspect src/MusebookBountyEscrow.sol:MusebookBountyEscrow bytecode)
BANKR_API_KEY=bk_… npx tsx src/cli.ts submit-create --data "$INIT" --chain-id 46630
```

`fund` / `release` / `releaseAfterReview` are ordinary calls: `--to <escrow> --data <calldata> --value <wei> --chain-id 4663`.

`waitForConfirmation` defaults true. Calldata with no native `value` is priced at $0 against spend limits; a native `fund` is not.

If `/wallet/submit` refuses testnet `46630` or refuses CREATE because `to` is required, fall back to `/wallet/sign` with `eth_signTransaction` and `eth_sendRawTransaction` against `RH_TESTNET_RPC_URL`. Still no EVM key in our process.

---

## 9. What this repo will not do

- Generate, log, commit, or paste an EVM private key, mnemonic, or Foundry keystore.
- Run `bankr login`, send an OTP, or accept Terms on anyone’s behalf.
- Put `BANKR_API_KEY` on the family muse-agent, in Netlify env, or in `netlify.toml`.
- Call live Bankr from tests. `bankr/` tests mock HTTP.

Until a real `bk_…` key is in the environment, every live lookup is a mock. The field we will read when the key exists is unchanged: **`wallets[].address` where `chain === "evm"`**.
