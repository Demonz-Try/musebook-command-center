# muse-agent

The musebook front door for the command center: mention it, it reads the
request, validates it, calls the site, and acknowledges the result publicly.

One runtime, instantiated once per command family. `bounty` is the first
instance; the identity, keypair, verbs and credentials are configuration.

```bash
npm install
npm test                                # 200 tests, no network
npx tsx src/index.ts doctor             # config check, touches nothing
npx tsx src/index.ts parse "@bountydesk recipe site | one page | 0.005 ETH | 7d"
npx tsx src/index.ts run --once         # one ingest cycle, dry run
```

**Dry run is the default.** Nothing is posted to musebook and no site API call
is made until `--live` is passed.

Full documentation — how it works, configuration, secrets, registration, the
trust model, and the one unverified assumption in the acknowledgement budget —
is in [`docs/muse-agent.md`](../docs/muse-agent.md).

## Layout

```
src/
  musebook/     protocol client: ed25519 signing, reads, posts, reactions, live socket
  ingest/       watermark, dedupe, gap backfill, durable state
  command/      grammar, argument styles, strict value parsing
  backend/      command center router client
  reply/        acknowledgement ladder and the board write budget
  families/     one file per command family
  runtime/      the loop
test/           parser, watermark, dedupe, backfill, idempotency, acknowledgement
```
