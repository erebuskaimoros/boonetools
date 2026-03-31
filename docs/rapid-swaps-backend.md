# Rapid Swaps Backend

## Scope
This backend records recently completed rapid swaps and exposes:
- `rapid-swaps` (public GET)
- `rapid-swaps-scheduler` (internal POST, service-role guarded)

The current design has two ingestion paths:
- The WebSocket listener watches THORChain block events and writes durable rapid-swap completion hints to Supabase as soon as it sees a completed `streaming_swap` with `interval=0`.
- The scheduler is authoritative. Every run it resolves pending hints against THORNode + Midgard, then performs a canonical recent Midgard scan with height overlap and upserts completed rapid swaps.
- If the scheduler cannot scan back to its overlap floor in one run, it keeps a durable Midgard catch-up cursor and continues the older backlog on later runs while still rescanning the newest head pages for fresh completions.

This makes the system resilient to:
- Midgard tx hash mismatches vs Tendermint/THORNode tx ids
- Midgard indexing delays after on-chain completion
- Temporary listener downtime or WebSocket disconnects
- One-off listener lookup failures

## Required Environment Variables
Supabase function secrets:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NODEOP_SCHEDULER_SECRET` (optional extra guard, reused by the scheduler workflow)
- `RAPID_SWAPS_MAX_PAGES` (optional, defaults to `200`)
- `RAPID_SWAPS_CATCHUP_MAX_PAGES` (optional, defaults to `RAPID_SWAPS_MAX_PAGES`)
- `RAPID_SWAPS_HEIGHT_OVERLAP_BLOCKS` (optional, defaults to `1800`)
- `RAPID_SWAPS_MAX_CANDIDATE_ATTEMPTS` (optional, defaults to `12`)
- `RAPID_SWAPS_PENDING_CANDIDATE_BATCH` (optional, defaults to `100`)

Frontend runtime/build env:
- `VITE_RAPID_SWAPS_API_BASE=https://<project>.supabase.co/functions/v1`
- `VITE_RAPID_SWAPS_API_KEY=<anon-key>`

If you already expose the Node Operator backend with `VITE_NODEOP_API_BASE` and `VITE_NODEOP_API_KEY`, the Rapid Swaps page can reuse those same values.

## Database Setup
Run these migrations in order:
1. `supabase/migrations/001_nodeop_schema.sql`
2. `supabase/migrations/002_nodeop_indexes_retention.sql`
3. `supabase/migrations/003_rapid_swaps_schema.sql`
4. `supabase/migrations/004_rapid_swaps_blocks_used.sql`
5. `supabase/migrations/005_rapid_swaps_realtime.sql`
6. `supabase/migrations/006_bond_history.sql`
7. `supabase/migrations/007_bond_history_user_bond.sql`
8. `supabase/migrations/008_bond_history_rates.sql`
9. `supabase/migrations/009_rapid_swaps_ingestion_state.sql`

## Local Development
```bash
supabase start
supabase db reset
supabase functions serve rapid-swaps --no-verify-jwt
supabase functions serve rapid-swaps-scheduler
```

## Deploy
```bash
supabase db push
supabase functions deploy rapid-swaps --no-verify-jwt
supabase functions deploy rapid-swaps-scheduler
```

The existing deploy helper script now deploys these functions too:
```bash
npm run nodeop:deploy:backend
```

## Scheduler
Included workflow:
- `.github/workflows/rapid-swaps-scheduler.yml`

Required repository secrets:
- `RAPID_SWAPS_SCHEDULER_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NODEOP_SCHEDULER_SECRET` (optional)

Suggested cadence:
- Every 5 minutes

## Notes
- `rapid_swaps` stores the canonical completed rows used by the dashboard.
- `rapid_swap_candidates` stores unresolved listener hints so a failed live lookup does not mean a lost rapid swap.
- `rapid_swap_sync_state` tracks the canonical recent-scan watermark, lag state, and any saved catch-up cursor for backlog recovery.
- The recorder still starts with recent history, so preexisting historical gaps may require the one-off catchup script.
- USD sizing is estimated from the current THORNode pool prices captured during each scheduler run.
