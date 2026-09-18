# Session 3 — Protocol comparison backfill lifecycle

> Date: 2026-09-18
> Focus: Repair stalled publication and bound acquisition before the production service timeout.

## Work done

- Reproduced the bug with three failing regressions before implementation:
  recovered/checkpoint publication, stopping between days, and aborting an
  in-flight request at the acquisition deadline.
- Delegated the scoped implementation per the repository's bug-fix workflow.
  The job now publishes recovered observations before provider calls and each
  durable checkpoint. Interim snapshots explicitly report stale/in-progress.
- Added a 20-minute default acquisition budget with abort propagation through
  HTTP and FastNear pacing, plus tests for cancellation settlement, successful
  deferral and genuine provider failures. The systemd timeout stays 30 minutes.
- Preserved all accounting and data-gap semantics, the existing database cache,
  the advisory lock and the six-hour timer. No frontend deployment is needed.
- Worked only in the existing release worktree; unrelated canonical edits are
  untouched. The end-session skill keeps this task's commit and rollout scoped.

## Verification and rollout

All 47 focused comparison/cooldown/build-boundary tests pass. `npm run check`
reports 0 errors and the 56 pre-existing warnings. The workspace audit reports
no errors or warnings. CI passed 336 frontend tests and 625 backend tests
(12 additional expected skips), plus the production build.

Backend release `89203bb707863990fcee72cb828b8401e5b3c0af` is active. Deployment
was routine: no migrations or persistent process restarts; the API and Financials
PIDs stayed unchanged. Frontend remains at `d828fa5`.

An advisory-locked production verification run used a 60-second acquisition
budget under a temporary systemd unit with a 120-second outer limit. Recovery
publication immediately exposed January–July CF. During the run, nine more CF
days were persisted and December 2025 became complete. Final publication at
16:50:57 UTC contained 300 CF days / 286 NEAR epochs, with in-progress cleared.
Public monthly values exactly match a rebuild from production's persisted cache.

The runner returned after 60.177 seconds, not a systemd timeout. Its exit status
was 1 because the real NEAR archive cooldown remained until 17:08:14 UTC; that
source error was retained alongside the separate budget-deferral note. This
verified that a source failure does not hide other protocols' completed work.
The temporary verification unit was automatically collected. The original
service's historical timeout marker was not cleared or disguised as success.

The normal six-hour timer remains enabled/active; next run is 18:20 UTC.
Chainflip now covers December 2025–partial September 2026. September–November
2025 still have gaps, and exact NEAR issuance remains incomplete. No reseeding
or production cache overwrite was performed.

## Production baseline

The first run timed out at 16:32:53 UTC after persisting 291 CF issuance days
and 286 NEAR epochs. January–July 2026 CF months were complete in acquisition
storage but unpublished; the public snapshot still matched the original seed.
NEAR archive rate limiting and older historical gaps remain separate from this
lifecycle bug. This patch must not label those gaps complete.
