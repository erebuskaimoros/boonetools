# Liquify WebSocket Consolidation

## Scope decision

The August 2026 site-wide census found 26 canonical user-facing data flows:

- 2 can be supplied completely by durable websocket-derived data.
- 16 are hybrid: websocket events improve freshness or invalidate a cached
  model, but REST, Midgard, Dune, market data, or wallet state remains the
  authoritative hydration path.
- 8 are unrelated to THORChain block events.

At the acquisition layer, a consolidated parser can influence 20 of the 22
backend pipelines, but it must not be presented as the sole source for those
hybrid datasets.

## Shipped topology

`boonetools-chain-stream-listener.service` owns one Liquify `NewBlock`
subscription plus the existing narrow `set_node_mimir` transaction
subscription. The full block payload feeds five payload-complete live lanes:

1. Raw block headers and one interval per height.
2. ADR26's live block/epoch clock.
3. Node-vote events.
4. Rujira Base Layer collector -> Reserve events.
5. Rujira-generated base-fee events.

The same parser retains the existing Rapid Swap hint lane and emits a compact
`has_swap_events` invalidation hint for Limit Orders. It replaces the three
former full-block backend connections and both direct browser connections.

## Durability and replay

Migration `043_chain_block_headers.sql` stores headers by height, derives an
interval only when height `H - 1` exists, and retains 48 hours. The listener
bootstraps roughly 24 hours, scans the retained range for missing heights every
five minutes, repairs gaps through bounded 20-header Liquify RPC pages, and
recomputes the repaired height plus its successor.

`GET /functions/v1/block-production` serves compact tuples for an initial
24-hour replay and accepts `after_height` for incremental healing. The API
process relays committed heads through `GET /functions/v1/chain-events` as
same-origin server-sent events. PostgreSQL `LISTEN/NOTIFY` keeps ingestion and
public connections process-isolated; EventSource reconnect plus incremental
HTTP replay makes delivery recoverable rather than best-effort.

## Consumer behavior

- Status renders every block as one SVG path, with a single hover marker and
  client-side range zoom. It does not create a DOM node per block. The old
  five-minute series remains a fallback in the materialized status payload.
- ADR26 advances its epoch clock from the site-owned head stream.
- Limit Orders refreshes authoritative models when a head carries the swap
  hint and keeps its 20-second reconciliation poll.
- Rujira base-fee parsing uses `result_finalize_block.tx_results` and events
  directly; it no longer fetches `/block_results` for every live height.
- Historical/canonical Rujira, node-vote, and Rapid reconciliation jobs remain
  in place for missed events, provenance, and provider-independent validation.

The parser is an event backbone, not a universal analytics database. Pool
depths, prices, wallet-specific state, quotes, historical aggregates, and
third-party market data must continue to use their authoritative lanes.
