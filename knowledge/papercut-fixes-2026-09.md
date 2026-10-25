# September papercut fixes: what shipped and what is still missing

Two papercut passes (September 2 and September 25, 2026) produced fixes that
never reached `origin/main`: the September 25 fixes stayed uncommitted in the
`fix/release-dev-papercuts` worktree, and the September 2 fixes were committed
as `868f7ef` but never pushed. Their entries were nevertheless marked resolved.
Branch `chore/port-worktree-keepers` (October 25) recovers the parts below.

## Shipped by `chore/port-worktree-keepers`

- `pc-20260918-121824-4f8934`: frontend release archives use `tar --no-xattrs`
  with `COPYFILE_DISABLE=1`. Also fixes the recurrence `pc-20261018-013408-1fe966`.
- `pc-20260910-072507-6a9a5c`: Financials (history and hourly) and protocol
  comparison dev caches live in `.boonetools-cache` and migrate once from
  `node_modules/.cache`, so `npm ci` no longer discards them.
- From `868f7ef`: the disposable PostgreSQL harness
  (`backend/scripts/with-test-postgres.mjs`) with native migration mode and the
  Midgard history-parameter guidance.

The checkout-root (`pwd -P`) and `runuser --` deploy fixes from `868f7ef`
reached main separately.

## Deliberately not ported

- `pc-20260917-190124-3dc5a6`: the `AGENTS.md` link to the operator procedures
  was an absolute home-directory path in a public repository; global agent
  instructions already cover it. The entry remains marked resolved.
- The `868f7ef` Cosmos transaction decoder: it does not decode THORChain's own
  message types, and such tooling belongs in tcli or chain-analysis-app.
- `pc-20260917-191103-98a9d5`, `pc-20260908-074337-bbb9aa`: a helper that let the
  scheduled IP-info workflow raise the frontend byte budget by the catalog's
  growth. The workflow succeeded on every run from October 1 to October 23 with
  the existing headroom; if catalog growth exhausts it, raise the budget by hand.
- The `868f7ef` currency handler HTTP tests, which overlap
  `backend/tests/currency-rates.test.js` without reproducing a defect.

## Still missing from main

Each has failing reproduction tests in `868f7ef` (local branches
`codex/papercut-reliability` and the primary checkout's unpushed `main`);
port them test-first before those branches are removed:

- Lazy database pool configuration (`backend/tests/database-lifecycle.test.js`).
- Serialized queries on advisory-lock clients in the App Layer base fees,
  reserve payments, Rapid Swaps and Vote Tracker read models
  (`backend/tests/read-model-client-serialization.test.js`).
- Height-specific historical REST caching and RPC fallback
  (`backend/tests/historical-rest-cache.test.js`).
- Backend release-gate and host-health hardening
  (`backend/tests/deployment-reliability.test.js`).
- The perf-smoke stale-endpoint retry (`backend/tests/perf-smoke-freshness.test.js`).
