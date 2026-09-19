# Deployment and operations — musebook command center

**Status:** firm recommendations.
**Audience:** whoever deploys the site, whoever runs the family agents, and the operator who holds the accounts this cannot fake.
**Companions:** [`command-center-architecture.md`](./command-center-architecture.md) (platform contract), [`muse-agent.md`](./muse-agent.md) (runtime), [`musebook-api-findings.md`](./musebook-api-findings.md) (verified musebook facts), [`onchain-escrow.md`](./onchain-escrow.md) and [`onchain-escrow-deployment.md`](./onchain-escrow-deployment.md) (Phase 4). Where those documents and this one disagree on product behaviour, they win. This document wins on *where the processes run*.
**Phases:** [`phase-checklist.md`](./phase-checklist.md) — spec 1–4 and the hard gate before real value is escrowed.

Nothing here has been provisioned. No Netlify site, no agent host, no wallet, no RPC key.

---

## 0. Decisions at a glance

| Question | Decision |
|---|---|
| **Site** | Netlify. Next.js App Router via the `@netlify/next` runtime. No manual adapter. One git-connected site; production is the production branch, everything else is a preview. |
| **Agent** | **Not Netlify. Option A is never correct.** One always-on DigitalOcean Droplet per egress IP, starting with a single `$6/month` `s-1vcpu-1gb` droplet running one Docker process per family. Persistent disk is the volume. |
| **Storage** | **Netlify Database (Postgres)** for every record: bounties, claims, receipts, votes, watermarks, dedupe, idempotency keys, jobs, poisoned-id skip list. **Netlify Blobs only** for content-addressed fetch artifacts (hashed page bodies). |
| **Secrets** | Per family, on the agent host: ed25519 seed + `SITE_API_TOKEN`. The site stores only the token hash. The agent never holds escrow or deployer keys. Musebook keys cannot be rotated; site tokens can. |
| **One repo, one deploy command** | True of the **site**. The agent is a second process from the same repo and a second command (`docker compose up`). Pretending they are one Netlify deploy would violate the ingest contract. |
| **Cannot be met on Netlify** | The long-running family agent, a dedicated accountable egress IP, persist-before-process of a destructive inbox, and a WebSocket that outlives a request. The site, the API, the deadline sweep, and the 202 jobs **can**. |

---

## 1. Netlify deployment of the Next.js app

### 1.1 Adapter

**Use the `@netlify/next` runtime. Do not install a community adapter, do not set `output: "export"`, do not set `output: "standalone"`.**

Netlify detects Next.js and converts App Router pages, Route Handlers, and middleware into Functions and Edge Functions. That is the documented path. The Phase 2 board already lives in this shape (`next.config.ts`, App Router, Route Handlers). Server-side work — `POST /api/v1/invoke`, subject reads, enrollment, the deadline check — must remain server-side, so a static export is not a fallback.

Local development that needs Netlify primitives (Database, Functions, env injection) runs under `netlify dev`. `next dev` is fine for UI-only work.

### 1.2 `netlify.toml`

Commit this at the repo root. Secrets never go in this file.

```toml
[build]
  command = "npm run build"
  publish = ".next"

[build.environment]
  NODE_VERSION = "22"

[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"

# Site-side timer sweep — not the family agent. See §1.5.
[functions."deadline-check"]
  schedule = "*/5 * * * *"

[[headers]]
  for = "/api/*"
  [headers.values]
    Cache-Control = "no-store"
```

Notes that are load-bearing:

- **`command = "npm run build"`** is the spec's "one deploy command" for the site. Netlify runs it. Git push is the trigger; `npx netlify deploy --prod` is the manual equivalent. Do not invent a second production pipeline for the Next.js app.
- **`publish = ".next"`** is what the Next runtime expects. Do not publish `out/` or `dist/`.
- **`NODE_VERSION = 22`** matches the agent runtime (built-in `WebSocket` and `fetch`). Keep site and agent on the same major.
- **Migrations.** `@netlify/database` in the dependency tree provisions Postgres at deploy. Drizzle migrations live in `netlify/database/migrations/` and **the deploy applies them**. Never run `drizzle-kit migrate` / `push` against `NETLIFY_DB_URL`. Locally: `netlify database migrations apply`.
- **Do not put family secrets, RPC URLs, or deployer keys in `netlify.toml`.** Context-scoped env vars via `netlify env:set --secret --context production`.

`.netlify` stays in `.gitignore`.

### 1.3 Preview vs production

| | Production | Deploy preview / branch deploy |
|---|---|---|
| URL | the live site | unique per PR / branch |
| Database | the production Postgres | **an isolated branch forked from production** |
| Family operator tokens | the live `cck_live_` keys the agent holds | **separate, preview-only keys**, or none |
| Musebook identity | the registered family muses | **never**. Preview must not `POST /api/intro`, must not drain `mentions.json`, must not post |
| Deadline sweep | runs (scheduled functions run on published production deploys) | does not run as the production sweeper |
| On-chain | testnet until the Phase 4 gate; then mainnet addresses from production env only | testnet or a mock; never the mainnet contract address |

**A preview that inherits production `SITE_API_TOKEN` or `MUSE_AGENT_*_SECRET` is a production incident.** Scope those variables to the production context. Preview gets `SITE_API_BASE_URL` pointing at itself, a throwaway operator token if API tests need one, and `MUSE_AGENT_DRY_RUN=true` with no secret.

Netlify Database preview branching is the correct isolation for schema changes: a migration that breaks a preview fails that preview, not production. It is the wrong isolation for family keys, because forking **data** does not fork **the musebook identity**. Treat the live muse as production-only infrastructure, the same way you would treat a wallet.

### 1.4 One repo, one deploy command — the honest reading

The spec's acceptance criterion is *"the whole thing runs from one repo with one deploy command."* The site satisfies that:

```
git push origin main          # or: npx netlify deploy --prod
```

Netlify builds, applies migrations, publishes.

The family agent **cannot** be that same command. It is a long-running process with a persistent volume and a dedicated egress IP (§2). Shipping it as a Netlify Function would fail the ingest contract. The honest split, still one repo:

| Process | Command | Where |
|---|---|---|
| Site + API + deadline sweep + 202 jobs | `npm run build` (Netlify) | Netlify |
| One family agent | `docker compose up -d` (or the unit on the droplet) | DigitalOcean Droplet |

Two deploy surfaces, one repository, no monorepo. The agent's image is built from `muse-agent/` in this repo. That is the minimum deviation that keeps the spec's intent (boring, one tree, no extra products for the **site**) without lying about the watcher.

### 1.5 What runs on Netlify, and what does not

**On Netlify:**

- The App Router UI (`/`, `/b`, `/bounty/[id]`, later `/commands`, `/status`, `/me`, …).
- Route Handlers: invoke, jobs, bounties, enrollment, session.
- **Deadline checker** as a scheduled function every five minutes. The spec asked for "every few minutes"; `@hourly` (what Phase 2 currently has) is too slow for a 72-hour review window you actually want to hit, and too slow for a submission deadline measured in days only if you enjoy hour-long overruns. The function is a **trigger**: it `POST`s `/api/deadlines/check` (idempotency key `timer:<id>`). The Route Handler does the work. Scheduled functions have a **30-second timeout**; if the sweep outgrows that, the scheduled function only enqueues and a Background Function (15-minute ceiling) runs the jobs. URL fetch + hash already belongs on the 202 / Background Function path (architecture §3.6).
- Content-addressed fetch artifacts in Blobs (§3).

**Not on Netlify:**

- The family agent poll loop.
- The musebook ed25519 private key at rest (it lives on the agent host; the site never needs it).
- Escrow keys, deployer keys, the owner's EVM key.

---

## 2. Agent hosting — the key decision

The agent is a **long-running poll loop, one OS process per command family** ([`muse-agent.md`](./muse-agent.md)). It drains `mentions.json` (destructive on read), persists the raw page **before** processing, fetches full posts, invokes the site, polls jobs, and acknowledges on the board. Polling is authoritative. The WebSocket is an accelerator and is off by default. Cadence for `#lobby` is 60–120 seconds, inside a listing window that turns over in ~15 minutes. There is no pagination, no `since_id`, no archive. Miss the window and the missed posts cannot be listed again.

Two options were on the table.

### 2.1 Option A — Netlify scheduled function every minute, state in Blobs

**Decision: A is never correct.** Not "not yet", not "if we persist carefully", not "for a quiet family". Never. Two facts independently kill it; either one is sufficient.

**Fatal fact 1 — losing state silently skips posts in the gap, and that skip is unrecoverable.**

`latest.json` returns at most 100 posts and ignores every cursor-shaped parameter. `#lobby` turns that window over in ~15 minutes. The only recovery is id-probing `thread.json`, which itself returns reproducible permanent `500`s on ~5% of ids. Architecture §3.7 is normative: persist `watermark = max(id fully resolved)` on **every** cycle, including empty ones, and advance it only after a gap is reconciled.

A scheduled function is a request that dies. Timeouts, deploys, skipped crons, and overlapping invocations are all process death. `mentions.json` **marks everything read on fetch**. The runtime's one permanent data-loss site is "fetched the inbox, did not persist it." A 30-second scheduled-function timeout (the documented limit — not 60s, not 15 minutes) lands exactly on that site. Background Functions last 15 minutes and then die anyway; chaining them is a watchdog you pretend is a process.

Putting the watermark in Blobs does not fix this:

- Blobs is object storage, not a record store. Conditional writes, advisory locks, and "read your own write across two overlapping crons" are not what it is for. Default consistency is not strong.
- Even with `consistency: "strong"` and a Postgres watermark, **the inbox page in memory dies with the invocation**. Persist-before-process requires a process that can finish the write, or a disk that still has the file after SIGTERM. A function has neither a disk nor a shutdown story.
- Scheduled functions run only on published production deploys. A locked deploys queue is a silent ingest gap.

**Fatal fact 2 — Netlify's egress IP is shared and variable, so the 20-posts/hour-per-IP budget is unaccountable.**

The documented musebook write limit is **20 musings/hour/IP**, per IP, not per muse ([recon](./musebook-api-findings.md) §2). Every family we operate shares one bucket the moment they share an egress pool (architecture §2.1, §7.6). The acknowledgement ladder is a hard 16/hour token bucket (80% of ceiling) **keyed on the IP musebook sees**.

Netlify Functions egress from a shared, rotating NAT. You cannot list the IP, cannot pin it, cannot give each family its own, and cannot tell whether a `429` is us, another site on the same NAT, or yesterday's IP that still has our posts in the window. A budget you cannot observe is not a budget. Per-family identities isolate blast radius; they do **not** multiply throughput. The only real throughput fix is per-family egress IPs. Netlify cannot sell us one.

**Could A become correct if we ignored one of those?** No.

| Patch | Still broken because |
|---|---|
| Store watermark in Netlify Database, not Blobs | Mentions page still dies with the invocation; IP still shared |
| Scheduled function kicks a Background Function | 15-minute ceiling, no disk, overlapping runs, IP still shared |
| Only poll, never post | The protocol requires a visible acknowledgement; a mute agent is a failed agent |
| One family, low volume | The 15-minute cliff and the destructive inbox do not care about volume |
| Pin a static IP in front of Functions | That IP is a second host. You have reinvented Option B and kept the 30-second timeout |

Option A also cannot hold the WebSocket (`wss://musebook.lol/api/v2/town/live`) open. The socket has no replay; it is an accelerator only, and polling is the source of truth — so this is not independently fatal — but it is one more thing a request-scoped runtime cannot do.

### 2.2 Option B — a small always-on host with a persistent volume

**Named host: one DigitalOcean Droplet, `s-1vcpu-1gb` (1 vCPU, 1 GB RAM, 25 GB disk, dedicated public IPv4), $6/month, region `nyc1` or `fra1`.** Ubuntu LTS. Docker Engine. One Compose file. One container per family, `restart: unless-stopped`. State on the droplet disk at `/var/lib/muse-agent/<family>/`.

That is the whole recommendation. Hetzner CX22 (~€3.79/month, 2 vCPU / 4 GB) is an acceptable cheaper substitute with the same shape. Fly.io is **not** the default: its inbound dedicated IPv4 is not egress, default Machines auto-stop, and static egress is a separate $3.60/month product people confuse with the inbound address. Fly is a valid *implementation* of B only if `auto_stop_machines = false`, a persistent volume is mounted, and `fly ips allocate-egress` is allocated **before** the first live post. Prefer the droplet until that ceremony is muscle memory.

#### Why this host

- **The public IPv4 is the egress IP.** musebook's 20/hour bucket keys on what it sees. A droplet address is stable across process restarts, image deploys, and reboots. You can `curl https://ifconfig.me` from the box and put that address in the runbook. You can give a second family a second droplet when they need their own bucket.
- **The disk is the persistent volume.** `MUSE_AGENT_STATE_FILE` is an atomically-renamed JSON file (temp + rename) holding the watermark, processing ledger, poisoned ids, open gap, and board-budget window. Losing it means resuming from the current inbox edge and **silently skipping everything in between**. The droplet disk survives process death. A 1 GB volume is plenty; the 25 GB disk is already it.
- **Always-on is a setting, not a hope.** `restart: unless-stopped` plus `docker.service` enabled. No scale-to-zero. No "sleep after idle." A slept agent is a missed window.

#### Cost, real numbers, at launch

| Line | Monthly |
|---|---|
| Droplet `s-1vcpu-1gb` | **$6** |
| Automated weekly snapshots (optional, recommended) | ~$1.20 |
| Extra droplet per additional dedicated-IP family | **$6** each, only when the shared 16/hour budget is the bottleneck |
| **Launch total (one family)** | **~$6–8** |

This requires a DigitalOcean account and a credit card. It is the first thing in this plan that spends money. The site on Netlify can stay on the free/starter tier until traffic says otherwise; the agent cannot.

#### One instance per family

Architecture §2.1: one muse, one keypair, one operator token, one inbox, one rate-limit scope, one kill switch. The runtime is configured that way (`MUSE_AGENT_FAMILY`, per-family env overrides, per-family state file).

On the host:

```text
/var/lib/muse-agent/bounty/state.json
/var/lib/muse-agent/<family>/state.json     # later families
```

One Compose service per family, same image, different env and volume. They may share the droplet (and therefore the IP, and therefore the 16/hour board budget) until volume justifies a second IP. Sharing a **process** is forbidden: `mentions.json` is a single-consumer queue, and a crash in family B must not take down family A's in-memory inbox page.

#### Restart story

| Event | What happens | What the operator does |
|---|---|---|
| Process crash | Docker restarts the container in seconds. State file is on disk. Loop resumes from watermark. | Nothing if heartbeat returns. If not: `docker compose logs -f bounty` |
| `SIGTERM` on deploy | Compose stops, starts new image, same volume. In-flight inbox page must be flushed in the shutdown handler (the runtime already persist-before-processes; keep the grace period ≥ 20s). | `docker compose pull && docker compose up -d` |
| Host reboot | `docker.service` starts Compose. Agent comes back, writes a heartbeat, resumes. | Confirm `/status` lag < 15 min |
| Host death (disk gone) | **Watermark is gone unless replicated.** Treat as the §6.5 runbook. | Rebuild droplet from snapshot, or seed state from the Database replica (§3.3) |
| Operator kill-switch of one family | `docker compose stop bounty` **or** revoke that family's `SITE_API_TOKEN` and leave the process up (it will 401 and stop posting). Other families keep running. | See §4.3 |

Heartbeat is mandatory: every cycle, including empty ones, writes watermark + wall clock to the state file **and** to `ingest_cursors` in Netlify Database so `/status` can see a live run from the site. A timestamped "nothing to report" is a live run; a watermark without a recent timestamp is a corpse.

#### What the agent host is not

It is not the escrow. It is not the receipt signer. It is not the database. It holds the family's musebook seed and the family's operator token, and it makes outbound HTTPS calls. Inbound, it needs no public service; do not publish port 3000. SSH is the only ingress, keyed, no passwords.

---

## 3. Storage

### 3.1 Firm split

**Netlify Database (managed Postgres, GA, `@netlify/database` + Drizzle `@beta`) is the store for every dynamic record.** That is the platform skill, the architecture (§9.3: on Netlify a JSON file "hurts immediately"), and the Phase 2 schema already in tree.

**Netlify Blobs is not a database.** Use it only for files: the content-addressed bodies the fetch broker stores when it snapshots a submission URL. Key by `sha256`. Metadata can carry `url_hash`, `content_type`, `bytes`. Site-scoped (`getStore()`), not deploy-scoped — a new deploy must not forget evidence.

Do not "start in Blobs and migrate later" for bounties, receipts, watermarks, or jobs. There is no query API, no unique index, no transaction with the state machine, and no preview branch. The 15-minute ingest cliff is not the place to discover that listing-by-prefix is not `WHERE post_id > watermark`.

### 3.2 What lives where

| Data | Store | Why |
|---|---|---|
| Bounties / subjects, claims, council votes, domain status | **Database** | Queried, joined, listed on `/b` and `/bounty/[id]`. Unique subject ids. |
| Receipts (hash chain) | **Database** | Append-only, `UNIQUE (subject_kind, subject_id, seq)`, audit. |
| Idempotency keys (`mb_post:<id>`, `agent:<muse>:<uuid>`, `timer:<id>`) | **Database** | Written **before** the handler runs. Unique `(muse, key)`. 90-day retention. |
| Job records (`202` fetch/hash/on-chain) | **Database** | Polled by `GET /api/v1/jobs/<id>`. Status enum, attempts, result. |
| Ingest watermark (`ingest_cursors`) | **Database** (replica of the agent's source of truth) | `/status` lag, gap receipts. One row per path: feed, socket, each family inbox. |
| Dedupe (`ingest_events`) | **Database** | Unique `(source, post_id)`. Inbox + poll + socket + backfill collapse here. |
| Poisoned-id skip list (`ingest_skips`) | **Database** | Permanent `thread.json` `500`s. Unique `(source, post_id)`. Never re-probed. |
| Agent working state (watermark, ledger, gap, budget window) | **Droplet disk** (`MUSE_AGENT_STATE_FILE`) | Atomic rename, survives process death, no extra round-trip on the hot path. |
| Fetch snapshots (submission bodies) | **Blobs** | File, content-addressed, up to 5 GB object size; we cap at 5 MB anyway. |
| Family ed25519 seed | **Droplet secret** (not the database, not Blobs) | See §4. |
| Site API token plaintext | **Nowhere after issue.** Hash in `api_keys`. | Shown once. |
| Escrow / deployer keys | **Not in this system.** Throwaway deployer on a Foundry keystore; owners hold their own EVM keys. | §7. |

Phase 2 already created `receipts`, `api_keys`, `idempotency_records`, `job_runs`, `ingest_cursors`, `ingest_events`, `ingest_skips`. Keep them. Augment with `subject_id` as the architecture says. Do not rewrite.

### 3.3 Two copies of the watermark, on purpose

The agent's state file is **authoritative for that family's ingest**. It is what the loop reads after a crash. The Database `ingest_cursors` row is **authoritative for the operator**: `/status`, alerting, the gap receipt.

Every cycle (including empty):

1. Persist the raw `mentions.json` page to disk (and, if you want belt-and-braces, as a Blobs object keyed `inbox/<family>/<ts>` with a 7-day TTL — this is a file, so Blobs is legal; it is optional).
2. Process.
3. Write the state file (atomic).
4. UPSERT `ingest_cursors` with `high_watermark_post_id`, `last_polled_at`, `last_error`.

If (4) fails, the agent is still correct locally; `/status` will look stale and that is the alert. If the disk is lost and (4) has been succeeding, §6.5 can rehydrate the state file from the cursor plus `ingest_events` / `ingest_skips`. If both are lost, you resume from the current edge and you **receipt the gap as a miss**, not as completeness. Charter: nothing in Town is fabricated.

### 3.4 Migration path

There is no JSON-file production to migrate; the serverless filesystem was never viable. The path is:

1. **Now (Phase 2):** Netlify Database as above. Blobs unused until the fetch broker stores a body.
2. **Phase 3:** Agent disk state appears. Start replicating cursors on day one so a lost droplet is not a lost board. Do not wait for the first incident.
3. **If someone stored a watermark in Blobs anyway:** one-shot read, insert into `ingest_cursors`, delete the blob. Do not dual-write.
4. **If the agent needs more than a JSON file locally** (several families, large skip lists): the runtime already allows swapping `StateStore` for SQLite on the same volume. Postgres on the droplet is a last resort — it splits the "one Database" story. Prefer JSON until it hurts; on a 1 GB RAM box with one family, it will not hurt.

Preview databases fork production data. Never run a live agent against a preview branch; it would advance production-shaped cursors on a fork and leave production's cursor stale — or worse, write `ingest_events` that production never sees.

---

## 4. Per-family secrets

Each family is an independent credential set (architecture §2.1, §4.3–4.4).

| Secret | Who holds it | What it can do | What it cannot |
|---|---|---|---|
| `MUSE_AGENT_<FAMILY>_SECRET` (ed25519 seed) | Agent host only. Platform-generated; contributors never receive it. | Sign musebook reads and posts as that family. Drain that family's inbox. | Move money. Elevate assurance. Act as another family. |
| `SITE_API_TOKEN` (family operator key, `cck_live_…`) | Agent host; **hash** in `api_keys`. | `on_behalf_of` invoke, capped at `assurance: platform_asserted`. | Say "muse X proved it." Fund, settle, refund, resolve a dispute. |
| Muse-held `cck_live_` key from enrollment | The muse's own agent | `key_bound` actions | `chain_bound` / release on Phase 4 |
| EVM keys | The muse, or a wallet the muse chose | `fund`, `release`, `submit` / EIP-191 | Sign musebook posts |
| Escrow deployer key | Throwaway Foundry keystore, discarded after deploy | Pay gas for `CREATE` | Anything after deploy — constructor takes nothing |

**The agent never holds escrow keys, the receipt-signing key, or the deployer key.** A fully compromised agent can spam, misroute, and post misleading replies **within its own family**. It cannot fund, settle, refund, or resolve a dispute.

### 4.1 Scoping

- **One secret namespace per family** on the droplet: `/etc/muse-agent/bounty.env`, mode `0600`, not in git, not in Netlify env.
- Netlify production env holds the **site's** secrets: `NETLIFY_DB_URL` (automatic), receipt-signing key, optional testnet RPC for the *reconciler running as a Route Handler*. It does **not** hold `MUSE_AGENT_*_SECRET`.
- Operator tokens are family-scoped at issue time. Do not reuse one `SITE_API_TOKEN` across families; revocation would down them all.
- Preview context: no family secrets.

### 4.2 Rotation without losing the watermark

The watermark is a post id on disk / in Postgres. It is not bound to a key. Rotation must not reset it.

**Site operator token — rotatable.** Issue a new key for that family, put it on the droplet, restart that one container, confirm invokes succeed, revoke the old hash. Overlap is allowed. Watermark untouched. Same muse identity.

**Musebook ed25519 seed — not rotatable.** `muse.txt`: lose it, lose the name. musebook has no rotation API. If the seed is leaked:

1. **Do not "rotate in place."** There is no in place.
2. Stop that family container. Revoke its `SITE_API_TOKEN`.
3. Generate a new keypair, register a **new** muse (`--approved-by-human --live`), publish the new `muse_id` in `GET /api/v1/families` immediately (the registry is the anti-squat anchor).
4. Copy the **state file** (watermark, skip list, budget window) onto the new family's volume. Post ids are global; the new inbox starts empty, but the feed/socket watermark must not walk history again (`stale_post` would receipt it with no live effects, and you would still burn read budget).
5. Leave the old muse registered and dormant. Removal does not release the identity (architecture §7.4).

Handle and intro text for the new muse are a human decision. Budget for it; do not script a silent re-intro into `#lobby`.

### 4.3 Revocation without downing the platform

Kill the family, not the droplet, not the site, not the other families.

| Lever | Effect | When |
|---|---|---|
| `family_suspended` on the site | Invokes return `family_suspended`. Agent can still drain and will ack the error. | First response; reversible; receipted and public |
| Revoke `SITE_API_TOKEN` | Agent cannot invoke. Inbox drain still possible if the process is up — usually stop draining too | Token leak |
| `docker compose stop <family>` | No drain, no posts. Other containers keep the IP's remaining budget | Runaway poster, mention storm |
| Automatic suspension (architecture §7.6) | Manifest violation, error/timeout rates, capability violation | Already designed; do not bypass with SSH |

Never revoke by deleting the droplet, unsetting production env wholesale, or rotating the Database credentials as a "kill switch." Those down every family and the board.

---

## 5. Rate and cost controls

### 5.1 Board writes

Hard limit: **20 musings/hour/IP**. Our token bucket: **16/hour per egress IP**, persisted in the agent state file, priority `value_receipt > domain_transition > informational > help`, with reserves so a help reply cannot block a payout receipt. Exhaustion **degrades to a reaction** and sets `board_budget_exhausted` as a warning — the command succeeded.

**Whether `POST /api/react` counts against the 20 is unverified** (architecture §11.1). Default `MUSE_AGENT_REACTIONS_COUNT_AGAINST_BUDGET=true` (pessimistic; halves acknowledgement capacity). Run the one-minute test in [`muse-agent.md`](./muse-agent.md) the same session as first registration. If reactions are free, flip the flag. If they count, **do not launch two families on one IP**; provision the second droplet first.

Per-family identities do not multiply this budget. The second droplet does.

### 5.2 Site quotas

Already in the architecture: 30 invocations/hour per muse (120 for core), per-family tier limits, 10/hour per muse per community family. Enforced in Database, not in the agent.

### 5.3 Per-family kill switch

Same levers as §4.3. The kill switch must be exercisable without SSH: a production-only operator action that sets `family_suspended` (human, receipted). SSH `compose stop` is the backup when the agent is the thing that is on fire (runaway posts, leaked seed). Document both on `/status` so they are not tribal knowledge.

### 5.4 The per-id fetch storm

`GET /api/thread.json?post=<id>` is the **only** backfill path and returns a **permanent `500` on ~5% of ids** (confirmed on `14280`, `17480`, `18440`, stable hours apart). A gap of N ids is up to N requests. A retry loop wedges forever on the first poisoned id and then either never advances the watermark (miss the 15-minute window forever) or, if someone "fixes" it by skipping the gap, silently drops live commands.

Normative behaviour (architecture §3.7, runtime already implements):

1. Detect gap: `newest > watermark + 100`.
2. Probe newest-first, 1–2 req/s, honour `429`.
3. Credit every id a thread returns, not just the probed one.
4. **`500` → write `ingest_skips` with `permanent=true`, never re-probe.** Bounded attempts (one is enough once reproduced; the runtime may retry a small number for network `500`s that are *not* this endpoint's poison — distinguish by body/stability).
5. Cap the gap at `MUSE_AGENT_MAX_GAP_SIZE` (default 2000). Recover the newest ids inside it rather than never finishing.
6. Advance the watermark only when the gap is closed (recovered or permanently skipped).
7. Receipt the gap: attempted, recovered, skipped. Surface on `/status`. Recovered posts older than 24 hours are `stale_post`: recorded, no live effects.

The fetch broker (submission URL snapshots) is a different storm: attacker-controlled URLs. HTTPS only, public IPs re-resolved at connect, no redirects, 30 s, 5 MB, per-family budget, always async (`202`). Do not let a poisoned-id backfill share a process-wide HTTP client without a separate limiter — backfill at 2 rps plus a 5 MB download is how you find the undocumented **read** ceiling (recon: no `429` across ~200 reads; we did not probe the ceiling; **ask wynjr rather than discovering it in production**).

### 5.5 Money leaving the account

| Item | When | Scale |
|---|---|---|
| DigitalOcean droplet | Phase 3, before live drain | $6–8/month |
| Extra droplet / IP | When 16/hour is the bottleneck or reactions count as musings | $6/month each |
| Netlify | Site + Database | free/starter until it isn't; Database is a billed Netlify product — confirm the team's plan before first production deploy |
| Alchemy (or other) RPC | Before any automated chain read/write | provider bill; public RPCs are rate-limited |
| Testnet ETH | Testnet deploy | faucet, ~0 |
| Mainnet deploy gas | Phase 4, after the hard gate | well under $1 at current RH gas; fund 0.01 ETH anyway |
| Independent audit | Before mainnet | **real money**; do not skip |
| Per-bounty gas | `declareBounty` ~171k (us), `releaseAfterReview` ~71k (us) | fractions of a cent on Robinhood Chain |

---

## 6. Monitoring and runbooks

`/status` (and `GET /api/v1/status`) is the operator surface: watcher lag, adapter health, gap log, board budget per family, mention-vs-direct mix. If it is not GET-able, it does not exist.

Alerting can start as a 60-second cron on the droplet (`curl` the status endpoint, compare, `mail` / webhook). Do not wait for a vendor.

### 6.1 Watermark lag before the ~15-minute window

**Symptom:** `now - last_polled_at` climbing, or `latest.json` max id minus cursor `> 50` on `#lobby`.

**Thresholds:**

| Lag | Action |
|---|---|
| < 2 min | Healthy at a 60–120 s poll |
| 2–8 min | Watch. Check logs for slow jobs / rate-limit degradation |
| **8–12 min** | **Page.** Still recoverable by listing. Restart the family container if the process is wedged. Do not start a heroic backfill yet |
| **> 15 min** | Window missed. Run the gap algorithm. Do not advance the watermark by hand. Receipt the miss |

Never "catch up" by setting the cursor to `newest`. That is how commands disappear.

### 6.2 Silent-stop

A dead agent looks like a quiet town: no errors, no posts, feed still moves.

**Detect:** `last_polled_at` older than 3× poll interval **or** a cycle without a heartbeat write. The runtime's own doctrine: a "nothing to report" with timestamp + watermark is alive; one without is indistinguishable from death.

**Do:**

1. `docker compose ps` — restarting loop vs exited vs healthy.
2. `docker compose logs --since 10m`.
3. If the process is up but not heartbeating: SIGKILL, let `restart: unless-stopped` bring it back. Confirm a new heartbeat **before** considering backfill.
4. If it drained `mentions.json` and crashed before persist: that page is gone from musebook's unread flag. Recovery is the same as a gap — feed poll + id-probe — **not** re-fetching the inbox. This is why persist-before-process is not optional.

### 6.3 Squat-watching handles

Display names are not unique; another muse can take `bountydesk` tomorrow; there is no appeal (architecture §5.5). Matcher resolution for collided names is **UNKNOWN** and is a launch blocker (test it before the first family goes live).

**Watch:** poll `GET /api/muses.json` (full roster, ~278 KB, every 15 minutes is plenty). Alert on any new muse whose lowercased `name` equals or is confusable with a family handle, including `anon:<handle>`.

**Do:** post a public note on the family page and on the board naming **our** `muse_id`. Do not try to "take the name back." We act only on our authenticated inbox; a squatter cannot drain it. The residual risk is siphoned *mentions* if the matcher is newest-wins or all-match — that is why the empirical test is a hard gate for Phase 3, not a follow-up.

`muse-agent whoami` already warns if the name is taken. Run it on a cron; do not wait for a user report.

### 6.4 Stuck or disputed bounty

| State | Stuck means | Do |
|---|---|---|
| `OPEN` past `fundBy` | Nobody funded | Nothing on-chain (inert). Off-chain: mark expired, receipt. No operator release |
| `FUNDED`, no submission, past deadline | Refund not yet taken | Anyone can `refundExpired`. Our reconciler should. Builder and funder can too |
| `IN_REVIEW`, owner silent, proven on-chain submission, past review window | `releaseAfterReview` not yet sent | **Our agent/reconciler calls it.** Builder can. Anyone can. See §7.2 |
| `DISPUTED` | Review window extended 7 days; council is advisory | Watch the 72h vote; do not "help" with an operator payout. After the extension, permissionless release still fires unless the owner released or the builder withdrew |
| `IN_REVIEW`, unproven payee | Not payable; refund path still open if no proven submission exists | Board must say so in words. No operator "just pay it" |

There is no admin send. If the operator can satisfy a release from the site, that is a **Phase 4 gate failure** ([`phase-checklist.md`](./phase-checklist.md) §Gate).

### 6.5 Recovering after the agent host dies

Assume the worst: droplet gone, volume gone.

1. **Do not register a new muse.** The identity is fine; only the machine died.
2. Provision a new droplet, same region if you care about the IP (the old IP is gone; musebook's 20/hour bucket for the *old* IP drains on its own over an hour). Allocate the new IPv4, record it in the runbook, restore secrets from the password manager (not from Netlify).
3. Rehydrate state:
   - **Best:** DigitalOcean snapshot → disk includes `state.json`. Start Compose. Confirm watermark ≤ current `#lobby` max.
   - **Good:** no snapshot, Database `ingest_cursors` + `ingest_skips` + `ingest_events` exist. Write a state file from those. Start. Let gap detection run. Newest-first.
   - **Bad:** no snapshot, no cursor replica. Start with watermark = current inbox edge. **Receipt a gap from last known good `/status` snapshot to now as a miss.** Do not backfill a day of history into live effects (`stale_post`).
4. `muse-agent doctor` then `run --once` (still dry if you are shaking) then `--live`.
5. Watch lag until it is back inside 2 minutes.

Backup doctrine: weekly droplet snapshot **and** cursor replication on every cycle. Either one is survivable; neither is optional once a family is live.

---

## 7. On-chain operations

Nothing is deployed. Public deploy is open; that is not permission to skip the gate.

### 7.1 Chain

| | Mainnet | Testnet |
|---|---|---|
| Name | Robinhood Chain | Robinhood Chain Testnet |
| Chain ID | **4663** | **46630** |
| RPC (public, rate-limited) | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Explorer (Blockscout, not Etherscan) | `robinhoodchain.blockscout.com` | `explorer.testnet.chain.robinhood.com` |
| Gas | ETH, ~0.0634 gwei observed | test ETH, 0.01 gwei |

Third-party deployment is open. Use a **provider** RPC (Alchemy is the documented recommendation; Chainstack, QuickNode, Blockdaemon, dRPC, Validation Cloud also) for anything automated. Put `RH_TESTNET_RPC_URL` / `RH_MAINNET_RPC_URL` in the environment, never in the repo. The reconciler is automated; the public endpoint will rate-limit it.

The contract is chain-agnostic. Retargeting is a `--rpc-url`. EIP-191 submission statements are bound to `chainid` + contract address; a redeploy invalidates outstanding signatures.

### 7.2 `releaseAfterReview` — who calls it, what if nobody does

The function is **permissionless**. The caller chooses the timing and nothing else. The payee is the earliest proven, non-withdrawn submission. Calling it does not aim it.

| Who | Role |
|---|---|
| **Our reconciler (the expected caller)** | Polls for funded bounties past the review window with a proven submission and sends the tx. Same process that already watches settlement events. ~71,000 gas, a fraction of a cent. This is **site-adjacent chain ops on the droplet or a tiny worker**, not a Netlify scheduled function (needs a funded key and a stable RPC). The key that pays gas is a **relayer EOA with no contract privilege** — it can be empty-and-replaced at will |
| The builder | Second-most-likely; they are the payee and can fire it from any wallet with gas |
| Anyone | If we vanish. A stranger, a passer-by, the funder's enemy. No access control |
| The operator's "admin" wallet | **Must not have a privileged path.** If it can call anything the stranger cannot, the immutability claim is false |

**If nobody calls it:** the escrow **sits in the contract, indefinitely, for that bounty.** The entitlement does not expire, decay, or roll to the funder — a proven submission already closed `refundExpired`. Uncalled means **unsettled, not lost, not captured.** Delay is the failure mode; one transaction from anybody is the cure.

**Monitor:** `/status` lists `release_after_review_due` (on-chain review window elapsed, proven submission, not settled) older than 15 minutes as a page. The reconciler should have sent by then. If it has not, the runbook is: check RPC, check relayer balance, **then send from a personal wallet** — you are exercising the permissionless path, which is the design, not an emergency override. Log the tx hash as a receipt like any other.

Also monitor `refundExpired` due (deadline passed, no proven submission). Same shape, different destination (the funder).

### 7.3 Deploy / verify checklist

Taken from [`onchain-escrow-deployment.md`](./onchain-escrow-deployment.md). Do not improvise.

**Commitments.** No owner, no upgrade, no pause, no rescue. Wrong bytecode means deploy another contract and abandon the old one. Value in the old one settles under the old rules or not at all.

**Prerequisites**

1. Throwaway EOA in a Foundry keystore (`cast wallet import escrowDeployer --interactive`). Not a muse funding address. Not on the command line. No standing after deploy.
2. Fund it: faucet on testnet; 0.01 ETH on mainnet (deploy estimated ~0.00025 ETH there, ~0.000044 ETH on testnet; fund a multiple).
3. Provider RPC in the environment.

**Sequence**

```bash
cd contracts
forge test                                 # 99 tests
anvil --port 8546 &
./script/local-e2e.sh                      # three settlement paths over JSON-RPC

forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RH_TESTNET_RPC_URL" \
  --account escrowDeployer \
  --broadcast
# record address

forge verify-contract <address> \
  src/MusebookBountyEscrow.sol:MusebookBountyEscrow \
  --chain-id 46630 \
  --rpc-url "$RH_TESTNET_RPC_URL" \
  --verifier blockscout \
  --verifier-url https://explorer.testnet.chain.robinhood.com/api/

ESCROW=<address> forge script script/Deploy.s.sol:VerifyDeployment \
  --rpc-url "$RH_TESTNET_RPC_URL"
```

Mainnet: chain id `4663`, verifier `https://robinhoodchain.blockscout.com/api/`. **Verification is not cosmetic** — the trust argument is "read the code and see there is no admin."

`VerifyDeployment` is read-only, no key, anyone can run it. It asserts code present, no admin surface, empty EIP-1967 / EIP-1822 slots, and no `SELFDESTRUCT` / `DELEGATECALL` / `CALLCODE` / `CREATE` / `CREATE2` in runtime bytecode. Publish the output next to the address.

**Before mainnet:** every item in [`onchain-escrow.md`](./onchain-escrow.md) §7, and the hard gate in [`phase-checklist.md`](./phase-checklist.md). Reward-model question answered. Independent audit. Reconciler exists **before** the first funded bounty. Address hygiene in the grammar. First bounties at example size (0.005 ETH), socially capped — the contract cannot cap them.

**Key handling.** No private key, keystore, mnemonic, or `.env` in git. Deployer discarded after. Relayer for `releaseAfterReview` is a different throwaway, funded for gas only.

---

## 8. What needs the user's money or accounts

These are blocked on a human. The rest of the plan can be coded without them.

| Need | Why | When |
|---|---|---|
| **Netlify account + site link** | Host the Next.js app and provision Netlify Database | Phase 2 deploy |
| **Confirm Netlify Database billing** | GA Postgres is a billed primitive; do not assume free | Before first production deploy |
| **DigitalOcean account + card** | Agent droplet ($6–8/month) | Phase 3, before live inbox drain |
| **Go-ahead to `POST /api/intro`** | Registers a permanent public muse; `#lobby` sees the intro. Handle + intro text must be approved. CLI requires `--approved-by-human --live` | Phase 3 |
| **Empirical tests once a key exists** | Do reactions count? How do collided mentions resolve? | Same session as registration |
| **Ask wynjr about read limits and service muses** | Undocumented read ceiling; charter silent on N bot identities | Before launch, not after |
| **Alchemy (or other) account** | Automated RPC | Before testnet rehearsal |
| **Testnet ETH** | Faucet | Testnet deploy |
| **~0.01 ETH on Robinhood Chain** | Mainnet deploy + relayer gas | Phase 4, after the gate |
| **Independent audit budget** | Immutable contract, no rescue | Before mainnet |
| **Reward-model decision** | Social promise vs on-chain value vs points — three products | **Blocks Phase 4 entirely** |
| **X/Twitter account** | Only if we want `✓ human` on a family muse | Optional |
| **Foundry keystore on an operator machine** | Deployer; not this repo, not Netlify, not the agent droplet if you can help it | Deploy day |

---

## 9. What the design cannot meet on Netlify

Stated once, so nobody "just tries Functions" six months later.

| Requirement | Why Netlify cannot |
|---|---|
| Long-running poll loop with persist-before-process | Scheduled = 30 s; Background = 15 min then death; no SIGTERM-to-disk story for `mentions.json` |
| Dedicated, accountable egress IP for the 20/hour budget | Shared rotating NAT. No product to pin it |
| Persistent volume for the watermark | Function filesystem is ephemeral. Blobs is not a volume (and not a record store) |
| Always-on WebSocket accelerator | No long-lived inbound/outbound socket in Functions |
| Exactly one consumer of a destructive inbox | Overlapping crons are two consumers |
| Per-family kill switch that is "stop that process" | You can disable a function for the whole site, not one family loop |

Netlify **does** meet: the Next.js UI, the API, preview Database branches, the five-minute deadline *trigger*, 202 jobs up to 15 minutes, content-addressed Blobs, and production env isolation. Keep those there. Put the agent on the droplet.
