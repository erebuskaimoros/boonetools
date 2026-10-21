# Session 6 — Thorfolio operator-fee payouts

- Added the conditional Operator fee RUNE column to churn earnings and CSV/XLS exports.
- Attributed actual paired bond-reward/return events using historical operator ownership; fees remain separate from compounded bond rewards and stack.
- Added nullable migration 071 and a bounded, resumable metadata backfill using shared immutable block observations. Missing evidence remains unavailable.
- Verified a real 41.01726066 RUNE operator payout at block 28203871 and ownership at the preceding block.
- Frontend suite: 731 passed. Backend suite: 881 passed, 17 existing integration skips. Follow-up attribution and rendering tests passed; static checks report zero errors and 56 existing warnings.
- Browser verified conditional visibility and the honest unverified state before backend rollout.
- User requested deployment. Publishing through the existing direct-push route, merging onto production main in an isolated release worktree, and deploying backend before frontend after the merged commit passes CI.
- Papercut review was not requested. One SSR test-harness friction was logged during implementation; no backlog changes were made.

See [operator-fee accounting and rollout notes](../../thorfolio-operator-fees.md).
