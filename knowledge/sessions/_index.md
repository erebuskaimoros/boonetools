# Sessions Index

## Recent Sessions

| Session | Focus | Summary | Path |
|---|---|---|---|
| 2026-04-02 #1 | Rapid Swaps Backfill, Catch-Up Hardening, and Local-Time Frontend | Backfilled missed rapid swaps, fixed the canonical scan cursor loss bug, and aligned Rapid Swaps charts/tables around local frontend time. | `sessions/2026-04-02/session-1.md` |
| 2026-04-01 #1 | BooneTools Hetzner Backend Cutover + Live Deploy | Replaced the Supabase runtime path with a Hetzner-hosted Postgres/API stack, cut `boone.tools` over to `/functions/v1`, and brought the new listener and timers live. | `sessions/2026-04-01/session-1.md` |
| 2026-03-31 #4 | Rapid Swaps Backend Reconciliation Hardening + Deploy | Replaced one-shot listener ingestion with durable reconciliation plus canonical catch-up scanning, then deployed the backend and listener. | `sessions/2026-03-31/session-4.md` |
| 2026-03-31 #3 | Bond Tracker Block-Aware APY Refinement + Frontend Deploy | Replaced the APY full-interval clamp with block-progress estimation, kept an early-block floor, and deployed the static site. | `sessions/2026-03-31/session-3.md` |
| 2026-03-31 #2 | Bond Tracker APY Churn Smoothing + Frontend Deploy | Smoothed fresh-churn APY estimates in Bond Tracker, added regression tests, and deployed the static site. | `sessions/2026-03-31/session-2.md` |

## Current Work In Progress

- Observe the live Hetzner backend after the rapid-swaps catch-up hardening/local-time rollout, then retire the remaining Supabase rollback path once the observation window closes cleanly.
