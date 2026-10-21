# Session 1 — Thorfolio bond dashboard and wallet holdings

> Date: 2026-10-21
> Branch: feat/thorfolio

## Changes

- Restored Bond Tracker summary cards, currency selection, history controls, exports, address links, and random provider lookup in Thorfolio. Corrected address scoping, current-node freshness, historical refresh behavior, and combined yield calculations.
- Made node bonds collapsed by default and addresses collapsed when populated. Increased the contrast and click targets of bond, unbond, and payout buttons.
- Added THORChain 3.21 Bond Yield configuration with percentage and destination controls, exact memo construction, ownership checks, activation checks, and renewed validation before signing. Protocol details and limitations are recorded in [the feature guide](../../../docs/thorfolio-bond-yield.md).
- Added held native RUNE to summary cards, allocation, totals, and per-address views. Reused the TCY bank lookup with pagination and explicit unavailable states; excluded bonded RUNE and pending rewards from wallet balances.

## Validation

- 65 focused Thorfolio tests passed, including wallet balance precision, missing data, pagination, address filtering, bond dashboard parity, and payout review/signing guards.
- `npm run check`: zero errors and 56 existing warnings.
- `npm run build`: passed with existing dependency/chunk-size warnings. The final loading-label refinement also compiled with zero Svelte warnings.
- Verified the live dashboard on localhost:5174, including desktop summary layout, management buttons, collapse controls, and held RUNE totals when selecting one address.
- Project ownership/forge audit: zero errors or warnings. The manifest permits direct pushes to origin for boonetools-website.

## Handoff

- User requested committing and pushing this branch. No production deployment was requested.
- Live Bond Yield signing and settlement await network activation. The queried network reported 3.20.3 during implementation; no wallet was connected and no transaction was broadcast.
- No papercut backlog review was requested or performed.
