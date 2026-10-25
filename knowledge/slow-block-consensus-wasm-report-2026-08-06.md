# THORChain Slow-Block Consensus and Wasm Report

> Analysis date: 2026-08-06  
> Scope: Three observed THORChain windows containing block intervals over 10 seconds  
> Threshold: `interval_ms > 10000`

## Executive summary

Across all three windows, every interval over 10 seconds corresponded to a
consensus round change in the preceding workload block. None of the observed
slow intervals was merely a long round-0 block. The common mechanism was that
round 0 did not commit before its timeout; another proposer then completed the
height in round 1, or in two cases during the latest window, round 2.

The strongest stable signal was proposer-slot identity, not one universal Wasm
workload:

- In the first, highest-incidence hour, nodes `...maya` and `...9tcy` each
  occupied six timed-out round-0 proposer slots. Both were absent from all six
  eventual commits. Their failures repeated exactly every 95 blocks.
- In the second hour, node `...69mz` occupied four timed-out slots and never
  committed the eventual block: it was absent twice and voted nil twice.
- In the final two-hour window, failures were much more distributed. Nodes
  `...alas`, `...eqa0`, and `...zldh` led with five, four, and three round-0
  timeouts, but most timed-out proposers later signed the committed block.

Wasm was a plausible load amplifier, but its position and composition changed:

- Window A had elevated Wasm/Calc work in blocks immediately preceding the
  timed-out heights, while the two repeating absent proposers dominated the
  incident count.
- Window B had the strongest Wasm and FIN concentration inside the timed-out
  workload blocks themselves, including recurring order replacement activity.
- Window C again had elevated predecessor Calc/Wasm work, while the timed-out
  blocks were lighter and contained no FIN order create/retract activity.

No observed window showed a direct public-Arb flood or an order-placement and
cancellation burst that uniquely tracked the slow blocks. The FIN order owner
`...7qy0w` was a standing market-making caller across normal and slow blocks;
when it was active, its per-block replacement intensity was similar in both.

The best-supported interpretation is therefore:

1. proposer or validator performance/connectivity determines whether a height
   misses round 0;
2. heavier Thornode-side Wasm/Calc execution can expose marginal nodes and
   increase the chance of a miss;
3. Wasm load is neither necessary nor sufficient, because the same recurring
   nodes also failed after light blocks, and normal blocks often processed
   heavier Wasm workloads without changing rounds.

## Windows compared

| Window | UTC bounds | Header heights | Headers | >10s | Rate | Mean | P50 | P95 | Max |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A: high-incidence hour | 2026-08-05 20:10–21:10 | 27,306,971–27,307,520 | 550 | 30 | 5.45% | 6.553s | 6.139s | 10.753s | 17.768s |
| B: later hour | 2026-08-06 01:48:56–02:48:56 | 27,310,167–27,310,740 | 574 | 7 | 1.22% | 6.257s | 6.098s | 6.674s | 11.613s |
| C: latest two hours | 2026-08-06 10:50:41–12:50:41 | 27,315,314–27,316,437 | 1,124 | 25 | 2.22% | 6.341s | 6.097s | 7.093s | 19.282s |

Windows B and C are frozen ingestion snapshots. At query time their latest
stored headers were respectively 12 seconds and about 75 seconds behind the
database clock. Later-arriving headers are intentionally excluded so the
reported figures match the blocks originally examined.

## Methodology

### Interval attribution

For a charted interval at endpoint height `E`:

- `E - 1` is the causal consensus/workload height;
- `E - 2` is the immediately preceding workload block.

This offset matters because the header timestamp at `E` reflects completion of
the preceding height. Looking only at block `E` would inspect activity after
the delay.

### Proposer attribution

For every causal height `H = E - 1`:

- the committed round came from RPC `/commit?height=H`;
- the scheduled round-0 proposer came from the highest proposer priority in
  the validator set at `H - 1`;
- the block header proposer was treated as the successful rescue proposer when
  the block committed after round 0;
- the scheduled proposer's signature in the final commit was classified as
  commit, nil, or absent.

This avoids blaming the proposer recorded in a round-1 block header. That node
usually rescued the height rather than caused the initial timeout.

### Wasm comparison

RPC `block_results` supplied transaction gas and events for each causal block
and predecessor. Each window also used a deterministic sample of 200 normal
predecessor blocks from the same period, excluding the selected slow pairs.

Metrics include:

- top-level `MsgExecuteContract` transactions and messages;
- transaction gas for transactions containing Wasm execution;
- nested `execute` events;
- Calc strategy events;
- FIN trade, arb, range, order-create, and order-retract events;
- scheduled finalize-block execution counts and emitted FIN events.

Transaction gas does not expose a separate gas figure for scheduled
finalize-block Wasm. Scheduled work is therefore compared by execution/event
count, not by an invented gas estimate.

## Consensus findings

### Window A: 30 round-1 blocks, two persistent absent proposers

All 30 causal blocks committed in round 1. Sixteen nodes occupied the timed-out
round-0 proposer slots, but two accounted for 40% of the total:

| Round-0 proposer | Timed-out slots | Eventual final-commit votes |
|---|---:|---|
| Node `...maya` | 6 | 6 absent |
| Node `...9tcy` | 6 | 6 absent |
| Node `...alas` | 4 | 3 commit, 1 absent |
| Node `...40qp` | 2 | 1 commit, 1 nil |
| Twelve other nodes | 12 | 10 commit, 1 nil, 1 absent |

Nodes `...maya` and `...9tcy` recurred on exact 95-block spacing, matching the
active-validator rotation. Their complete absence from the eventual commits is
the strongest node-specific failure pattern in the three samples.

Across all 30 scheduled round-0 proposers, the eventual vote distribution was
14 commits, 2 nil votes, and 14 absences.

### Window B: one dominant proposer that never committed

All seven causal blocks committed in round 1:

| Round-0 proposer | Timed-out slots | Eventual final-commit votes |
|---|---:|---|
| Node `...69mz` | 4 | 2 nil, 2 absent |
| Node `...fwle` | 2 | 2 commit |
| Node `...eqa0` | 1 | 1 commit |

Node `...69mz` was the clear persistent offender. Its four failures were
separated by multiples of the 95-validator rotation, and it never signed the
eventual committed block. Nodes `...fwle` and `...eqa0` recovered and signed
the round-1 result, so their evidence is consistent with a delayed proposal or
round-0 propagation/quorum failure rather than being fully offline.

### Window C: broader distribution and two round-2 heights

Twenty-three causal blocks committed in round 1 and two in round 2, producing
27 timed-out proposer rounds. Round-0 timeouts were distributed as follows:

| Round-0 proposer | Timed-out slots | Eventual final-commit votes |
|---|---:|---|
| Node `...alas` | 5 | 3 commit, 1 nil, 1 absent |
| Node `...eqa0` | 4 | 2 commit, 2 nil |
| Node `...zldh` | 3 | 3 commit |
| Node `...pxsu` | 2 | 1 commit, 1 absent |
| Node `...ahem` | 2 | 2 commit |
| Node `...fwle` | 2 | 1 commit, 1 nil |
| Seven other nodes | 7 | 5 commit, 2 nil |

The two round-2 blocks also timed out at their intermediate round-1 proposer
slots, associated with nodes `...plcw` and `...fsex`. One voted nil and the
other committed the eventual block.

Across all 27 timed-out proposer rounds, the eventual vote distribution was 18
commits, 7 nil votes, and 2 absences. The high commit share distinguishes this
window from A and from node `...69mz` in B: most affected validators were
reachable and recovered.

## Wasm and FIN findings

### Comparable per-block metrics

| Window and cohort | Mean Wasm gas | Median Wasm gas | Nested executes | Calc events | FIN events |
|---|---:|---:|---:|---:|---:|
| A causal slow blocks | 14.56M | 11.20M | 11.57 | 7.20 | 5.87 |
| A predecessors | 32.40M | 14.78M | 12.33 | 8.37 | 3.77 |
| A normal controls | 13.26M | 8.02M | 9.09 | 5.66 | 3.65 |
| B causal slow blocks | 31.92M | 20.57M | 16.57 | 10.14 | 6.00 |
| B predecessors | 23.70M | 12.06M | 10.29 | 6.43 | 2.43 |
| B normal controls | 12.28M | 7.28M | 10.22 | 6.43 | 3.17 |
| C causal slow blocks | 15.26M | 8.92M | 10.68 | 8.08 | 1.24 |
| C predecessors | 30.15M | 15.48M | 13.44 | 9.68 | 2.80 |
| C normal controls | 11.30M | 5.09M | 7.08 | 4.96 | 2.54 |

`Nested executes`, `Calc events`, and `FIN events` are means per block. FIN
includes transaction and finalize-block FIN events.

### Window A: predecessor load plus persistent absent nodes

Window A's causal blocks did not show a large Wasm-gas spike relative to normal
controls, but their predecessors did:

- 12 of 30 predecessors used at least 20M Wasm gas, versus 35 of 200 controls;
- 6 of 30 exceeded 50M, versus 9 of 200 controls;
- predecessor mean Wasm gas was 32.40M, about 2.4 times the control mean;
- predecessor Calc activity averaged 8.37 events, versus 5.66 in controls.

The causal blocks carried much more total transaction traffic than controls
(19.63 versus 12.40 transactions per block), but their mean Wasm gas was only
modestly higher. FIN activity was elevated, including 42 order create/retract
events across 11 of 30 causal blocks. Normal controls had 240 such events
across 57 of 200 blocks. Conditional on an order-active block, the causal
blocks were not more intense: 3.82 order events per active block versus 4.21
in controls.

All 42 causal-block order events came from the standing owner `...7qy0w`.
Scheduled execution remained routine: five `arb` starts per block, with a
periodic `run` batch also represented in both selected and control data.

Interpretation: heavier predecessor work could have amplified lag, but the
exact 95-block recurrence and complete commit absence of nodes `...maya` and
`...9tcy` are substantially stronger than the Wasm association.

### Window B: strongest in-block Wasm and FIN association

Window B was the only sample where the causal slow blocks themselves were
clearly heavier than both their predecessors and normal controls:

- mean Wasm gas was 31.92M, versus 12.28M in controls;
- median Wasm gas was 20.57M, versus 7.28M in controls;
- FIN activity averaged 6.00 events per causal block, versus 3.17 in controls;
- direct calls consisted of 7 Calc executor calls, 7 FIN order calls, and 3
  direct public-Arb calls;
- FIN outcomes included 13 order retracts, 9 order creates, 12 trades, and 5
  arb events.

Four of seven causal blocks contained order activity, compared with 59 of 200
normal controls. That apparent concentration was not a per-call burst: the
selected and control order-active blocks both averaged about 5.5 order events.
All 22 selected create/retract events came from owner `...7qy0w`, which also
produced 322 of 323 control order events.

The order messages replaced existing quote/base orders by zeroing old amounts
and creating new fixed-price amounts in the same call. This is consistent with
a continuously operating market-making bot. It is not, by itself, evidence of
a one-hour order griefing attack.

Node `...69mz` also failed under workloads ranging from 9M Wasm gas with no FIN
activity to 42.6M with substantial order work. Wasm therefore increased the
plausibility of execution pressure but did not explain the node's persistent
failure.

### Window C: predecessor Calc enrichment without order activity

The latest window again placed the stronger Wasm signal in predecessors, not
the causal slow blocks:

- 11 of 25 predecessors used at least 20M Wasm gas, versus 30 of 200 controls;
- 6 of 25 exceeded 50M, versus 9 of 200 controls;
- predecessor median Wasm gas was 15.48M, versus 5.09M in controls;
- predecessor Calc activity averaged 9.68 events, versus 4.96 in controls.

The causal blocks contained 28 top-level Wasm messages: 24 Calc executor
calls, 2 direct `arb` calls in the same block, 1 range creation, and 1
multi-stage swap with affiliate code `arb`. Nested calls were overwhelmingly
Calc scheduling: 36 scheduler creates and 2 FIN swaps.

There were no FIN order-create or order-retract events in either the 25 causal
blocks or their 25 immediate predecessors. Scheduled work was identical in the
two cohorts: 125 routine `arb` starts plus five periodic `run` starts.

The two longest intervals illustrate why Wasm is not a complete explanation:

- the 18.843-second event followed only 10.5M of predecessor Wasm gas and had
  no FIN activity;
- the 19.282-second event followed a 101.8M-gas predecessor, but that
  predecessor's FIN activity was slightly heavier than the causal block's.

The leading repeated proposers also did not require heavy predecessor work.
Node `...alas` averaged only 9.5M predecessor Wasm gas across five timeouts,
and node `...eqa0` averaged 2.3M across four.

## Cross-window interpretation

### What remained constant

- Every >10-second interval mapped to a consensus round change.
- Failed proposer slots repeated at exact multiples of the 95-validator
  rotation when the same node recurred.
- The header proposer on the committed block was a rescue proposer and signed
  the eventual commit; it should not be labeled as the failed proposer.
- Five scheduled EndBlock `arb` executions per block were routine baseline
  behavior rather than a slow-block-specific surge.
- Heavy Wasm blocks also committed normally elsewhere in every window.

### What changed

- The slow-block rate moved from 5.45% to 1.22%, then to 2.22%.
- The first hour had two consistently absent proposer nodes; the second had one
  node that was always nil or absent; the latest window was broadly distributed
  and usually recovered by the final commit.
- Wasm pressure appeared mainly in predecessors in A and C, but inside the
  causal workload blocks in B.
- FIN order activity was present in A, concentrated in B, and absent in C.

### Most likely model

The evidence fits a layered failure model:

1. **Node-specific susceptibility.** Connectivity, hardware, storage, process
   scheduling, or local application lag makes some validators more likely to
   miss their proposer round.
2. **Thornode-side load amplification.** Calc/Wasm work can increase the amount
   of deterministic application processing a validator must complete. It may
   expose slower nodes, particularly when the preceding block is heavy.
3. **Consensus recovery.** The remaining validators advance rounds and commit
   with the next proposer. In later windows, the timed-out node often rejoins
   and signs the eventual block.

This model is compatible with observed CometBFT and Thornode behavior without
requiring Bifrost TSS to hold up block production. Bifrost performs TSS and
submits results to Thornode; Wasm execution and CometBFT consensus both occur
on Thornode. TSS-related transactions may share a block but are not evidence
that Bifrost caused its consensus delay.

## Security assessment

The observations do not demonstrate an active Wasm, FIN-order, or public-Arb
denial-of-service attack:

- no window contained sustained direct public-Arb call volume;
- the order caller was present throughout normal blocks at comparable active-
  block intensity;
- order activity disappeared entirely from Window C while slow blocks
  continued;
- the most persistent proposer failures occurred under both heavy and light
  Wasm workloads.

They do show that permissionless Wasm workload can plausibly amplify existing
validator performance differences. That is a defensible hardening concern even
without evidence that the sampled activity was malicious. Useful follow-up
work would measure per-validator `FinalizeBlock`, Wasm VM, proposal, prevote,
and precommit timings around these exact heights and compare them with CPU,
storage latency, and peer propagation.

## Confidence and limitations

High confidence:

- interval counts and timing statistics from BooneTools headers;
- committed rounds, final proposers, and signatures from canonical RPC;
- Wasm transaction gas and emitted contract events;
- the recurring 95-block proposer-slot pattern.

Moderate confidence:

- attribution of a timed-out round to its scheduled proposer slot;
- interpretation of predecessor Wasm as a lag amplifier;
- inference of the intermediate proposer on the two round-2 blocks.

Not established by this analysis:

- whether a round-0 proposer failed to broadcast, broadcast too late, or had
  its proposal rejected or propagated too slowly;
- whether other validators were slow to execute or vote on a valid proposal;
- the exact wall-clock time spent inside individual Wasm contracts;
- malicious intent by any caller or node operator.

Resolving those questions requires synchronized logs and performance metrics
from the scheduled proposer and several peers at the exact heights.

## Sources and reproducibility

- BooneTools production PostgreSQL `chain_block_headers` supplied frozen
  header heights, timestamps, and `interval_ms`.
- Liquify THORChain RPC supplied `/block`, `/commit`, `/validators`, and
  `/block_results` at the listed heights.
- Liquify THORNode API `/thorchain/nodes` mapped consensus public keys to node
  addresses and active status.
- No Nine Realms endpoints were used.

Slow interval endpoint heights:

- Window A: `27306999`, `27307001`, `27307010`, `27307013`, `27307045`,
  `27307049`, `27307087`, `27307094`, `27307096`, `27307109`, `27307159`,
  `27307180`, `27307189`, `27307191`, `27307284`, `27307286`, `27307298`,
  `27307307`, `27307324`, `27307345`, `27307349`, `27307352`, `27307369`,
  `27307379`, `27307381`, `27307393`, `27307422`, `27307474`, `27307476`,
  `27307488`.
- Window B: `27310222`, `27310317`, `27310412`, `27310430`, `27310488`,
  `27310697`, `27310715`.
- Window C: `27315350`, `27315373`, `27315444`, `27315610`, `27315618`,
  `27315658`, `27315731`, `27315749`, `27315753`, `27315824`, `27315882`,
  `27315940`, `27315998`, `27316038`, `27316050`, `27316145`, `27316180`,
  `27316204`, `27316209`, `27316229`, `27316263`, `27316283`, `27316320`,
  `27316378`, `27316418`.
