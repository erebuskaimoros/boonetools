# API efficiency and dashboard fixes

## Outcome

Deployed backend and frontend release `3993758` to boone.tools. Confirmed
Vanaheimex scanner 429 cooldowns and measured heavy Liquify historical repair
traffic. Added durable adjacent-block anchor proofs, shared timestamp reuse,
bisection fallback, and atomic repair of incomplete scheduled rows.

Corrected halted churn status, made the System Income POL metric white, hid
orange chart segments at zero, and defaulted all five App Layer charts to 30 days.

## Verification

Clean release: 309 frontend tests and 526 backend tests passed; eight PostgreSQL
integration checks passed separately. Type checking had zero errors and 56
existing warnings. GitHub CI run 33956709810 passed. All 16 production API gates
and production browser checks passed.

## Papercut review

Closed the brittle churn markup test issue (pc-20260905-084830-75fb01), verified
with focused tests. Documented compressed and scoped journal transfers
(pc-20260905-082503-6a741d). The other 14 entries remain open: browser/agent/runtime
limitations and WSL access are outside this repo; historical-state and provider
failures need separate verification; deploy-prime policy needs broader analysis.

## Handoff

The optional Pool Dislocation historical prime still fails on Liquify HTTP 500
responses. Cached reads remain healthy; the normal repair timer retries. Savings
from the new cache have not yet been measured in production.

Publication used an isolated release clone to exclude unrelated unpublished
commit 868f7ef and local edits. The canonical checkout remains intentionally
unchanged, including task patches already published in 3993758; do not reset it
or accidentally republish unrelated work. Shared provider notes and workspace
log were updated locally. The local dev server remains available on port 5173.

See [the detailed audit](../../api-limit-audit-2026-09-05.md).
