# Session 2 - Reserve Scanner Recovery and ADR26 Default

> Date: 2026-07-27
> Focus: Repair App Layer Reserve ingestion and improve the ADR26 dashboard entry state

## Summary

Recovered the missing July 26 Base Layer Reserve payments and corrected the resulting App Layer daily earnings row. Replaced the Reserve scanner's permanent fixed-phase assumption with THORNode's live scheduler anchor, then made the ADR26 Affiliate view the dashboard default.

## Work Done

- Diagnosed the July 26 negative App Layer earnings as 58 missing Reserve payments caused by a 58-block scheduler phase shift.
- Backfilled the missing production payment blocks and rebuilt the affected Reserve and earnings read models.
- Changed scheduled Reserve recovery to parse the collector's live THORNode `/schedules` entry and derive cadence from `after + 1`.
- Added a versioned catch-up cursor, bounded upgrade bootstrap, oldest-first outage recovery, one-cadence overlap, and stored-event fallbacks.
- Added regression coverage for scheduler parsing, bounded recovery, long-outage catch-up, and the exact July 26 phase mismatch.
- Changed the ADR26 Dynamic Fees dashboard to open on the Affiliate tab instead of Pair.
- Verified all 174 backend tests, import boundaries, Svelte diagnostics, and the production frontend build.

## Discoveries

- A contract's 101-block execution cadence does not imply a permanent phase; manual execution or rescheduling can move all later scheduled heights.
- THORNode's `/schedules?sender=...` response groups multiple senders at a height, so the scanner must select the collector's encoded `run` message rather than trusting the schedule row alone.
- A bounded bootstrap repairs recent gaps during a scanner-version upgrade, while a persisted cursor avoids rewriting the full recovery window on every steady-state run.

## Files Changed

| File | Change |
|------|--------|
| `backend/src/shared/rujira-reserve-payments.js` | Added live scheduler parsing and phase-aware, cursor-based Reserve recovery |
| `backend/tests/rujira-reserve-payments.test.js` | Added scanner phase and outage recovery regression tests |
| `src/lib/DynamicFeeDashboard.svelte` | Made Affiliate the default ADR26 tab |

## In Progress

None - session implementation and validation are complete.

## Next Steps

- [ ] Monitor the first production Reserve scheduler runs for `anchor_source=thornode-scheduler` and an empty `schedule_error`.
- [ ] Confirm new Reserve events continue to land on the live scheduler phase without manual recovery.
- [ ] Keep watching App Layer daily earnings for unexpected payout/inventory divergence.

