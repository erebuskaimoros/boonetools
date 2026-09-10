# Financials dashboard

`/financials` is the protocol-wide volume, income, and bonding APR dashboard.
For local development, start it with:

```sh
npm ci
npm --prefix backend ci
npm run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

Development uses `/__financials` in Vite; production uses the shared BooneTools
client and `/functions/v1/financials?range=30d`. Both use the same data model and
collector implementation. Install backend dependencies for either mode.

## Production operation

`boonetools-financials.service` runs an independent collector process. It holds
an advisory lock and keeps three concurrent loops: recent/all-time history
refresh every five minutes, live acquisition every 30 seconds, and publication
every five seconds. Slow archive backfills do not block live publication.
The four allowed range payloads are persisted in existing Postgres
`api_read_models` rows (`financials:30d:v1`, `financials:90d:v1`,
`financials:1y:v1`, `financials:all:v1`); no new schema migration is needed.
Unchanged snapshots are coalesced, with a two-minute publisher TTL. Public GETs
read only these rows, use the shared three-second row cache, and send a bounded
15-second HTTP cache lifetime. Source ages are checked on every GET. Cold data
returns 503/Retry-After; failed acquisition retains last-good values. A stopped
collector cannot promote an old partial day into completed history at midnight.

Completed observations and verified bond totals survive releases in
`/var/lib/boonetools-financials/history-v1.json`, managed by systemd's
`StateDirectory` and written atomically. Include this directory in server data
backups. It is a reconstructible acquisition cache, separate from public read
models and from runtime secrets. A verified development cache may seed a first
installation while the collector is stopped; never overwrite a live cache.
Partial-day data is not written into this completed-history file.

Production calls use the shared provider transport/metrics/circuit breakers,
with separate Financials live/history/archive ordinary-failure scopes and
gateway-wide 429 cooldowns. Sources remain the verified public Liquify paths.
The guarded backend deploy starts the collector, installs its backend-only
protobuf dependency, and includes the default Financials route in its latency,
payload, compression, and freshness gate. Deploy backend before frontend.
Collector startup is conditional on its unit existing so rollback to older
releases remains supported; rollback does not delete retained Financials data.

## Accounting

- Default: 30 UTC calendar days including today. Additional ranges: 90D, 1Y,
  and all time from the multi-chain mainnet/Chaosnet launch on 2021-04-13.
  Today's partial bucket is explicitly marked; unindexed intervals stay unavailable.
- Volume: protocol-wide Midgard `/history/swaps`, with no pool filter. Uses
  executed pool legs, including both legs of cross-asset swaps. `totalVolume`
  is RUNE e8; `totalVolumeUSD` is USD cents at swap-time prices.
- System income: Midgard `/history/earnings.earnings`, the sum of liquidity fees
  and Reserve block rewards before distribution. USD income multiplies RUNE
  income by that same bucket's closing `runePriceUSD`. Today's provisional USD
  income uses its latest covered five-minute closing price.
- Daily bonding APR: `bondingEarnings / activeBond * 365 * 100`. It is a simple
  gross annualized protocol rate, not compounded APY or an individual provider's
  return after operator fees, bond caps, or performance adjustments.
- The active-bond snapshot is queried at the latest indexed action block before
  each UTC midnight. If that action is from an earlier day, a bounded block-time
  search proves the closing height with adjacent headers on either side of
  midnight. This also handles days without indexed actions. This is a closing
  balance approximation, not a balance weighted by time throughout the day.
  Bonds, unbonds, and nodes entering/leaving the active set affect the denominator;
  bond withdrawals do not become negative earnings.
- Missing source data remains `null`; lines have gaps. Observed zero days remain
  zero. Cards report observation counts; totals include today while daily income
  and APR averages use only observed completed days.
  Zooming changes card totals to the selected chart window.

## Live updates

The visible dashboard checks for fresh data every 30 seconds (every 5 seconds
while bond snapshots are pending). Background tabs pause polling and refresh
when visible again. Same-day refreshes preserve chart zoom, selected currency,
and hidden series. At UTC midnight the rolling window advances and resets zoom.

Midgard's unfinished daily and hourly intervals were observed returning zero
placeholders even while five-minute intervals showed real activity. Today is
therefore assembled from **completed five-minute intervals**, summed exactly in
base units. The cutoff is the last five-minute boundary behind both the source
watermark and local clock. Intervals must form complete contiguous coverage;
an incomplete response retains the previous snapshot with a delayed status.
This is near-live, five-minute-step data, not a per-block event stream.

Today's APR is `node rewards / active bond * 86400 / covered seconds * 365 * 100`.
Its bond snapshot uses the latest indexed action before the same cutoff, with
the existing block-time fallback for no-action days. The estimate is marked in
the chart and table, and can be volatile early in the day. Bond retrieval runs
in the background; no previous day's balance is substituted for a missing one.

The dev service coalesces refreshes across tabs/ranges; the production collector
acquires independently of visitor traffic. Both reuse totals until the
five-minute cutoff changes. Partial-day totals and bonds stay in memory only,
never in the completed-day disk cache. A new UTC day clears the old partial
snapshot even during an outage. Completed daily history replaces yesterday's
intraday data rather than carrying a partial total forward.

## Historical state and acquisition

Use Liquify Midgard and RPC. On 2026-09-10, the REST `/thorchain/nodes?height=…`
endpoint returned current validator state even with the Cosmos height header;
node `status_since` exceeded the requested height. It must not supply the
historical denominator. RPC `abci_query` with `/types.Query/Nodes`, empty data,
and explicit height returned the corresponding historical balances.

The narrow protobuf decoder reads status (field 2), status height (field 7),
and bond (field 9, formerly `bond`, now `total_bond`), ignoring unrelated fields.
Both the ABCI response height and node status heights are validated before use.
Standby/disabled balances are excluded. The schema lives in ThorNode's
`proto/thorchain/v1/types/query_node.proto`.

Local Vite caches completed history and verified bond totals under
`node_modules/.cache/financials/history-v1.json` (ignored, disposable). The
browser receives compact daily values, never the large validator responses.
History pagination respects Midgard's 400-interval cap and uses only `from`
and `count`. Earnings use 60-day pages because the upstream includes every
pool. Each successful page is saved before acquiring the next one.

APR backfills newest-first with three archive requests in flight, paced with
the other provider calls to at least 650 ms between starts. Large historical
node responses can take tens of seconds. A 60-second per-request deadline,
retry delay, and an hour cooldown on 429 bound recovery. The chart updates as
historical bonds arrive. Repeated explicit archive-unavailable responses stop
older requests for that server session; missing older APR remains a visible gap.
An unavailable archive day is never filled with the current bond balance.

## Verification

```sh
node --test backend/tests/financials.test.js backend/tests/financials-production.test.js
npm run check
npm run build
```

Tests cover UTC boundaries, USD/RUNE units, emissions in system income,
historical daily price alignment, missing versus zero values, unbonding,
pagination, RPC height checks, protobuf precision, active-node filtering, and
cache reuse with stale-data fallback, partial APR scaling, five-minute source
coverage, refresh coalescing, midnight rollover/recovery, provider-free public
reads, independent publication during slow backfills, graceful collector
shutdown, and rollback-compatible unit startup.
