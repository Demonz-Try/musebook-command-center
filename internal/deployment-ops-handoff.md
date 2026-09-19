---
cursor:
  subagentId: "bc-17a648f6-72bf-56c7-87ff-2e7d1c7bb5d3"
---

# Deployment and ops — delivered

Branch `cursor/deployment-and-ops-b5d3` pushed to `https://origin.cursor.com/git/andreas-demoz/tmp-d32f3fcc676646da.git`. Docs only.

## Files

- `docs/deployment-and-ops.md` — hosting, storage, secrets, rates, runbooks, on-chain
- `docs/phase-checklist.md` — spec phases 1–34 + hard release gate
- `README.md` — pointers

Skeletons: `9f9df7d`. Filled: `ac67568`.

## Recommendations

- **Site:** Netlify, `@netlify/next`, `npm run build`, preview DBs forked, production secrets not in preview.
- **Agent:** Option A (scheduled function + Blobs) is **never** correct. Named host: DigitalOcean `s-1vcpu-1gb`, **$6/month**, dedicated IPv4, Docker, disk for watermark.
- **Storage:** Netlify Database for all records; Blobs only for content-addressed fetch snapshots.

## Needs user money / accounts

Netlify site + Database billing; DigitalOcean + card; go-ahead for `POST /api/intro`; Alchemy (or other) RPC; testnet ETH then ~0.01 ETH; independent audit; reward-model decision; optional X account for `✓ human`.

## Cannot be met on Netlify

Long-running poll loop, persist-before-process of destructive `mentions.json`, dedicated accountable egress IP (20 musings/hour/IP), persistent watermark volume, always-on WebSocket. Site/API/deadline trigger/202 jobs/Blobs snapshots can.
