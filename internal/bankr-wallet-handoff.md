---
cursor:
  subagentId: "bc-6964bc75-f884-5e25-8d7f-edb7a4b10a89"
---

# Bankr wallet — delivered

Branch `cursor/bankr-wallet-integration-0a89` pushed to `https://origin.cursor.com/git/andreas-demoz/tmp-d32f3fcc676646da.git`.

Did not run `bankr login`. Did not generate or commit an EVM key. Live Bankr was not called (no `bk_…` key). HTTP is mocked in tests (13 passing).

## Exact lookup

| | |
|---|---|
| Env var | **`BANKR_API_KEY`** (`bk_…`, header `X-API-Key`) |
| Optional | `BANKR_API_URL` (default `https://api.bankr.bot`) |
| Robinhood address field | **`wallets[].address` where `chain === "evm"`** on `GET /wallet/me` |
| Selector | `robinhood` |
| Chain ids | mainnet **4663**, testnet **46630** (same 0x; Bankr submit docs list 4663 only) |

## Files

User-facing: `docs/bankr-wallet.md`, `docs/onchain-escrow-deployment.md` (deploy via `/wallet/submit` CREATE, not `cast wallet import`), `README.md`.

Helper: `bankr/` (`createBankrClient`, `getRobinhoodAddress`, `signPayoutProof` / `personal_sign`, `submit` / `submitCreate`). Thin muse adapter `bankr/src/muse.ts` (`declaredFunderAddress`). `muse-agent/` and `contracts/` untouched.

## Key placement

Read-write `BANKR_API_KEY` must not live on the family muse-agent. Lookup can be read-only. Deploy needs read-write + arbitrary contract calls on, no `allowedRecipients`.
