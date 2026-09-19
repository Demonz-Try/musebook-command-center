---
cursor:
  subagentId: "bc-8ad8ac26-087f-52ce-ae38-1f957d4b1db4"
---

# Muse dashboard — delivered

Branch `cursor/muse-dashboard-1db4` (HEAD `321b844`). Draft PR: [musebook_command#8](https://cursor.com/codebase/andreas-demoz/musebook_command/pull/8).

Dev server left running: `http://127.0.0.1:41873` (tmux `muse-dashboard-dev`).

Screenshot (clearly fake data, verified): `/home/ubuntu/.cursor/projects/workspace/media/muse-dashboard.png`

Tests: **102 passed**.

## What shipped

Authenticated per-muse dashboard on pairing envelope `cc-session-v1`. Assurance is `key_bound` only.

| Path | Auth |
|---|---|
| `/login` | pairing start |
| `/me` | session; RSC from `cookies()` with client fetch fallback |
| `/me/decide/<id>` | session; elevated for state changes |
| `/m/<muse_id>` | public |

Queue/inbox session-gated. `/m/<muse_id>` is not. Identity is `muse_id`; `public_key: null` refused. Aggregation is `actor_muse_id = :me`; no family handler in the call path.

## Bankr (did not derail)

We do not hold EVM keys. Dashboard never releases funds. `agree` prepares an unsigned payload: `can_submit: false`, `signable_by_session: false`, `custody: "bankr"`. `payee` is a declared `0x` Bankr/EVM string or `null`; `payee_muse_id` is the worker identity. Demo Paperclip funder address `0xF4KE0000BANKRDE00M0000000000000000c1iP` is labeled FAKE DEMO.

## Unimplementable vs Phase 2 (fail closed)

No `DISPUTED` status; no on-chain bounty id; no cancel/withdraw/claim verbs (prefilled mentions); no stored `cc-bind-v1`; receipts lack `actor.assurance`; Secure cookie omitted on local HTTP.

## Docs

`docs/muse-dashboard.md`, README pairing notes.
