# Footer swap panel and "buy me a coffee?" panel

The site footer is a terminal status line that continues the sidebar's bottom
row (`--footer-inset`, `--footer-height`). It carries two docked, non-modal
panels that open above it; only one is open at a time.

## Swap panel (`src/lib/swap/`)

- `[s] > swap on THORChain` (or the `s` key) opens a panel that frames
  swap.thorchain.org's embeddable widget page:
  `https://swap.thorchain.org/widget?apiKey=…&theme=dark`. That is what STO's
  `widget.js` loader does in static mode. The loader is deliberately not loaded:
  it is a mutable third-party script, and boone.tools holds wallet sessions.
- STO's floating mode draws its own fixed pill 24px from the bottom with a
  shadow and system font, which collides with the fixed footer and breaks
  `DESIGN.md`; use static framing instead.
- `/widget` sends no `X-Frame-Options` or CSP. Its only parent messaging is
  theme (`ready` out, `theme` in); it ignores everything else.
- The key comes from `VITE_STO_WIDGET_API_KEY`. Empty hides the launcher.
  Production builds do not read `.env`, so export it when building a release.
  The `.env.example` placeholder makes STO return "No Valid Quotes"; with no
  key at all the widget quotes normally but earns nothing.
- The iframe loads on first open and stays mounted, so closing the panel or
  changing dashboards keeps a swap in progress.

## The affiliate key is a ThorKit key

STO configures `@tcswap` with `envs.apiUrl = https://api.thorchain.org/v1`
(ThorKit, the THORChain swap aggregator) and passes the widget key as
`apiKeys.uSwap`. Its developer page describes that `x-api-key` as issued free
through the affiliate program after review. The memoless API
(`https://api.thorchain.org/memoless/api/v1`) needs no key. Without overrides,
`@tcswap` defaults to `https://swap-api.unstoppable.money`.

## Why the swap panel cannot share the site wallet

- A wallet connection is an extension permission plus an in-page provider
  object; neither crosses origins, and the widget accepts no wallet messages.
  A host-signing bridge (as in Safe or Ledger Live apps) would need STO to add it.
- STO's Blockchair and Solana relays (`/api/blockchair`, `/api/solana`) reject
  cross-site requests via `Sec-Fetch-Site` to protect their paid quota. A copy
  of the widget on boone.tools cannot use them.
- A shared-wallet swap therefore means a native form on `limit-orders/wallet.js`
  pointed at ThorKit with the same key. UTXO chains and Solana still need a
  data provider of our own for transaction building.

## "buy me a coffee?" panel (`src/lib/tip-jar/`)

- Clicking the footer label or address opens a docked panel (lazy-loaded) that
  sends RUNE to the tip jar with the shared wallet connection
  (`limit-orders/store.js`, Thorfolio's `WalletModal`).
- It is a plain `MsgSend` with no memo: `planSendRune` builds a `thor-send`
  plan and `executePlan` calls `uSwap.transfer`, reusing Thorfolio's
  reconnect-on-sign and provider selection.
- It prefills $3 of RUNE from `/thorchain/network` (`rune_price_in_tor`),
  rounded up to 2 decimals, offers $3 / $5 / $10 presets, and refuses an amount
  the wallet cannot cover after `native_tx_fee_rune`.
