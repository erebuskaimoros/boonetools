# Session 4 - Thorfolio design, route, footer swap and coffee panels

> Date: 2026-10-21 (started 2026-10-20)
> Focus: Design pass on the new Position Tracker, its move to `/thorfolio` on `feat/thorfolio`, and a footer with STO swap and RUNE tip panels.

## Summary

Picked up the uncommitted Position Tracker, gave it a design pass, added the
classic bond history and churn table with multi-address merging, and renamed it
Thorfolio at `/thorfolio` (old `/bond-tracker` links redirect). Moved the work
onto `feat/thorfolio` from `origin/main` and pushed it. Then rebuilt the footer
as a terminal status line with a docked STO swap panel and a "buy me a coffee?"
RUNE send panel on the shared wallet, and gated bond-yield payout until 3.21.

## Papercuts

- Resolved: `pc-20261021-024622-f608bf` — the Svelte ratchet failed in Claude
  Code shells because svelte-check emits machine output when `CLAUDECODE=1`.
  `scripts/check-svelte-diagnostics.mjs` now pins `--output human-verbose`
  (failing test first).
- Deferred: `pc-20261021-032530-6d8011` (workspace audit crashes without a UTF-8
  locale) belongs to the THORChain workspace repo, not this one.
- Remaining open: 78.

## Work Done

- Design pass (frontend-design skill, `DESIGN.md` contract): summary tiles in
  one currency, an allocation strip using the validated dashboard palette, an
  address table with per-address totals and an address focus, a single-axis TCY
  payouts chart with a unit toggle, cents for small values, action-modal focus
  and next-step hints, sticky first columns and phone layouts.
- Bond tab: the classic Bond History chart and Churn Earnings table, with
  `bond-history.js` merging addresses by churn height. Verified row-for-row
  against `/bond-tracker-classic` for one address.
- Route `/thorfolio`, name "Thorfolio", and a `routeAliases` rewrite that keeps
  `/bond-tracker?...` links working; the classic stays at `/bond-tracker-classic`.
- Created worktree `.worktrees/boonetools-website/thorfolio` on `feat/thorfolio`
  from `origin/main`, ported the work, raised the frontend surface budget by the
  2 `vite-env.d.ts` lines, and committed/pushed `9b58137`, `791a2cd` (swap
  panel) and `85eeffc` (launcher style). Removed the copies from the stale
  primary checkout.
- Footer: STO widget framed directly in a docked panel (`[s] > swap on
  THORChain`, `s` key), THORDEX link removed, terminal status-line styling
  aligned with the sidebar's status row.
- "buy me a coffee?" panel: `planSendRune` / `thor-send` (`uSwap.transfer`), $3
  prefill with $3/$5/$10 presets, copy address, shared wallet connect, docked
  like the swap panel and mutually exclusive with it.
- Bond yield payout buttons disabled until `gates.bondYieldEnabled`; page
  shortcuts and the swap `s` key ignore keys while a modal dialog is open.

## Discoveries

- Durable findings now live in `knowledge/footer-swap-and-tip-jar.md`: the STO
  `/widget` contract, the affiliate key being a ThorKit (`api.thorchain.org/v1`)
  `x-api-key`, and why an iframe cannot share the site wallet (STO relays are
  same-origin only via `Sec-Fetch-Site`).
- Multi-address bond history: per-address churn rows share churn heights and
  prices, but histories refresh independently, so a lagging address must carry
  its last stack forward rather than read as an unbond.
- svelte-check 4.7.3 switches to machine output whenever `CLAUDECODE=1`
  (sveltejs/language-tools#2868).

## Files Changed

| File | Change |
|------|--------|
| `src/lib/PositionTracker.svelte`, `src/lib/position-tracker/*` | Design pass, address focus, bond history, shortcut guard |
| `src/lib/position-tracker/bond-history.js`, `BondHistory.svelte` | Classic chart and churn table with multi-address merge |
| `src/lib/position-tracker/memos.js`, `actions.js` | `planSendRune` and the `thor-send` route |
| `src/lib/position-tracker/BondPanel.svelte` | Payout greyed out until bond yield is live |
| `src/App.svelte` | `/thorfolio` route and alias, swap panel mount, footer inset |
| `src/lib/Footer.svelte` | Terminal status line, swap launcher, coffee panel toggle |
| `src/lib/swap/*` | STO widget panel and helpers |
| `src/lib/tip-jar/*` | Coffee send panel and helpers |
| `scripts/check-svelte-diagnostics.mjs` | Pin svelte-check output format |
| `scripts/frontend-surface-baseline.json`, `.env.example` | Budget +2 lines; `VITE_STO_WIDGET_API_KEY` placeholder |
| `tests/position-tracker*.test.js`, `swap-panel`, `tip-jar`, `svelte-diagnostics-script` | New coverage |
| `knowledge/footer-swap-and-tip-jar.md`, `knowledge/README.md` | Promoted findings |

## Verification

- 713 frontend tests pass; `npm run check` passes in agent and clean shells
  (0 errors, 56 baseline warnings); production build passes.
- Browser checks on the worktree dev server (desktop, collapsed sidebar,
  phone) for Thorfolio, the swap panel, the coffee panel and payout gating.
  No transaction was signed.

## In Progress

`feat/thorfolio` is pushed with no PR. It is one commit behind `origin/main`
(`0fdfef2`) and needs that merged before a PR. Real-wallet signing (bond, LP,
TCY, coffee send) is untested. The swap panel needs the STO affiliate key.

## Next Steps

- [ ] Test bond/LP/TCY actions and the coffee send with a real wallet
- [ ] Obtain the STO/ThorKit affiliate key; restrict it to boone.tools origins
- [ ] Merge `origin/main` into `feat/thorfolio`, then open a PR
- [ ] Decide on a native ThorKit swap form on the shared wallet
