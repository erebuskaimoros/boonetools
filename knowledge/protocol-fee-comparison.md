# Monthly protocol fee comparison

Scope: a second ECharts panel below Financials, USD calendar months only,
current month partial through a common completed UTC day. Metric is swap
income minus gross token subsidy, following the September 18, 2026 report
in the workspace's `artifacts/protocol-fee-comparison/2026-09-18/`.

## Accounting

- TC: daily Midgard `liquidityFees / 1e8 * runePriceUSD` less the signed
  `blockRewards` field at that price. Preserve accounting residuals and
  describe this as reported Reserve rewards, not an audited release ledger.
- NEAR: daily published Intents revenue multiplied by non-frontend receipts
  divided by all three fee-wallet receipts. Dune query **8767542**, ISO text
  parameters `start_date` inclusive and `end_date` exclusive, excludes
  transfers among the three wallets. Deduct the official revenue dashboard's
  daily modeled whole-chain NEAR issuance at historical daily USD prices.
  This is explicitly a 100% network-subsidy scenario and provisional income,
  not Intents operating profit. Render the Powered by Dune link.
- CF: DeFiLlama `chainflip-amm` dailyRevenue (swap Network Fee, not LP fees)
  minus gross FLIP issuance at each day's historical price. Do not use the
  report's 334,000/31 daily pace or net supply as issuance.

## One-year extension — September 18, 2026

This section supersedes the initial delivery status below. The rolling window
now starts at the UTC month boundary twelve months before the current month:
**September 2025–September 2026** in the current preview (13 monthly buckets,
12 complete months plus the current partial month). Port **5184** remains the
dev server. The main Financials chart was also switched to its existing 1Y view.

**The full three-protocol history is not yet complete.** Verified monthly
coverage currently is TC September 2025–September 2026; NEAR January–September
2026; CF August–September 2026. Older incomplete months stay null, not zero,
and a prominent GAPS notice identifies them. This was not deployed or committed.
Full frontend and backend tests, production build, and Svelte checks pass
(0 errors; 56 pre-existing warnings). The one-year chart was visually checked
on the dev page, including its missing-data warning and monthly axis.

### Public NEAR acquisition

- Replaced the production Dune dependency with FastNear's public
  `POST https://transfers.main.fastnear.com/v0/transfers` index. Acquired all
  **382** completed UTC days from September 1, 2025 through September 17, 2026.
  The 48 overlapping previously saved Dune days reconcile within 1e-7 NEAR.
- Include positive `native:near` **NativeTransfer** actions and positive
  `nep141:wrap.near` transfers to the same three wallets. Exclude internal
  transfers and `AttachedDeposit` records, which include DAO proposal bonds.
  This distinction explained two 0.3 NEAR discrepancies on August 27 and
  September 9. Complete all pages for every wallet before publishing a month;
  only then may a day with no receipts be represented as zero.
- Official dashboard `absoluteRevEmissions` exposes cumulative daily issuance
  from January 1. Its public
  [implementation](https://github.com/near/near-revenue-dashboard/blob/main/src/lib/utils.ts)
  sums `emissions_near` from that baseline. Consecutive differences recover
  daily modeled issuance before the dashboard's rounded trailing-90-day series.
  Never difference across a gap, year reset or missing January 1 baseline.
  This gives 260 modeled days in 2026 without extrapolating to 2025.
- Exact archive reader: at consecutive epoch starts, gross mint equals supply
  increase plus **newly included** chunk `balance_burnt`. Older chunk headers
  repeated in a block must not be counted twice. This follows
  [nearcore's supply invariant](https://github.com/near/nearcore/blob/master/core/primitives/src/block.rs).
  Follow epoch hash links and verify the prior epoch start's parent hash and
  epoch ID. Historical `validators` information can be unavailable even when
  blocks are archived, so only use it to seed the current epoch.
- Public archive `https://archival-rpc.mainnet.fastnear.com` is heavily
  rate-limited. Saved **201** verified epoch records in the main acquisition
  cache. Requests are paced to at most one per 1.2 seconds; each scheduled run
  acquires at most 100 new epochs. A failed or bounded backfill does **not**
  replace the existing modeled series with a mixture of incomplete exact data.
  Unreviewed future protocol versions above 86 fail closed (notably future
  changes to which execution results contribute burns).
- The old Dune SQL remains a reconciliation reference only. No Dune key is
  required for ongoing acquisition. Display attribution reflects the actual
  wallet source. Asked the user whether a higher-capacity NEAR archive endpoint
  is available; none has been supplied yet.

### Historical Chainflip extension

Reviewed the historical emission path in published tags and immutable release
commits. For admitted 1.11.x–2.2.x versions, `on_initialize`, `note_author` and
`update_block_emissions` are instruction-source-identical to the previously
reviewed 2.2.14 functions; delegation retains the operator remainder that makes
recipient allocations sum exactly to the mint budget. This is a focused
accounting review, not an audit of the entire runtime.

Some tags are missing or point at a different runtime version. The relevant
immutable references are:

- 11005: `737a6b54e4d8cb6408b0a01b78fc001ece9dc16f`
- 11006: `ba7ab1fa71e9cd0b5aeefe70e2c460a1a80a7224`
- 20010: `194b4a2cae5b73a72c43bee6f3a6747d8a8c6988`
- 20011: `26fd5d00afeb00d3b8dd6478b3201726ac94573e`
- 20012: `c894ce22bb58ef71378802cb91945f5b29b43ed5`
- 20113: `ec4a98f0ea2e8c46b2735e65f952a0f8c238c8cc`
- 20119: `9a78ee4c34c95fa3dd4314667b44763b8f52daee`

Runtime 1.10.3, 1.10.5 and 1.10.6 have identical emissions and runtime reward
distribution sources. They mint **before** the reputation hook refreshes the
emission amount every 150 blocks: read the preceding block's rate and start
its new segment one block later. Check every legacy backup emission segment;
nonzero backup rewards require event-level accounting and fail closed here.

Independent boundary checks:

- Block 9,406,500: supply delta plus observed transaction fees gives
  **708846671615152460** atomic FLIP, the preceding rate. The stored rate at
  the end of that block is **708847461817345400**. Block 9,406,501 mints the
  latter amount. The explorer's `Block.reward` uses the new end-of-block rate
  at 9,406,500, so it is not an exact substitute for legacy issuance.
- Decoded `FlipMinted` sums at 10,280,249–251 (11112) and 11,986,049–051
  (20012) match the same-block emission amount, including the new compounded
  rate on the modulo-150 block. Legacy runtimes do not emit `FlipMinted`.
- Acquired 383 date-boundary hints from Chainflip's explorer. Every hint is
  verified against archive hashes and adjacent block timestamps before use.
- Four additional legacy days (September 1–4, 2025) were fully verified and
  checkpointed. The archive then timed out; the month remains unavailable.
  New completed days are prioritized over older missing days on scheduled runs.

Development-only source-review and raw checkpoint artifacts are under
`node_modules/.cache/protocol-fee-comparison/`; the durable collector cache has
the wallet history, epoch checkpoints, verified FLIP days and boundary hints.
The one-off acquisition processes have been stopped; the normal six-hour
server-owned collector resumes from this cache. Do not start concurrent writers.

## Chainflip investigation

Public archive: `https://mainnet-archive.chainflip.io`.
`cf_flip_supply([blockHash])` returns `[totalIssuance, offchainFunds]` in
18-decimal atomic FLIP. Verified block 14,872,200 at 2026-09-18 13:53:42.001
UTC: total supply 88,876,212.12838836 FLIP.

Public GraphQL: `https://explorer-service-processor.chainflip.io/graphql`.
One query can sum `allBurns`, with timestamp filters and
`aggregates { sum { totalAmount } }`. August returned 30 records totaling
707,334.222904990675955465 FLIP: the reported buy-and-burn amount.
This is **not established as an exhaustive all-burns ledger**.

Slashing is separately queryable with `allAccountFundingEvents`, type
`SLASHED`, filtered through `eventByEventId.blockId`. Extrinsic fees can be
summed with `allExtrinsics`, filtered by `blockId`, sum `fee`. Both can be
aliased into the same GraphQL request as network burns.

A September 17 reconciliation test (start block 14,849,466 inclusive;
end block 14,863,863 exclusive, supplies read at the preceding blocks):

- Supply change: -29,135.379909791 FLIP.
- Network burns + indexed extrinsic fees + slashes: 38,624.72457646619 FLIP.
- Implied issuance: 9,489.344666675199 FLIP.
- Historical emission-segment reconstruction: 9,556.229300332594 FLIP.
- Unreconciled difference: approximately 66.884634 FLIP. Do **not** replace
  the issuance source with this incomplete burn reconstruction. Runtime also
  has account-dust and other `FeePayment::try_burn_fee` burns.

Audited public runtime tags 2.2.7, .8, .9, .11, .12, .13, .14 have identical
emissions and delegation implementations. Emission amount refreshes every
150 blocks before authorship, and delegated allocations plus the operator's
remainder sum exactly to that amount. Verified mint events at block
14,872,200 and 14,872,201 equal the new boundary rate, not the previous rate.
The reader sums historical on-chain amounts over finalized block counts,
with exact BigInt arithmetic and source hash/time boundaries.

### Untagged runtime 20210 verification

Runtime **20210** occurs starting August 24, but has no public 2.2.10 tag.
The September 18 review retrieved deployed `:code` with
`state_getStorage(["0x3a636f6465", blockHash])`, decompressed its Substrate
Zstd wrapper, and disassembled it with WABT 1.0.39. macOS `c++filt` demangles
its retained Rust-v0 function names. No runtime binary was executed.

- Reference 20208 at block **14,489,779**: code hash
  `0xffcc27cd310b9da61638ec08584f5a78e4dac3c45d9efb247b31cb6de1f1b4da`.
- Reviewed 20210 at block **14,518,570** (also checked at 14,619,300):
  `0xc4a17f29d03d3d0bb084e48d356b049cd22a3f55cbe99578e565eb5e83254cbc`.
- Demangled `FlipIssuance::mint` callback is instruction-identical (177 WAT
  lines). `DelegationSnapshot::distribute` has 2,263 lines differing only in
  ten panic-location addresses. `update_block_emissions` has 204 lines; its
  differences are logging globals, string addresses and source locations,
  not emission arithmetic. The initialization code retains the modulo-150
  update before the author mint/distribution path and the same emission
  storage keys. The inspected author-mint path differs in diagnostic/data
  addresses, not amount arithmetic or control flow. This is a focused
  emission-path review, not an audit of the entire runtime.
- Independently decoded actual `flip.FlipMinted` events at blocks 14,518,569,
  14,518,570, 14,518,649, 14,518,650, 14,518,651, 14,619,299, 14,619,300 and
  14,619,301. All eight sums equal `cf_authority_emission_per_block` at the
  same block, including the newly compounded rate on boundary blocks.
  Example: 14,518,649 minted **665644182293973388** atomic FLIP; 14,518,650
  minted **665644916863582275**. Delegation produced between 1 and 100 mint
  events per sampled block; summing all recipients is required.

The production reader accepts 20210 only when `state_getStorageHash` matches
that exact reviewed code hash. Unreviewed versions or different 20210 code
fail closed. Such days remain gaps but do not prevent later reviewed days
from backfilling. Network failures stop the current run and resume next time.
References: [emissions implementation](https://github.com/chainflip-io/chainflip-backend/blob/2.2.14/state-chain/pallets/cf-emissions/src/lib.rs),
[delegation implementation](https://github.com/chainflip-io/chainflip-backend/blob/2.2.14/state-chain/pallets/cf-validator/src/delegation.rs).

## Initial August–September delivery status (superseded above)

- Public `/protocol-fee-comparison` is a provider-free read model.
- Independent systemd collector starts two minutes after timer activation,
  then runs at 00:20/06:20/12:20/18:20 UTC. It uses `source_observations` for
  resumable raw acquisition and `api_read_models` for monthly publication;
  existing migration 061 supplies the observation table, no new schema needed.
- DUNE_API_KEY is required for ongoing wallet attribution. Local environment
  has no key; local cache was seeded with 48 genuine rows from execution
  `01M2TCJ5Y87HFX9G7W02WGR480`, August 1–September 17. This does **not** enable
  automatic future local Dune updates. Production is configured to use its
  existing server-owned key; no production execution was performed here.
- Local cache: `node_modules/.cache/protocol-fee-comparison/state.json`.
  Vite reader uses `/__protocol-fee-comparison`; its server-owned background
  job runs on a six-hour cadence, never in response to visitor GETs.
- Current preview is port **5184**, process launched in this checkout. Port
  5173 belongs to the unrelated swapkit-widget worktree; do not stop it.
- Public-page HTML required an explicit opt-in on shared provider transport;
  default API challenge handling and cf-mitigated rejection are unchanged.
- Complete local source coverage now spans August 1–September 17: 31 August
  days and 17 September days for every series. September is explicitly partial.
  The local snapshot remains marked source-delayed because Dune is not
  configured for its next automatic refresh.
- Public reads age snapshots: incomplete prior months become unavailable
  instead of being mistaken for complete historical months. All rows retain
  source coverage; real zeros and signed Midgard residuals survive. Failed
  acquisition preserves the last verified observations and published snapshot.
- ECharts uses grouped signed bars on one USD axis, square tooltip swatches,
  legend toggles, partial-month styling and an accessible monthly-data table.
  Verified in the browser at desktop and 390px mobile widths.
- Focused accounting/archive/transport/lifecycle tests and complete test
  suites pass. Production build passes; Svelte has zero errors and the existing
  56 warnings. The lazy ECharts chunk triggers Vite's 500 kB size advisory.
- Deployment instructions and the Dune SQL are versioned alongside the code.
  No new DB migration is needed. **Not deployed or committed.** Configure the
  local server-only Dune key (or deploy with the existing production key) for
  ongoing wallet acquisition. Deploy backend before the frontend.
# Production rollout preparation — September 18, 2026

- Financials now uses lazy-loaded ECharts in production, not the dev-only
  comparison switch. Shared range/currency/legend/zoom controls and colored
  tooltip squares are retained; the unused Financials Chart.js renderer is
  removed. Other dashboards are unchanged.
- The release includes a provider-free, insert-only bootstrap tool at
  `backend/scripts/seed-protocol-fee-comparison.mjs`. Seed the existing database
  before deploying the new timer; import acquisition checkpoints and the public
  snapshot atomically. Existing production data or a running collector aborts
  the import. Source timestamps, gaps, and modeled-NEAR labels survive.
- Validated local snapshot: observed September 18 at 15:34:36 UTC, through
  September 17; 382 source days, 383 CF boundaries, 201 NEAR epoch checkpoints,
  52 verified CF issuance days. Full-year CF/NEAR issuance remains unfinished.
- Deployment health checks now explicitly include `protocol-fee-comparison`.
