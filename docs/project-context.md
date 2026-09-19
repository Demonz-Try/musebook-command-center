# Musebook Command Center — Project Context

Durable record of what we're building and what has been decided. Status and in-flight work live in `notes.md`; this file is the part that shouldn't need re-deriving.

## What we're building

A third-party command center for musebook: the site where musebook commands are executed, receipts are kept, and third parties can build their own commands. The escrow bounty board from the original spec is the **first command module**, not the whole product.

Doctrine from the spec, unchanged: don't trust the muse, don't trust the human, trust the contract. Keep the receipts. Funds move only on owner agreement, council vote, or deadline refund — never on an operator's whim.

## Decisions made

| Decision | Choice | Why |
| --- | --- | --- |
| Deploy target | Netlify | Workspace standard; user confirmed over the spec's Vercel |
| Storage | Not a JSON file | Netlify serverless has no writable persistent filesystem; Blobs vs Database decision pending from the ops worker |
| Deadline checker | Netlify scheduled function | Netlify equivalent of the spec's Vercel cron |
| Command addressing | `@mention`-addressed, pipe-delimited args | Slash commands have zero platform support and zero existing usage; mentions get native inbox routing |
| Identity model | One muse per command family | Per-family keypair, credentials, rate limits, and revocation scope |
| Ingest transport | Polling is authoritative, WebSocket is an accelerator | The socket has no replay, no resume offset, no message ids, and misses eight channels |
| Public posting | Blocked pending user approval | Registering is free, but a muse identity is permanent and public on a live board |

## Hard platform constraints

These are verified against the live platform, not inferred. Full evidence in `docs/musebook-api-findings.md`.

- **Authoritative protocol**: `https://musebook.lol/muse.txt`. It has drifted from the implementation, so live responses are authoritative for response shape.
- **No backfill.** Once posts pass the 100-post window, no endpoint can list them again. `latest.json` takes `limit` only; every pagination parameter is silently ignored. Recovery is id-probing `thread.json` on globally sequential ids, advancing a persisted watermark only after the gap closes.
- **`thread.json` returns reproducible permanent 500s** on roughly 5% of ids — the same endpoint backfill depends on. Skip-and-record; never retry forever.
- **The mention inbox truncates to 200 characters.** A mention is a notification; the full post must be fetched before parsing.
- **Post authorship cannot be verified.** All 930 muses' public keys are public, but posts carry no signature — only an `id_verified` boolean.
- **Display names are not unique and not protected.** 765 distinct names across 930 muses, 92 shared. Our handles can be squatted after registration with no recourse. Resolve by `muse_id` only; handles must be single-word.
- **40 keyless `anon:<slug>` identities** have `public_key: null` and name-collide with real muses. Never treat one as an authenticatable counterparty.
- **No bounty or payment primitive exists on musebook.** The ecosystem convention is musebook as discovery and receipts, with state and money external — which is our position.
- **Commands fail silently for their author**, so visible acknowledgement — including on rejection — is mandatory.

## Product risk to keep in view

Nobody posts slash commands on musebook, and the command convention is ours to introduce. Adoption has to be bootstrapped; the design cannot assume users arrive already knowing the grammar.

## Phase discipline (from the spec)

1. Manual — a human routes commands, holds escrow, posts receipts.
2. Board site + API + deadline checker. Router and escrow still manual. **Current phase.**
3. Watcher service replaces the human router.
4. On-chain conditional-release escrow; manual holding retired.

## Infrastructure notes

- Repo: `andreas-demoz/musebook_command` (private). Workers commit to their own branches and open draft PRs.
- The project store is not shared across worker machines. Git is the shared channel; hand workers branch names and URLs, never store paths.
