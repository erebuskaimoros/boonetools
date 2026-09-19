# Session 4 — Include NEAR's retained frontend income

> Date: 2026-09-18
> Focus: Broaden the NEAR Intents series to include its proprietary frontend earnings and deploy.

## Methodology change

At the user's request, methodology v2 counts all retained Intents revenue,
including NEAR's own frontend. The published dailyRevenue total already contains
that income; the old calculation subtracted its share. No extra wallet receipts
or verifier fees are added to the total. Third-party payouts, internal revenue
wallet transfers and contract-call deposits remain excluded.

Daily wallet ratios identify the included frontend and other retained shares.
Both sum into monthly payloads and appear in the tooltip, while the chart keeps
one NEAR series. Unknown/missing days and partial months preserve their existing
coverage semantics. The whole-NEAR subsidy allocation and TC/CF accounting are
unchanged. The original dated research report is not rewritten; this decision
explicitly supersedes its narrower NEAR business boundary for the live chart.

## Verification

- Wrote changed-expectation tests before implementation. All 44 focused tests
  pass, including exact-once inclusion, zero/missing receipts, monthly breakdowns,
  aging, tooltip compatibility and cache-only publication.
- `npm run check`: 0 errors / 56 existing warnings. Workspace audit passes.
- Read-only replay of production's saved observations confirms TC and CF are
  unchanged, NEAR subsidies are unchanged, and each monthly increase equals
  the newly included frontend amount (within floating-point tolerance).
- September through the 17th changes NEAR income from $567,839.03 to $772,560.00:
  $204,720.97 of frontend income is included. After subsidy becomes
  -$2,660,521.26. These are provisional wallet-receipt figures, not profit.

## Rollout

CI-green `80e7641d5e498046c309e7b8d1f93cde2e481503` is deployed to backend and
frontend. CI passed 337 frontend tests and 628 backend tests (12 additional
expected skips), checks and production build. Backend activation was routine,
without migrations; only the affected API service restarted. The frontend's
isolated build and public artifact verification passed.

The advisory-locked `rebuildOnly` job completed successfully in 165ms and
published all 13 monthly buckets with methodology v2, without provider calls
or acquisition writes. The raw cache SHA-256 remained
`aaf419c23af23b129b7463d7dde1c85f9e66786d51f647034761eec3e6bb01dc`,
and its observation timestamp remained September 18 at 18:31:23.964 UTC.
The cache now contains 382 CF days and 371 NEAR epochs from the scheduled run
that preceded this change. NEAR's existing archive HTTP 429 warning is preserved.

Public monthly values exactly match rebuilding that raw cache. Checked all
months against the pre-release API: TC/CF and NEAR subsidies are unchanged;
each NEAR income increase equals the included frontend share. The ordinary
public URL serves v2. Browser verification confirmed the updated qualification,
methodology text, September table values, and visible tooltip: $772,560 total,
$204,721 own frontend, $567,839 other retained income, -$2,660,521 after subsidy.
Both release pointers and active API/Financials/timer were verified. The
six-hour timer remains unchanged; older NEAR gaps remain explicit.

The end-session skill scopes publication to this release worktree; unrelated
canonical edits are preserved. No papercut backlog review was requested.
