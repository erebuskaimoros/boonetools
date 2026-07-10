# BooneTools

BooneTools is the public THORChain tooling site served at [boone.tools](https://boone.tools).
The canonical standalone repository is:

```text
https://github.com/erebuskaimoros/boonetools
```

This repo is a Svelte/Vite frontend with a small Node/Postgres backend for cached THORChain analytics. Dune is the source of truth for historical analytics; public THORChain endpoints are retained for live chain state, quotes, wallet balances, and other action-oriented reads that Dune cannot safely serve.

## What Is In Here

- `src/` - Svelte app code for the public tools.
- `public/` - static assets and generated public data artifacts.
- `backend/` - Node backend for cached NodeOp, Bond Tracker, and Rapid Swap data.
- `scripts/` - deploy, listener, backfill, repair, and generated-data scripts.
- `docs/` - operational docs plus generated research/chart artifacts.
- `ops/` - Caddy, Docker, and systemd files for the production host.
- `knowledge/` - repo-local session notes and protocol references.

## Current Notable Tools

- Bond Tracker
- Rapid Swaps
- TC Fee Dash
- Treasury Tracker
- Vault Explorer
- Limit Orders
- App Layer to Base Layer dashboard at `/app-layer-base-layer`

The App Layer dashboard tracks Rujira App Layer fee-share configuration and final transfers into the THORChain Base Layer. Dune is the preferred historical source for Reserve payments and app-attributed THORChain liquidity fees; the API reports when it has fallen back to RPC/Midgard. Generated static artifacts live under `public/data/rujira-base-layer-fees/`, and the page links collector addresses and txs to `thorchain.net`.

## Local Development

```bash
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:5173/
http://127.0.0.1:5173/app-layer-base-layer
```

Run a production build:

```bash
npm run build
```

Run frontend tests:

```bash
npm test
```

Run backend tests:

```bash
npm run backend:test
```

## Environment

Do not commit real secrets. The committed env files are examples only:

- `.env.example`
- `backend/.env.example`

Frontend production builds use these public runtime values:

```bash
VITE_NODEOP_API_BASE=https://boone.tools/functions/v1
VITE_RAPID_SWAPS_API_BASE=https://boone.tools/functions/v1
VITE_TC_FEE_DASH_API_BASE=https://boone.tools/functions/v1
VITE_NODEOP_API_KEY=
VITE_RAPID_SWAPS_API_KEY=
VITE_TC_FEE_DASH_API_KEY=
```

Backend runtime values live in `backend/.env` on the server. Start from `backend/.env.example` and set real values there, including `DATABASE_URL`, `PUBLIC_API_KEY`, `DUNE_API_KEY`, and the CMC settings used by TC Fee Dash.

Current Dune source queries:

- TC Fee Dash daily series: `7619850`
- Vote Tracker node Mimir events: `7619989`
- Rapid Swaps canonical rows: `7619996`
- Rapid Swaps market-history denominator: `7620035`
- App Layer generated base-layer fees: `7620091`
- App Layer explicit Reserve payments: `7620011`
- Bond Tracker bond/unbond tx discovery: `7620042`

TC Fee Dash uses THORChain daily earnings from `thorchain.defi_daily_earnings`, CMC historical global market volume for the CEX/global leg, and Dune-indexed DEX exchange volume from `dex.trades`. It no longer fans out to Midgard or DeFiLlama for that daily series.

## Generated Rujira Data

Refresh observed Base Layer Reserve payments:

```bash
node scripts/rujira-base-layer-fees.mjs
```

Refresh observed direct app-collector distributions and current-balance context:

```bash
node scripts/rujira-collector-revenue.mjs
```

Refresh the narrow Base Collector conversion-fee artifact used only as a backend-outage fallback:

```bash
node scripts/rujira-app-layer-swap-fees.mjs
```

The collector-distribution artifact is deliberately not an all-time revenue ledger: it observes direct transfers to the currently configured target addresses since its recorded start height, and records current residual balances separately. Its values are non-additive and use current pricing, not historical USD-at-receipt accounting.

## Deployment

BooneTools deploys must be run from the BooneTools website checkout, not from the outer THORChain workspace or the Thornode repo:

```bash
cd /Users/boonewheeler/Desktop/Projects/THORChain/boonetools/website
```

If the broader THORChain/Thornode worktree is dirty, use a clean BooneTools checkout/worktree for the intended patch. Do not work around that by manually deploying from the wrong repo.

The live frontend is served from:

```text
/var/www/boone-tools/
```

on the production host for:

```text
https://boone.tools/
```

Frontend deploy script:

```bash
npm run boonetools:deploy:frontend
```

Backend deploy script:

```bash
npm run boonetools:deploy:backend
```

After a frontend deploy, verify the built bundle still contains the expected API base:

```text
https://boone.tools/functions/v1
```

## Notes For Future Work

- Prefer Liquify gateway endpoints first for THORNode, Midgard, and RPC traffic.
- Keep official `*.thorchain.network` endpoints as tested fallbacks where the code already uses failover.
- Avoid pushing browser traffic directly into Midgard-heavy scan paths when a cached backend route exists.
- New UI work should follow `DESIGN.md`, which reflects the current terminal-style BooneTools interface.
