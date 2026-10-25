# THORChain slow blocks — September 24, 2026

Queried Liquify directly. Header analysis ends at height **27,969,283**, September 24 **18:45:20 UTC / 14:45:20 EDT**. A fresh node/status check at **18:52 UTC / 14:52 EDT** found the same ten affected validators.

The dominant cause is repeated consensus proposer timeouts involving ten validators that remain active but are failing to sign. All 900 intervals over 10 seconds during the measured EDT day correspond to a commit in round 1 or 2. Of those, 784 (87.1%) began on one of these ten validators’ round-0 proposer slots, and the scheduled proposer was absent from the eventual commit in every one of those 784 cases.

Public chain data establishes the consensus failure mechanism. It does not establish whether each validator stopped participating because of a process crash, resource exhaustion, networking, or another operator-side problem.

## Measurements

“Today” means interval endpoints from September 24 00:00 EDT (04:00 UTC) through the frozen header snapshot. The larger comparison window contains 16,200 contiguous intervals from September 23 12:42 UTC.

| Measure | Result |
|---|---:|
| Intervals today | 7,816 |
| Mean interval today | 6.796 seconds |
| Median interval today | 6.122 seconds |
| Mean for intervals at most 10 seconds | 6.195 seconds |
| Intervals over 10 seconds | 900 / 11.51% |
| Round-1 slow intervals | 813; mean 10.880 seconds |
| Round-2 slow intervals | 87; mean 16.470 seconds |
| Maximum today in EDT | 17.183 seconds |
| September 23 13:00–14:00 UTC baseline | 6.246-second mean; 5/577 over 10 seconds |
| September 24 17:00–18:00 UTC | 6.853-second mean; 64/525 over 10 seconds |

The main deterioration was already visible yesterday afternoon EDT: the hourly mean rose from 6.43 seconds at 14:00 EDT to 6.56 at 15:00, 6.68 at 16:00, and 6.79 at 17:00. It persisted overnight.

## Affected validators

All 99 active validators reported version 3.20.3. These ten each reported `missing_blocks = 700`; the published `MaxTrackMissingBlock` constant is 700. Each has equal voting power of 100 and remains in the active consensus set.

| Node | Slow round-0 slots today | Signature in those final commits |
|---|---:|---|
| `...40qp` | 79 | Absent in all 79 |
| `...496v` | 79 | Absent in all 79 |
| `...7v3h` | 79 | Absent in all 79 |
| `...fsex` | 79 | Absent in all 79 |
| `...j53w` | 79 | Absent in all 79 |
| `...kfun` | 79 | Absent in all 79 |
| `...lulz` | 73 | Absent in all 73 |
| `...plcw` | 79 | Absent in all 79 |
| `...z4lt` | 79 | Absent in all 79 |
| `...zldh` | 79 | Absent in all 79 |

Nine of these validators were absent from every one of the 971 inspected commits during the EDT day. Node `...lulz` still signed some early commits; its last signature in the inspected sample precedes the interval ending at 05:07:07 UTC (01:07 EDT), after which it was consistently absent in the inspected sample. These are sampled participation observations, not exact shutdown timestamps.

The round-0 proposer schedule repeats every 99 blocks. A missing proposer therefore repeatedly adds a timeout even though sufficient other validators remain to finalize the chain. Consecutive slots belonging to two of these missing validators account for 79 of the 87 round-2 delays. Other intermittent proposers account for the remaining 116 slow intervals.

## Workload cross-check

Twenty evenly spaced blocks in each of four hours were decoded, with corresponding transaction gas and results. There is increased activity, but no comparable increase in top-level Wasm call count:

| Hour UTC | Blocks sampled | Wasm messages | Keysign-failure messages | Observed-transaction quorum messages |
|---|---:|---:|---:|---:|
| Sep 23 13:00 | 20 | 33 | 93 | 9 |
| Sep 23 19:00 | 20 | 30 | 45 | 49 |
| Sep 24 01:00 | 20 | 34 | 201 | 163 |
| Sep 24 17:00 | 20 | 31 | 259 | 630 |

Failed Wasm calls and expensive individual arbitrage executions were present, including a 532.5-million-gas failed Wasm call in height 27,969,000. That height nevertheless committed in round 0. Gas and message counts do not measure wall-clock execution time and cannot exclude load as a contributor to individual nodes’ trouble. The strongest evidence for the recurring delays is the scheduled proposer absence, not a universal workload threshold.

## Method and direct evidence

- Retrieved contiguous headers using Liquify `/blockchain` in batches of 20; verified there were no height gaps.
- For interval endpoint E, inspected consensus at H = E − 1 using `/block?height=E` → `last_commit`. The adjacent block carries the historical commit even when the gateway’s historical `/commit` request returns HTTP 500.
- The validator-set hash was identical across all 16,201 headers. All 99 validators had equal power. Reconstructed the 99-slot proposer cycle from historical proposer priorities at height 27,968,999, breaking equal priorities by ascending consensus address.
- Validated the reconstructed round-0 schedule plus the committed round against the recorded successful proposer for **all 1,634 inspected heights**: all 1,484 slow intervals in the larger window plus 150 deterministic normal controls. Every slow interval committed in round 1 or 2; every normal control committed in round 0.
- Mapped Ed25519 consensus public keys from `/thorchain/nodes` to consensus addresses and verified all 99 mappings against the RPC validator set. Absent signature entries were attributed by validator index, not by their empty address field.
- The successful proposer in a later-round block is the rescue proposer; it must not be blamed for the initial timeout.

Public source links:

- [Current THORNode nodes](https://gateway.liquify.com/chain/thorchain_api/thorchain/nodes)
- [Current constants](https://gateway.liquify.com/chain/thorchain_api/thorchain/constants)
- [Historical validator priorities](https://gateway.liquify.com/chain/thorchain_rpc/validators?height=27968999&per_page=100)
- [Round-1 example: block 27,969,271 carries commit 27,969,270](https://gateway.liquify.com/chain/thorchain_rpc/block?height=27969271)
- [Round-2 example: block 27,969,227 carries commit 27,969,226](https://gateway.liquify.com/chain/thorchain_rpc/block?height=27969227)
- [Results for round-0 block 27,969,000](https://gateway.liquify.com/chain/thorchain_rpc/block_results?height=27969000)

Local scratch responses and reproducible query scripts are retained at `/tmp/thorchain-slow-blocks-2026-09-24/`. The snapshot summaries and conclusions above do not depend on that temporary directory being retained.

## Follow-up: Rujira Virtualization Strategy connection

VS is a credible upstream hypothesis, not an established cause of the ten validators’ loss of participation. The original consensus findings identify the immediate delay mechanism; they do not rule out contract-driven work as the reason validators stopped participating. Similar top-level Wasm message counts cannot exclude changed work inside those calls or later base-layer queue processing.

### Verified deployment and behavior changes

The live VS contract is the `WasmArbContract` ending `...5t4g`.

- At **27,952,972**, **September 23 12:30:59 UTC / 08:30:59 EDT**, the contract migrated from code 184 / version 1.2.0 to **code 195 / version 1.2.1**.
- At **27,968,911**, **September 24 18:02:48 UTC / 14:02:48 EDT**, it migrated to **code 197 / version 1.2.2**.
- Historical raw CW2 `contract_info` queries immediately before and after both migration heights returned the corresponding version changes. Both the historical query parameter and `x-cosmos-block-height` header were supplied.
- Downloaded code 195 hashes to `0fd5c33cd6a6f1be1afe85059ba1c15f56ecbc5e34fb42ff099d6ec18c7236d4`, exactly matching the upstream 1.2.1 release checksum. Code 197 hashes to `5d694784ed5f3a6b6b16bedafeac1d509d128f3bdb5763364cce39277090fea5`, exactly matching the 1.2.2 release checksum. Source attribution therefore does not rely on the local checkout or version labels alone.
- **1.2.1 replaced quote-based settlement with a persistent THORChain limit swap**, using memo prefix `=<` and minimum output equal to the FIN payout plus the AMM fee. Its source explicitly leaves settlement queued until the return can be recovered or the limit expires.
- **1.2.2 restores quote-based settlement**, removing that limit-swap construction. The patch does not itself establish a CPU/memory fault or claim that it repairs validator participation.

### Queue evidence and its limit

A current Liquify queue observation during this follow-up returned **565 VS-originated pending limit swaps out of 621 total**, about **91%**. A returned example was created at height 27,953,648 and had 19 failed settlement attempts recorded. All four earlier 20-block samples contained successful VS executions that emitted `=<` settlement memos: 18, 4, 2, and 1 events respectively at September 23 13:00 and 19:00 UTC, and September 24 01:00 and 17:00 UTC.

These queue observations must **not** be treated as historical snapshots. The limit-swap REST endpoints ignored the requested historical heights even with both the query parameter and header: a request for height 27,952,971 returned a swap created at 27,953,648. The identical purported historical summaries were rejected. Thus this investigation has not quantified queue growth before/after the migration or execution time spent scanning/retrying it. A later attempt to fetch the complete current queue was rate-limited; no complete-queue retry/gas aggregate is claimed.

### Validator timing and counterevidence

Additional adjacent commits narrowed the last signed heights near each sustained dropout. Later participation remains based on the previously sampled commits; no operator shutdown timestamp is implied.

| Node | Last signed height near dropout | Following header time (EDT) |
|---|---:|---|
| `...7v3h` | 27,956,174 | Sep 23 14:09:10 |
| `...z4lt` | 27,956,275 | Sep 23 14:20:01 |
| `...40qp` | 27,956,662 | Sep 23 15:01:39 |
| `...496v` | 27,956,666 | Sep 23 15:02:05 |
| `...plcw` | 27,956,855 | Sep 23 15:22:22 |
| `...fsex` | 27,956,860 | Sep 23 15:22:54 |
| `...zldh` | 27,956,867 | Sep 23 15:23:41 |
| `...j53w` | 27,957,160 | Sep 23 15:55:55 |
| `...kfun` | 27,959,958 | Sep 23 21:10:34 |
| `...lulz` | 27,962,073 | Sep 24 01:07:45 |

The sequence follows the 1.2.1 migration and spans hours, which is compatible with a cumulative resource or queue problem, but timing alone does not prove that explanation. Some dropout-adjacent blocks contain VS swaps or VS-style `InsufficientReturn` failures. Several others contain no recorded VS execution and have modest transaction gas. There is no single identified VS call that explains all ten dropouts. Query-only calls and rolled-back internal calls are not fully visible in successful execution events, and public transaction gas is not validator CPU or memory usage.

The working hypothesis is **VS limit-settlement change → additional pending/retried base-layer work → validator trouble → proposer timeouts**. The first change and final timeouts are verified; the intermediate causal link needs affected-node execution logs or resource metrics. The earlier node snapshot, already after 1.2.2 deployed, still showed all ten nodes missing the 700-block tracking window; replacing the contract would not necessarily bring stalled nodes back into consensus automatically.

### Follow-up sources

- [VS migration history](https://gateway.liquify.com/chain/thorchain_api/cosmwasm/wasm/v1/contract/thor1n5a08r0zvmqca39ka2tgwlkjy9ugalutk7fjpzptfppqcccnat2ska5t4g/history)
- [1.2.1 source and checksums](https://gitlab.com/thorchain/rujira/-/commit/cb6abec81919904128d77805e068d26b236b4d58)
- [1.2.2 source and checksums](https://gitlab.com/thorchain/rujira/-/commit/e005143752bf925472826595b672b8a82ff70c35)
- [Current VS limit queue, small page with total](https://gateway.liquify.com/chain/thorchain_api/thorchain/queue/limit_swaps?sender=thor1n5a08r0zvmqca39ka2tgwlkjy9ugalutk7fjpzptfppqcccnat2ska5t4g&limit=5)
- [Current network limit queue summary](https://gateway.liquify.com/chain/thorchain_api/thorchain/queue/limit_swaps/summary)

## Gas and compute follow-up

The original gas check was limited to 80 sampled blocks across four hours plus dropout-adjacent blocks. A larger follow-up used **60 evenly spaced heights per window, 240 blocks total**, retrieving each block, its transaction results, and the following block’s commit. Every requested sample completed. A transient request timeout was retried using the existing response cache; no missing sample was substituted or silently omitted.

### Measured transaction gas

Gas below is the sum of reported `txs_results[].gas_used`, including failed transactions. “Wasm transaction gas” is the entire gas of transactions containing a **top-level** `MsgExecuteContract`, counted once per transaction. It is not isolated VS execution gas, and other transaction types can still invoke Wasm internally. All values in the last three columns are **millions of gas per sampled block**.

| Window | UTC bounds | Samples | Mean total tx gas | Median total tx gas | Mean Wasm tx gas |
|---|---|---:|---:|---:|---:|
| Before 1.2.1 | 2026-09-23T11:28:25 to 2026-09-23T12:30:51 | 60 | 40.18 | 27.99 | 24.24 |
| First hour of 1.2.1 | 2026-09-23T12:31:05 to 2026-09-23T13:33:25 | 60 | 33.35 | 21.33 | 11.66 |
| Last hour of 1.2.1 | 2026-09-24T16:54:07 to 2026-09-24T18:02:40 | 60 | 159.13 | 120.24 | 22.97 |
| First hour of 1.2.2 | 2026-09-24T18:02:59 to 2026-09-24T19:00:11 | 60 | 764.97 | 635.01 | 657.44 |

**Yesterday’s 1.2.1 migration did not coincide with a transaction-gas spike in these samples.** Mean total transaction gas fell 17.0%, and mean Wasm transaction gas fell 51.9%. Successful VS swap event counts were nearly unchanged (29 versus 28 in 60 blocks). That weakens an immediate Wasm transaction-compute spike as the explanation for the initial deterioration. It does not measure cumulative queue-processing costs.

**Today’s 1.2.2 migration has a strong gas discontinuity.** Mean Wasm transaction gas rose **28.62×**, from 22.97M to 657.44M per block; mean total transaction gas rose **4.81×**, from 159.13M to 764.97M. The number of top-level Wasm transactions rose from 89 to 110 across the respective 60-block windows, so transaction count alone does not explain the gas increase. The source change restores an internal THORChain swap-quote query; the timing and direction of the gas change are consistent with additional work on that path, but no per-contract execution trace or CPU profile was obtained.

In the post-1.2.2 sample, **81 transactions exceeded 100M gas; 79 of them failed** with Wasm code 5. Those 81 transactions accounted for **99.38%** of the sample’s Wasm transaction gas. Most high-gas transactions called the routing contract `...a6r5`; other high-gas transactions called FIN contracts. Failed transactions often report minimum-return errors and do not retain a full successful internal-event trace, so their entire gas must not be attributed specifically to VS.

The peak sampled block, **27,968,920 at 18:03:49 UTC**, used **3.086B total transaction gas**, of which **3.026B** was in Wasm transactions. Its five transactions over 100M gas all failed. Nevertheless that height committed in **round 0**, with a following header interval of **6.379 seconds**. Across round-0 samples, mean intervals were **6.166 seconds before 1.2.2 and 6.231 seconds after**. These are descriptive samples, not a controlled performance benchmark.

Before 1.2.2, the later gas increase was dominated by native protocol transactions: the last-hour sample averaged 79.98M gas in observed-transaction quorum messages, 31.01M in keysign-failure messages, and 15.33M in solvency-quorum messages per block. This differs from the post-1.2.2 Wasm-dominated gas mix.

### What remains unmeasured

- No validator CPU utilization, memory/RSS, garbage-collection pauses, disk I/O, process restarts, or per-stage execution time was obtained. Liquify’s public block results are not resource profiles of the affected validators.
- Transaction gas excludes a complete accounting of non-transaction end-of-block work. The pinned THORNode **v3.20.3** source runs the advanced swap queue from `AppModule.EndBlock`; its discovery, sorting, retries, and scheduled work are not separately reported as transaction gas in `block_results`.
- End-of-block event counts were collected as activity indicators, not converted into CPU time or gas. Successful-event counts do not measure all failed attempts or iterator work.
- The ten sustained validator dropouts preceded the 1.2.2 gas spike. This spike cannot explain when those dropouts began, although it is an additional workload concern after the later update. The claim that 1.2.1 queue/resource pressure caused their original failure remains unproven.

### Reproducible evidence

- [All 240 gas samples](slow-block-gas-samples-2026-09-24.csv)
- [Peak gas block results](https://gateway.liquify.com/chain/thorchain_rpc/block_results?height=27968920)
- [Following block carrying its round-0 commit](https://gateway.liquify.com/chain/thorchain_rpc/block?height=27968921)
- [THORNode v3.20.3 EndBlock ordering](https://gitlab.com/thorchain/thornode/-/blob/v3.20.3/x/thorchain/module.go#L223)
- [THORNode v3.20.3 advanced swap-queue loop](https://gitlab.com/thorchain/thornode/-/blob/v3.20.3/x/thorchain/manager_adv_swap_queue_current.go#L630)

The query/decoder and cached raw responses are retained in `/tmp/thorchain-slow-blocks-2026-09-24/gas-analysis.py` and the adjacent cache. The CSV preserves the complete compact sample independently of that temporary directory.
