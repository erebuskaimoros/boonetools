# BooneTools

BooneTools is the public THORChain tooling site served at [boone.tools](https://boone.tools).
The canonical standalone repository is:

```text
https://github.com/erebuskaimoros/boonetools
```

This repo is a Svelte/Vite frontend with a small Node/Postgres backend for cached THORChain analytics. Dune is the source of truth for historical analytics; public THORChain endpoints are retained for live chain state, quotes, wallet balances, and other action-oriented reads that Dune cannot safely serve.

## Page-view analytics

The SPA sends a credential-free same-origin `POST` to
`/_analytics/page-view/<page-slug>` when a visitor selects a tool page. The
event follows client-side navigation, carries no body, cookie, persistent
visitor ID, search parameters, or wallet data, respects browser Do Not Track,
and excludes desktop-app embeds. Caddy records the request in its
privacy-filtered Boone Tools access log; the separate private Web Traffic
Analytics service aggregates the fixed page slugs into the protected
`boonetools-pages.html` report.

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

The App Layer dashboard tracks Rujira App Layer fee-share configuration and final transfers into the THORChain Base Layer. Lane 01 is served by the backend from two-minute collector-state snapshots, with the checked-in earnings artifact used only as its historical bootstrap and outage fallback. Dune is the preferred historical source for Reserve payments and app-attributed THORChain liquidity fees; the API reports when it has fallen back to RPC/Midgard. Generated static artifacts live under `public/data/rujira-base-layer-fees/`, and the page links collector addresses and txs to `thorchain.net`.

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
VITE_BOONETOOLS_API_BASE=https://boone.tools/functions/v1
VITE_BOONETOOLS_API_KEY=
```

All frontend features use this single origin/key pair. Existing `VITE_NODEOP_*`,
`VITE_APP_LAYER_*`, `VITE_NODE_VOTES_*`, `VITE_RAPID_SWAPS_*`, and
`VITE_TC_FEE_DASH_*` API variables remain supported as migration aliases, but
new environments should not mix feature-specific origins or credentials.

The shared frontend client unwraps versioned `{ data, meta }` responses so
existing feature payloads stay compatible. Consumers that need the versioned
transport metadata can call `getBooneToolsApiMeta(payload)` from
`src/lib/api/boonetools.js`.

Backend runtime values live in `backend/.env` on the server. Start from `backend/.env.example` and set real values there, including `DATABASE_URL`, `DUNE_API_KEY`, and the CMC settings used by TC Fee Dash. `PUBLIC_API_KEY` is retained only as a legacy optional client token; it is not access control because frontend values are public.

Pool Dislocation samples every `Available` THORChain pool on exact five-minute
UTC buckets. The scheduled backend job persists 30 days of observations,
publishes the compact `/functions/v1/pool-dislocation` read model, and serves
the selected pool's exact seven-day points from
`/functions/v1/pool-dislocation-series?asset=...`. Binance uses its public
market-data-only endpoint and requires no API key. Because those markets quote
assets in USDT, each raw `XUSDT` bid, ask, midpoint, or kline close is converted
to USD with the same-snapshot THORChain Oracle `USDT/USD` rate. The composite
reference is retained only when its source timestamps are within 30 seconds;
otherwise its USD values remain null and the price method records why. The
default-on halted-chain filter reuses the canonical `thornode-core:v1`
inbound-address state; unknown or stale trading state does not hide pools. The
selected-pool chart can show the trailing 1 hour, 1 day, or 7 days, and a
horizontal drag highlights and zooms into any subrange without interpolating
missing five-minute samples. A resumable one-shot backfill can
reconstruct the initial seven-day window from same-height historical THORNode
pool/oracle state and Binance five-minute kline closes. API points label their
origin and composite pricing method because Binance does not expose historical
`bookTicker` midpoints through its public archive. Migration 042 archives the
original raw USDT quotes before applying the same conversion to stored history.

All read-only `/functions/v1` routes are public and protected by backend request
rate limiting. Successful responses retain their established shape and gain a
standard `meta` object. Clients can request the versioned `{ data, meta }`
envelope with `?schema_version=2` or `Accept:
application/vnd.boonetools.v2+json`.

Bond History serves existing cached rows immediately and coalesces refreshes in
`bond_history_refresh_queue`. `boonetools-bond-history-refresh.timer` processes
the queue under per-address advisory locks. All normal reads are cache-only:
cold misses return `202` and the Bond Tracker polls the cache-only status path
while the worker materializes the first snapshot. `refresh=sync` is reserved
for the worker and operational repair tooling.

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

Refresh the lane 01 historical bootstrap and frontend fallback:

```bash
node scripts/rujira-base-layer-inflows.mjs
```

Routine runs retain verified older rows and recompute the latest three UTC days so they do not depend on indefinite archive-node retention. Set `RUJIRA_INFLOW_FULL_REBUILD=1` only when a full historical Thornode archive is available. The generator writes the public fallback and `backend/data/rujira-base-layer-inflows.json` together.

The collector-distribution artifact is deliberately not an all-time revenue ledger: it observes direct transfers to the currently configured target addresses since its recorded start height, and records current residual balances separately. Its values are non-additive and use current pricing, not historical USD-at-receipt accounting.

## Deployment

BooneTools deploys must be run from the BooneTools website checkout, not from the outer THORChain workspace or the Thornode repo:

```bash
cd /Users/boonewheeler/Desktop/Projects/THORChain/boonetools/website
```

The guarded scripts require clean, CI-green `main` matching `origin/main`. If
the broader THORChain/Thornode worktree is dirty, use a clean BooneTools
checkout/worktree for the intended patch. Do not work around that by manually
deploying from the wrong repo.

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

Both flows use checksummed immutable releases, one server-wide deployment lock,
an atomic `current` symlink, post-switch health gates, and verified automatic
rollback. BooneTools application deploys do not modify the host-wide Caddy
configuration.

After a frontend deploy, verify the built bundle still contains the expected API base:

```text
https://boone.tools/functions/v1
```

## Notes For Future Work

- Prefer Liquify gateway endpoints first for THORNode, Midgard, and RPC traffic.
- Configure additional providers only after verifying their availability and API behavior.
- Avoid pushing browser traffic directly into Midgard-heavy scan paths when a cached backend route exists.
- New UI work should follow `DESIGN.md`, which reflects the current terminal-style BooneTools interface.
