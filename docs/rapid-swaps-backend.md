# Rapid Swaps Backend

## Scope
This backend records recently completed rapid swaps from Midgard and exposes:
- `rapid-swaps` (public GET)
- `rapid-swaps-scheduler` (internal POST, service-role guarded)

The scheduler scans the latest Midgard swap-action pages every run, filters swaps where the effective streaming interval is `0`, and stores them for the dashboard.

## Required Environment Variables
Supabase function secrets:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NODEOP_SCHEDULER_SECRET` (optional extra guard, reused by the scheduler workflow)
- `RAPID_SWAPS_MAX_PAGES` (optional, defaults to `20`)

Frontend runtime/build env:
- `VITE_RAPID_SWAPS_API_BASE=https://<project>.supabase.co/functions/v1`
- `VITE_RAPID_SWAPS_API_KEY=<anon-key>`

If you already expose the Node Operator backend with `VITE_NODEOP_API_BASE` and `VITE_NODEOP_API_KEY`, the Rapid Swaps page can reuse those same values.

## Database Setup
Run these migrations in order:
1. `supabase/migrations/001_nodeop_schema.sql`
2. `supabase/migrations/002_nodeop_indexes_retention.sql`
3. `supabase/migrations/003_rapid_swaps_schema.sql`

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
- The recorder uses the most recent Midgard swap pages, so history starts when the scheduler begins running.
- USD sizing is estimated from the current THORNode pool prices captured during each scheduler run.
