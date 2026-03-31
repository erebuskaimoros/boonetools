# Sessions Index

## Recent Sessions

| Session | Focus | Summary | Path |
|---|---|---|---|
| 2026-03-31 #2 | Bond Tracker APY Churn Smoothing + Frontend Deploy | Smoothed fresh-churn APY estimates in Bond Tracker, added regression tests, and deployed the static site. | `sessions/2026-03-31/session-2.md` |
| 2026-03-31 #1 | Rapid Swaps Adoption Fix + Deploy | Fixed adoption chart UTC/day-volume mismatches, hardened the recorder pipeline, and deployed frontend/backend/listener. | `sessions/2026-03-31/session-1.md` |
| 2026-03-22 #6 | Preserve Asset Type Notation | Preserve `.` `~` `-` separators in pair display instead of normalizing to dots. | `sessions/2026-03-22/session-6.md` |
| 2026-03-22 #5 | Time Savings with Percentage Context | Added % faster metric, baseline/actual times, per-swap saved column with percentage. | `sessions/2026-03-22/session-5.md` |
| 2026-03-22 #4 | Time Saved Validation + Trade Asset Fix | Validated time saved calc against on-chain data, fixed trade account asset USD pricing (dash→dot format). | `sessions/2026-03-22/session-4.md` |

## Current Work In Progress

- Rapid Swaps listener/recorder local edits in `scripts/rapid-swap-listener.mjs` and `supabase/functions/_shared/rapid-swaps.ts` remain outside the APY session commit and were not deployed here.
