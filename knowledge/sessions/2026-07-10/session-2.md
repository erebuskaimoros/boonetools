# Session 2 - Retired Backend Cleanup and Safe Revenue Migration

> Date: 2026-07-10
> Focus: Remove retired hosted-backend artifacts and make the pending App Layer production migration safe for existing Dune audit data.

## Summary

Removed the retired hosted-provider implementation, workflows, dependency, deploy references, and obsolete local configuration from the website checkout while preserving the active Node/Postgres service path. Corrected the unapplied generated-fee migration and runtime normalizer so valid direct-RUJI-Swap audit exclusions with blank memos and ordinal-suffixed swap IDs survive the production cutover.

## Work Done

- Removed the retired functions, migrations, workflows, import/comparison utilities, dependency entries, and outdated operator documentation.
- Verified the active backend remains the Node/Postgres service with systemd schedulers and compatibility routes under `/functions/v1`.
- Updated migration `021` to accept valid `64-hex-N` swap IDs and retain only the approved blank-memo direct-exclusion audit shape.
- Updated Dune normalization and regression coverage to match that migration rule.
- Ran a read-only production preflight: all 31,196 stored Dune rows pass the patched migration predicate; 12,763 direct-exclusion rows have intentionally blank memos and 5,076 rows have ordinal-suffixed IDs.

## Discoveries

- The canonical backend deploy script automatically applies every pending database migration, so an unapplied migration must be production-shape checked before it is invoked.
- Direct-RUJI-Swap rows are excluded from dashboard totals but must be retained as audit evidence; they have valid destination/coin/fee data despite a blank memo.
- Provider-specific source trees and GitHub scheduler workflows were no longer part of the active production path; systemd timers own the current schedules.

## Files Changed

| File | Change |
|------|--------|
| `backend/migrations/021_rujira_base_fee_event_canonicalization.sql` | Preserved valid excluded audit rows and suffixed swap IDs during canonicalization. |
| `backend/src/shared/rujira-base-fees.js` | Aligned Dune row validation with the safe audit-row shape. |
| `backend/tests/rujira-base-fees.test.js` | Added direct-exclusion and suffixed-ID regression coverage. |
| `package.json`, `package-lock.json` | Removed the retired browser database SDK and its dependency subtree. |
| Retired provider tree, workflows, utilities, and docs | Deleted obsolete implementation and deployment artifacts. |
| `scripts/deploy-boonetools-backend.sh`, `docs/boonetools-backend-hetzner.md` | Updated guidance to the active backend path. |

## In Progress

Production rollout is next: take a database backup, deploy the pushed backend/frontend release with the canonical scripts, then verify migrations, API health, and App Layer source provenance.

## Next Steps

- [ ] Back up the production BooneTools database immediately before migration.
- [ ] Deploy backend and apply migrations `021`/`022` through the canonical script.
- [ ] Deploy the frontend from the same pushed commit.
- [ ] Verify API health, migration records, dashboard payloads, and preserved Dune audit-row counts.
