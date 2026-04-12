# Sessions Index

## Recent Sessions

| Session | Focus | Summary | Path |
|---|---|---|---|
| 2026-04-12 #1 | Bond Tracker Zero-Row Cleanup for thor1fkd9... | Fixed false recent bond/unbond activity by purging invalid zero-value bond-history rows and redeploying the backend filter live. | `sessions/2026-04-12/session-1.md` |
| 2026-04-03 #1 | Bond History Repair, Endpoint Preference Rollout, and Recorder Hardening | Removed poisoned bond-history rows, restored the missing historical rows, hardened rapid-swap ingestion, and deployed official-endpoint preference live. | `sessions/2026-04-03/session-1.md` |
| 2026-04-02 #2 | Rapid Swaps Adoption Chart Midgard Failover + Live Deploy | Restored Rapid Swaps adoption charts by failing Midgard history queries over to the canonical origin and deployed the frontend live. | `sessions/2026-04-02/session-2.md` |
| 2026-04-02 #1 | Rapid Swaps Backfill, Catch-Up Hardening, and Local-Time Frontend | Backfilled missed rapid swaps, fixed the canonical scan cursor loss bug, and aligned Rapid Swaps charts/tables around local frontend time. | `sessions/2026-04-02/session-1.md` |
| 2026-04-01 #1 | BooneTools Hetzner Backend Cutover + Live Deploy | Replaced the Supabase runtime path with a Hetzner-hosted Postgres/API stack, cut `boone.tools` over to `/functions/v1`, and brought the new listener and timers live. | `sessions/2026-04-01/session-1.md` |

## Current Work In Progress

- Monitor live bond-history behavior after the zero-row cleanup and confirm no other wallets regress into synthetic recent bond/unbond activity.
- Re-check intermittent Midgard proxy inconsistencies before narrowing fallback behavior further.
