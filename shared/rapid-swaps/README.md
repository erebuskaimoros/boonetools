# Rapid Swaps domain core

This directory owns environment-neutral Rapid Swaps normalization,
reconciliation, ingestion planning, provider access, and volume calculations.
Both the browser application and the production backend consume these modules.

The core may depend only on modules under `shared/`. It must not import from
`src/` or `backend/`; this keeps the deployed backend independent of the
frontend source tree. Existing modules under `src/lib/rapid-swaps/` are
compatibility facades for browser callers and older tests.
