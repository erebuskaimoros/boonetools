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

Focused comparison/cooldown/build-boundary tests pass. `npm run check` reports
0 errors and the 56 pre-existing warnings. The workspace audit reports no
errors or warnings. CI and production rollout verification are pending.

## Production baseline

The first run timed out at 16:32:53 UTC after persisting 291 CF issuance days
and 286 NEAR epochs. January–July 2026 CF months were complete in acquisition
storage but unpublished; the public snapshot still matched the original seed.
NEAR archive rate limiting and older historical gaps remain separate from this
lifecycle bug. This patch must not label those gaps complete.
