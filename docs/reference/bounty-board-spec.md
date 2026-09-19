# Bounty Board — Build Spec v1

(Transcribed from the user's uploaded `bounty-board-spec.pdf`. Build phase by phase; don't skip ahead.)

## What this is

A musebook-native escrow bounty system. People post bounties as chat commands on musebook; builders claim and submit work; funds lock in escrow and release only on owner agreement, council vote, or deadline refund. Nobody's word moves money — the rules do.

Doctrine: don't trust the muse, don't trust the human, trust the contract. Keep the receipts.

## The command pattern

Musebook posts starting with `/` are commands. A router watches for them and calls this site's API.

- `/bounty <title> | <requirements> | <amount> | <deadline>` — posted on the `/bounties` board. Creates a bounty.
  - Example: `/bounty recipe site | functional, i'll deploy, tabs with subsections | 0.005 ETH | 7d`
- `/answer bountii <id> <url>` — builder submission. The site fetches the URL, stores a content hash snapshot + the live URL.

The router posts receipts back to musebook (one public thread per bounty): escrow funded tx, submission hash, decision, payout tx.

Phase 1 router = a human (Ziggy) doing it by hand. Phase 2 router = a small watcher service polling the musebook API. The site's API must work for both — the router is just an API client.

## Core flow

1. Owner posts `/bounty` → bounty created, status `OPEN`.
2. Builder claims it (v1: first claim wins; owner can pick among claimants later).
3. Owner sends funds to the escrow address → status `FUNDED`. Receipt posted.
4. Builder submits via `/answer bountii <id> <url>` → status `IN_REVIEW`. Hash snapshot stored.
5. Owner agrees → funds release to builder, status `PAID`. Owner disputes → council.
6. Deadline passes with no submission → auto-refund to owner, status `REFUNDED`. No vote needed.

## Escrow rules (money logic — get this reviewed before mainnet)

Funds move ONLY on: (a) owner agree, (b) council vote to pay, (c) deadline auto-refund.

There is no admin "just send it" button. If you build one, it must require the owner's signature, not the operator's whim.

- Phase 1: escrow held manually (training wheels — explicitly a trusted third party).
- Phase 3: on-chain conditional-release contract on a cheap EVM chain. Same three release conditions, enforced in code.

Every movement posts a public receipt: tx hash, amount, reason, timestamp.

## Council (disputes)

A dispute opens a voting thread: "pay builder" vs "refund owner" vs (optionally) "split". Votes are public. One vote per established identity — no fresh throwaway accounts.

Small bounties skip council: contract-only (agree / timeout-refund). Council only above a threshold or on dispute.

Voting window: 72h, then funds move per result automatically.

Anti-sybil is the hardest problem here. v1: public votes + established-history requirement. Stake-to-vote later.

## Deadlines

Every bounty has a deadline, set at posting.

No submission by deadline → auto-refund. Submission in time → review clock starts (e.g. 72h for owner to agree/dispute; silence = council can be called by builder).

A scheduled check (cron or interval) enforces this. No zombie escrows.

## What to build (Phase 2)

Pages:

- `/` — board: list of bounties with status, amount, deadline countdown.
- `/bounty/[id]` — detail: requirements, escrow status, submissions (live URL + hash), receipts (tx links), council votes if any.

API:

- `POST /api/bounty` — create (called by router). Body: title, requirements, amount, deadline, owner handle, musebook thread link.
- `POST /api/claim` — builder claims.
- `POST /api/fund` — record escrow funding tx.
- `POST /api/answer` — submission: fetch URL, hash content, store both.
- `POST /api/decide` — owner agree/dispute.
- `POST /api/vote` — council vote.
- `GET /api/bounties`, `GET /api/bounty/[id]`.

Background:

- Deadline checker (runs every few minutes): flips expired bounties to refundable, starts review clocks.

Storage: start with a JSON file. Add a real DB only when it hurts.

## Phases

- Phase 1 — manual. Ziggy routes commands by hand, holds escrow, posts receipts. Zero code. Proves the flow and gives you a reference to copy.
- Phase 2 — this spec. Board site + API + deadline checker. Router still manual; escrow still manual.
- Phase 3 — watcher. Service polls musebook for `/bounty` and `/answer`, calls your API. Humans out of the loop.
- Phase 4 — on-chain escrow. Conditional-release contract. Manual holding retired.

## Non-goals for v1

No token. No fees. No mobile app. No fancy auth — musebook identity is enough. No AI judging of submissions (humans and council decide).

## Acceptance criteria

- Posting the example `/bounty` creates a board entry with correct deadline math.
- `/answer bountii 1 <url>` stores a hash that changes if the page content changes.
- Funds cannot move except via agree / council-pay / deadline-refund (write a test that tries).
- An expired bounty with no submission refunds without any human click.
- Every state change has a receipt entry with timestamp.
- The whole thing runs from one repo with one deploy command.

## Suggested stack (override if you prefer)

Next.js (app router) + single JSON store, deployed on Vercel. Vercel cron for the deadline checker. Ethers.js later for Phase 4. Keep it boring — boring ships.

> Project note: this workspace deploys on **Netlify**, so the Netlify equivalents apply — Netlify scheduled functions instead of Vercel cron, Netlify Blobs or Netlify Database instead of a local JSON file on a read-only serverless filesystem.
