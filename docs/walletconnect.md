# WalletConnect and THORWallet

BooneTools uses the TCSwap WalletConnect connector shared with STO. The project
ID identifies the application to WalletConnect; it is public browser
configuration, not a wallet credential. Wallet approval and transaction signing
stay in the user's wallet.

## Configuration

1. Sign in to <https://dashboard.walletconnect.com/> and create an **App** project
   named BooneTools. Copy its 32-character hexadecimal Project ID.
2. For development, put `VITE_WALLETCONNECT_PROJECT_ID=<project-id>` in the
   checkout's ignored `.env.local`, then restart Vite. Use the same variable for
   production builds. An empty value disables the connector.
3. Configure the project's application URL as `https://boone.tools`. If the
   dashboard offers an origin allowlist, include the production origin and the
   development origin used for pairing checks.
4. For persistent deployment configuration, store just the ID in
   `/opt/boonetools-frontend/config/walletconnect-project-id`, owned by root with
   mode 0600. The existing frontend deployment loader reads it without sourcing
   shell code. An exported `VITE_WALLETCONNECT_PROJECT_ID` overrides this file;
   explicitly exporting an empty value disables WalletConnect.

The STO affiliate key is a separate setting and cannot substitute for this ID.
The embedded footer swap widget maintains its own wallet session.

## Integration constraints

- Wallet SDK 4.3.36 and core 4.1.36 provide the session lifecycle used by STO.
  Keep the related TCSwap packages aligned when upgrading them.
- Pair all selected supported chains in one request. The wallet can approve a
  subset; only approved accounts belonging to that provider may enter the app's
  connected account state.
- THORChain uses `cosmos:thorchain-1`, with the SDK offering the legacy
  `cosmos:thorchain` identifier as well. THORChain signing uses Cosmos amino
  signing. WalletConnect support in a wallet does not prove support for every
  chain or signing method.
- This SDK connector does not offer Bitcoin, Litecoin, Bitcoin Cash, Dogecoin,
  Zcash, XRP, or Solana through WalletConnect. Keep those chains out of this
  connector's selection; existing wallet connectors retain their own support.
- Reload restoration must not open a QR dialog. Expired or phone-disconnected
  sessions must remove their accounts, and disconnecting one provider must
  preserve other providers on the same chain.

## Verification

Run the existing position tracker behavior suite, frontend checks and build.
`backend/tests/deployment-source.test.js` executes the configuration loader with
mock SSH/build commands and verifies persistence, overrides, malformed IDs and
read failures without contacting production.

With a configured ID, verify the actual QR modal, dismissal, phone approval,
partial approvals, reload restoration, phone disconnect, and reconnect with a
second provider already on the same chain. A real THORWallet signing check
requires a separate user-approved transaction; neither mocked signer tests nor
opening the QR dialog establish end-to-end signing compatibility.

Sources: [STO integration](https://github.com/thorchain/swap.thorchain/commit/63314399a547b54b13c72c8007e2ee8d93c8b512),
[WalletConnect project setup](https://walletconnect.com/blog/meet-the-new-walletconnect-dashboard),
[THORWallet FAQ](https://faqs.thorwallet.org/faqs).
