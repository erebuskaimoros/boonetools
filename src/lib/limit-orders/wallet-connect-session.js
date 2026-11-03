import { WALLETCONNECT_PROVIDER } from './wallet-config.js';

/**
 * Keep the UI's accounts synchronized with approved SDK sessions. Inject the
 * SDK/store boundaries so lifecycle behavior can be tested without a relay or
 * signing wallet. Saved addresses are never evidence of an approved session.
 */
export function createWalletConnectSession({ getSDK, supportedChains, metadata, isEnabled, replaceAccounts, readRestoreChains, finishRestore }) {
  let revision = 0;
  let queue = Promise.resolve();
  let restoration = null;

  function accountsFor(chains) {
    const sdk = getSDK();
    return [...new Set(chains)].flatMap((network) => {
      const address = sdk.getWallet(WALLETCONNECT_PROVIDER, network)?.address;
      return address ? [{ address, network, provider: WALLETCONNECT_PROVIDER }] : [];
    });
  }

  function synchronize() {
    const accounts = accountsFor(supportedChains);
    replaceAccounts(accounts);
    return accounts;
  }

  function connect(chains, options = {}) {
    const requested = [...new Set(chains)].filter((chain) => supportedChains.includes(chain));
    const requestedRevision = revision;
    const run = async () => {
      if (requestedRevision !== revision) return [];
      if (!isEnabled()) throw new Error('WalletConnect is not configured for this site.');
      if (!requested.length) throw new Error('WalletConnect does not support any of the selected chains.');

      const sdk = getSDK();
      try {
        // Signing an already connected account must not open a new QR modal or
        // replace other approved chains belonging to this provider.
        if (accountsFor(requested).length !== requested.length) {
          await sdk.connectWalletconnect(requested, { metadata, restoreOnly: !!options.restoreOnly });
        }
        if (requestedRevision !== revision) {
          // A user disconnected while pairing/restoration was in flight. A late
          // approval must not silently reconnect them.
          sdk.disconnectWallet(WALLETCONNECT_PROVIDER);
          synchronize();
          return [];
        }
        synchronize();
        return accountsFor(requested);
      } catch (error) {
        synchronize();
        throw error;
      }
    };
    const next = queue.then(run, run);
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  function disconnected(chains) {
    // The SDK reports only chains which lost their approved session. It also
    // guards setup against a session ending while the toolbox loads.
    getSDK().disconnectWallet(WALLETCONNECT_PROVIDER, chains);
    synchronize();
  }

  function disconnect() {
    revision++;
    getSDK().disconnectWallet(WALLETCONNECT_PROVIDER);
    finishRestore();
    synchronize();
  }

  function restore() {
    if (restoration) return restoration;
    const chains = readRestoreChains().filter((chain) => supportedChains.includes(chain));
    if (!chains.length || !isEnabled()) {
      finishRestore();
      return Promise.resolve([]);
    }
    restoration = connect(chains, { restoreOnly: true }).finally(finishRestore);
    return restoration;
  }

  return { connect, disconnect, disconnected, restore };
}
