# Session 2 - Generated Fee Head Catch-Up and Production Deployment

> Date: 2026-08-02
> Focus: Restore current App Layer generated-fee ingestion and deploy the provider cleanup

## Summary

Added a durable Midgard live-head catch-up cursor so App Layer generated-fee lane 03 can recover recent gaps independently of its long historical backfill. Verified the full BooneTools test and build surface, then deployed this recovery together with the removal of deprecated THORChain provider fallbacks.

## Work Done

- Separated generated-fee head refresh, head catch-up, and historical backfill into independently tracked ingestion lanes.
- Anchored a new head catch-up to the highest locally known action, fetched block, or fee-event height so recent outages close without resetting historical progress.
- Reused the first head page as historical page one on a fresh database and preserved both cursors when a provider request fails.
- Exposed head catch-up progress in the Base Layer fee payload and documented the new provider behavior.
- Verified that Liquify's REST RPC serves current status and historical THORChain blocks.
- Confirmed the earlier `rpc.thorchain.network` failure was a deprecated fallback transport failure with a 60-second local circuit-breaker cooldown, not a Liquify HTTP 429 rate limit.
- Ran 226 backend tests, 178 frontend tests, repository checks, Svelte diagnostics, and the production frontend build.
- Deployed the resulting production release and verified its Liquify-backed services and read models.

## Discoveries

- A historical Midgard cursor cannot also provide live-head freshness: a separate durable head-tail cursor is required while the historical scan remains incomplete.
- Incomplete Wasm economics buckets currently render as zero, which can make a fresh production backfill look like genuine zero activity before the earliest populated bucket.
- Provider circuit-breaker records distinguish rate limiting from transport failures: HTTP 429-class failures receive the long rate-limit cooldown, while generic `fetch failed` errors receive the short failure cooldown.
- Liquify's supported RPC gateway is `https://gateway.liquify.com/chain/thorchain_rpc`; deprecated `*.thorchain.network` hosts must not remain as implicit fallbacks.

## Files Changed

| File | Change |
|------|--------|
| `backend/.env.example` | Documented the independent generated-fee head-page budget |
| `backend/src/lib/config.js` | Added the generated-fee live-head catch-up limit |
| `backend/src/shared/rujira-base-fees.js` | Added durable head refresh/catch-up alongside historical paging and exposed its health metadata |
| `backend/tests/rujira-base-fees.test.js` | Covered independent cursors, resume behavior, first-run reuse, failure preservation, and payload metadata |
| `docs/ss-dynamic-fee-impact.md` | Added the deployed-version caveat for interpreting ADR-026 behavior |
| `knowledge/sessions/2026-08-02/session-2.md` | Recorded the recovery and deployment session |
| `knowledge/sessions/_index.md` | Updated current work and recent session history |

## In Progress

Production catch-up is active. Lane 03, Wasm action/fee history, and pool/oracle history still need source-watermark monitoring until their backfills report complete.

## Next Steps

- [ ] Confirm generated-fee head catch-up reaches the pre-outage floor and lane 03 resumes advancing with chain head.
- [ ] Make WebSocket listener health require a subscription acknowledgment or first block rather than socket open alone.
- [ ] Make dashboard freshness depend on source height/time and visually distinguish incomplete Wasm buckets from true zeroes.
- [ ] Restore Dune capacity or reduce query usage for generated-fee query 7620091.
- [ ] Monitor Liquify provider health and add only explicitly verified alternatives when required.
