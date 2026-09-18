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

CI and production deployment are pending. A new advisory-locked
`rebuildOnly` mode will publish saved observations under the new methodology
without provider calls or acquisition writes, preserving observation age and
source warnings. The six-hour timer remains unchanged.

The end-session skill scopes publication to this release worktree; unrelated
canonical edits are preserved. No papercut backlog review was requested.
