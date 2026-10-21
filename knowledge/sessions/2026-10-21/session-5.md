# Thorfolio release preparation

## Completed

- Legacy Bond Tracker URLs now translate the linked provider into an explicit
  Thorfolio address list and select the bond tab, preserving other URL settings.
- LP and TCY summary cards select their tabs; the liquidity tab is labeled LP.
- Only the footer tip address is clickable; its explanatory text is plain text.
- TCY stake and wallet request failures remain unavailable, preserve payouts,
  and mark portfolio/address totals partial. Unknown stakes invalidate combined
  APR. Confirmed absent stakes and valid empty wallets remain known zero.
- The development proxy preserves protocol error details so an absent stake is
  distinguishable from an outage. Live balances recovered after refresh.
- The swap launcher, panel and shortcut are disabled until the issued STO key
  is ready. `.env.example` no longer supplies a placeholder key.

## Validation

- 99 focused Thorfolio, position, footer and proxy tests passed.
- `npm run check`: zero errors, 56 existing warnings.
- Production build passed before the final swap visibility gate; the merged
  release will also run the full CI build before guarded deployment.
- Browser verified recovered holdings, card navigation, footer interaction,
  and the disabled swap launcher/shortcut.
- Project ownership audit passed with zero errors and warnings.

## Release and remaining work

The user authorized pushing `feat/thorfolio`, merging into main and production
deployment. Use the isolated release checkout and deploy only the exact merged
commit after its Actions `verify` check succeeds. No backend code changed on
this feature branch. Real-wallet signing validation remains outstanding; no
financial transaction was submitted during this session. The original temporary
balance-request error was not retained, so its precise network cause is unknown.
