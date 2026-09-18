# Session 1 - Simplified production deployment

> Date: 2026-09-18
> Focus: Publish and exercise the commit-based deployment workflow

## Summary

Committed the deployment refactor as `85baecc10376c568b9dff9d32d0302a80f1c48ef`
and pushed it to production `main` from the isolated `refactor/simpler-deployment`
worktree. The primary checkout and unrelated work remain untouched.

## Work Done

- Replaced clean-main release clones with an explicit CI-passing main-history
  SHA. Both packaged source and remote activation helpers come from that SHA;
  frontend builds use an automatically isolated temporary directory.
- Backend activation restarts affected persistent consumers, lets scheduled jobs
  retain their cadence, and checks affected public API routes. Schema, package,
  or unit changes retain coordinated activation; no blanket provider warmups
  or historical backfills are forced.
- Preserved checksums, the shared lock, atomic switching, automatic rollback,
  server-owned configuration, and release retention for still-running processes.
- Replaced obsolete warmup assertions with execution tests covering source
  isolation, service selection, migration/restart/health failures, rollback,
  retryable immutable artifacts, and persistent-consumer coverage.
- Workspace ownership audit passed without errors or warnings. All 26 focused
  deployment tests and shell syntax checks passed before publication. Full
  backend tests and `npm run check` also passed during implementation; Svelte
  diagnostics remained at 0 errors and 56 existing warnings.

## Publication and Production Verification

- Commit: `85baecc10376c568b9dff9d32d0302a80f1c48ef`.
- CI: [verify run](https://github.com/erebuskaimoros/boonetools/actions/runs/35343600601)
  passed in 2m2s: 316 frontend tests, 594 backend tests passing (12 skipped),
  architecture/Svelte checks, and the production build.
- Backend staged at `2026-09-18T12:16:35Z`; the new plan selected routine
  activation, no migrations, and no persistent restarts. Public Status passed
  with HTTP success, compression, and fresh data (56 ms in the release gate).
- API, consolidated listener, and Financials collector PIDs stayed at 3963025,
  3963026, and 3963027. Core, Pool Analysis, and Status timer activation times
  remained unchanged. The prior `eadaf2c` release was retained for the running
  processes and rollback; retention removed the unused `44bfa41` artifact,
  which remains reproducible from Git. No application data was removed.
- Frontend staged at `2026-09-18T12:17:38Z` from a clean temporary build of the
  exact commit. Its atomic activation and public-asset verification passed.
- An independent post-deploy check confirmed both release pointers, public
  HTML equality, SHA-256 equality for the referenced JS/CSS assets, `/status`,
  and API health. The original local source edits were never packaged.

## Remaining Non-Blocking Warnings

- Existing frontend dependency installation reported 167 audit findings,
  including 2 critical, plus existing peer/engine/build warnings. Dependencies
  were not changed by this task; CI and the production build passed.
- Logged `pc-20260918-121824-4f8934`: macOS provenance xattrs produced repeated
  harmless Linux tar warnings despite `COPYFILE_DISABLE=1`. Deployment and
  artifact comparisons passed. No backlog review was performed.

## In Progress

None for the requested publication and deployment.

## Scope

This was an explicit commit/push/deploy request, not a session-wrap-up backlog
review. No papercut backlog review or unrelated fixes were included.
