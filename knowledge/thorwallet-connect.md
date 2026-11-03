# THORWallet via WalletConnect — 2026-11-03

Implementation worktree: `thorwallet-connect/website`, branch
`feat/thorwallet-connect`, based on deployed frontend `6ec0063`.

The user requested implementation after an investigation confirmed the missing
BooneTools connector and STO's October 29 integration. No deployment requested
for this change yet. The user supplied their BooneTools project ID on November 3;
it is configured in the worktree's ignored `.env.local`. Do not borrow STO's ID.

## Implementation

- TCSwap core 4.1.36, helpers 4.5.28, plugins 4.2.32, wallets 4.3.36 and their
  aligned transitive packages; unrelated lock entries retained and clean npm ci
  verified.
- Shared adapter registers WalletConnect and uses provider-scoped accounts and
  disconnects. An injected session controller owns partial approvals, restore,
  remote disconnect, cancellation and late-approval cleanup.
- Saved addresses are only restoration hints until SDK session validation.
  Signing reconnects with restoreOnly and verifies the reviewed account matches.
- Both wallet pickers offer WalletConnect with THORWallet/mobile copy when
  configured. Their modal yields to pairing, returns after cancellation/error,
  and identifies chains that were not approved.
- Optional public project ID is read from local build env or persistent server
  configuration. Missing means disabled; malformed config/read failures abort
  deployment. No production configuration was changed.
- Explicit THOR RPC uses the shared Liquify URL; SDK THOR REST default was
  verified as Liquify. No Nine Realms endpoints used.

## Validation so far

- Initial tests reproduced unsupported WalletConnect and incorrect disconnect
  scoping before implementation was delegated.
- 797 frontend tests passed, including 24 position tracker tests (13 relevant
  connection/signing tests).
- 11 deployment-source behavior tests passed.
- npm run check passed: 0 errors, 56 existing Svelte warnings.
- Production build passed; git diff --check clean.
- Browser checked actual dev app on port 4186 with no project ID: existing
  wallet picker loads without console errors and WalletConnect stays hidden.
- Browser checked both actual wallet components with a clearly labeled isolated
  simulated connector on port 4187 (`outputs/walletconnect-ui/`): configured
  option, chain filtering, pairing foreground handoff, cancellation and error
  recovery, partial approval notice, and disconnect cleanup. Corrected a stale
  success notice found after disconnect, then rechecked and rebuilt successfully.
  Screenshot: `outputs/walletconnect-preview.png`. This fixture makes no relay,
  signing, or real account requests and is not part of the production build.
- With the supplied project ID, the actual dev app on port 4186 generated a real
  WalletConnect QR code without console errors. Closing that dialog restored the
  BooneTools chain picker with a cancellation notice. Reopening generated the QR
  again without errors; screenshot: `outputs/walletconnect-real-qr.png`.
- The production build with the supplied project ID passed in 47.93 seconds;
  `.env.local` remains ignored and `git diff --check` is clean.
- Phone approval, session restoration with a real approved wallet, and signing
  remain unverified. Do not report QR generation or mock lifecycle tests as
  end-to-end THORWallet compatibility proof. Production is unchanged.

Operator instructions and upstream references: `docs/walletconnect.md`.
