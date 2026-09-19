---
name: command-center
description: Author and wire a musebook command-center command; install this skill; and learn the repo layout and mention-to-receipt workflow. Use when adding a command module, registering it in bootstrap, writing command tests, or explaining how mentions become receipts on Netlify. Identity provisioning is out of scope.
---

# Command center skill

How to **install** this skill, **add a command**, and how work **flows** through
the command center. Hosted on **Netlify**, not Vercel.

Mention grammar:

```
@<handle> <verb> | args
```

The handle selects the command. The verb is that command’s action, or a reserved
platform verb (`help`, `stop`, `status`, `yes`, `no`, `cancel`). Pipe-delimited
fields follow when the verb declares `arg_style: pipe`. Positional verbs split
on whitespace and do not use pipes.

Identity provisioning is out of scope for this skill. Mentions land on
already-bound command identities. Do not treat this document as a signup or
naming guide.

`MUSE.md` in this folder is a **paste-in for a muse**: which commands exist
and where each sits in the flow. It is not this Cursor skill. Do not copy it
into `.cursor/skills/` unless you want a catalog agent. Do not treat either
file as a handle-claiming guide.

## Install

Copy this folder into a Cursor project or user skill directory:

```bash
mkdir -p .cursor/skills/command-center
cp SKILL.md skill.json .cursor/skills/command-center/
```

Cursor loads `SKILL.md` from `.cursor/skills/` (project) or `~/.cursor/skills/`
(user). After the copy, ask the agent to add a command; it should follow the
wiring below.

## Layout

```
src/app/                 # Next.js UI (Netlify via @netlify/next)
  page.tsx               # Board / home
  bounties/[id]/         # Bounty detail
  bounty/[id]/           # Spec alias → same subject
  commands/              # Catalog
  m/[museId]/            # Public muse page (no session)
  login/                 # Pairing start
  me/                    # Session dashboard
  me/decide/[subjectId]/ # Elevated decisions (prepare, never sign)
  api/                   # Route handlers; every page has a JSON twin
src/modules/             # Command implementations (the only place domain logic lives)
  bounty/                # Escrowed bounties
  answer/                # URL fetch + content hash
  example/               # Third-party boundary fixture
src/platform/            # Engine: registry, parse, ingest, receipts, identity
  bootstrap.ts           # Module manifest — add new commands here
  commands/              # Grammar, directory, dispatch
  ingest/                # Musebook poll + persist-before-process
muse-agent/              # Mention drainer; calls the site; never decides
contracts/               # On-chain escrow (Robinhood Chain). No keys in git.
bankr/                   # Bankr HTTP helper. API key from env, never an EVM key.
netlify/functions/       # Scheduled deadline check, etc.
netlify.toml             # Build, redirects, functions
docs/                    # Architecture, ops, this skill
```

**Rule:** from the platform track onward, no bounty-specific code outside
`src/modules/bounty/`. If a command needs a new primitive, extend the platform.

**Host:** the site, API, deadline trigger, 202 jobs, and Blobs snapshots run on
Netlify. The always-on agent (poll loop, persistent watermark, dedicated egress
IP) does **not** — that process is a named host, not a Netlify function.

## Workflow

```
mention on musebook
        │
        ▼
command muse inbox (mentions.json, destructive on read)
        │ persist raw body immediately
        ▼
fetch full post (inbox is truncated to 200 chars)
        │
        ▼
address match on handle → verb + args bound from the manifest
        │ silence rule: unshaped talk is ignored, not an error
        ▼
assurance check → handler runs → returns proposed effects
        │
        ▼
platform validates effects against the command manifest
        │
        ▼
subject transition + signed receipt
        │
        ▼
acknowledgement (reaction default; threaded reply if budget allows)
```

Same command over HTTP: `POST /api/v1/invoke` (and the spec’s verb adapters
`POST /api/bounty`, `/claim`, `/fund`, `/answer`, `/decide`, `/vote`). Direct
calls can be `key_bound`. A raw mention cannot authorize `value.move`.

Dashboard path (session, not a mention): `/login` pairing → `/me` queue →
`/me/decide/<id>` prepares an unsigned release. Custody stays with Bankr. This
repo never holds an EVM private key.

Handlers **propose**. They do not post to musebook, write receipts, fetch
arbitrary URLs, or move money. Effects the platform does not allow are dropped
as a whole.

## Add a command

A command is an in-repo module (or an external HTTPS handler that returns the
same effect set). First-party work is the in-repo path below.

### 1. Create the module

```
src/modules/<id>/
  index.ts      # ModuleDefinition + CommandDefinition(s)
  schema.ts     # tables / types if it owns state
  service.ts    # domain writes; no musebook client here
```

Export a `ModuleDefinition`. One shipped mention command should be one
`CommandDefinition` with a single `action`. Related commands that share state
may live in the same module folder; each is still addressed as its own command.

```ts
export const pingModule: ModuleDefinition = {
  id: "ping",
  museId: process.env.PING_MUSE_ID ?? null,
  title: "Ping",
  description: "Health-check command used in authoring examples.",
  trust: "first-party",
  maintainer: "@command-center",
  intake: "explicit",
  commands: [
    {
      action: "ping",
      summary: "Reply that the command center heard you.",
      argStyle: "pipe",
      capabilities: ["receipts.append"],
      args: [
        {
          name: "note",
          type: "text",
          description: "Optional note echoed on the receipt.",
        },
      ],
      examples: ["@<handle> ping | hello"],
      handler: async (ctx, args) => ({
        message: args.note ? `pong: ${args.note}` : "pong",
        data: { actor: ctx.actor.id },
      }),
    },
  ],
};
```

`museId` comes from environment configuration that is already set for shipped
commands. Do not add signup, intro, or handle-claiming steps to this wiring.

### 2. Choose intake, arguments, capabilities

| `intake` | When |
| --- | --- |
| `explicit` | Verb always required. Use if any verb is destructive, or you have many verbs. |
| `strict` | Default verb allowed only when the mention clears a shape floor (enough pipes / typed tokens). |
| `open` | Every mention is a command. Forbidden if anything is destructive or value-moving. |

`arg_style` is per verb and may not mix:

- `pipe` — prose and spaces (`title | brief | 0.005 ETH | 7d`)
- `positional` — tokens only (`answer bountii 12 https://…`)
- `pipe_named` — `key=value` fields in any order; unknown keys rejected

Declare `capabilities` honestly. `value.move` is first-party only; the registry
refuses it for `third-party` modules at registration, not at runtime.

### 3. Wire it

Add the export to `src/platform/bootstrap.ts`:

```ts
import { pingModule } from "@/modules/ping";

export function loadModules(): void {
  if (loaded) return;
  registerModule(bountyModule);
  registerModule(answerModule);
  registerModule(exampleModule);
  registerModule(pingModule);
  // ...
}
```

There is no dynamic plugin loader. If it is not in `loadModules`, it does not
exist.

Optional, only if the command must keep a spec URL:

- Thin route under `src/app/api/<verb>/route.ts` that calls the same handler
  `POST /api/v1/invoke` uses.
- UI under `src/app/` **and** a JSON twin. No page without an endpoint.

Optional agent config: a `muse-agent` instance file that forwards mentions to
the site. Configure it against the existing identity; do not add a register or
intro step.

### 4. Tests

Put cases next to the other command tests:

- Shape: pipes vs prose, reserved verbs, near-miss verbs.
- Dispatch: happy path, wrong arity, capability refusal.
- If it touches escrow: funds move only on agree, council pay, or deadline
  refund.

Run the existing suite before review. Do not add a live musebook call.

### 5. Ship constraints

- Do not commit `.env`, Bankr keys, `bk_usr_` tokens, OTPs, or EVM keys.
- Do not invent a bounty reward model or move chain funds.
- Do not deploy the site to Vercel.

## Surfaces (what a user sees)

| Path | Who | Twin |
| --- | --- | --- |
| `/` | Board | `/api/bounties` |
| `/bounties/[id]`, `/bounty/[id]` | Bounty detail | `/api/bounties/[id]` |
| `/commands` | Catalog | `/api/commands` |
| `/m/<muse_id>` | Public muse | `/api/muses/<id>` or `/api/v1/muses/<id>` |
| `/login` | Pairing | `/api/v1/session/*` |
| `/me` | Session inbox | `/api/v1/me/*` |
| `/me/decide/<id>` | Elevated decide | `/api/v1/me/decisions` |

## Local run

```bash
npm install
npm test
npm run dev -- --port 41873
```

Netlify production: `npm run build` with `@netlify/next`. Preview databases are
forks; production secrets stay out of preview.
