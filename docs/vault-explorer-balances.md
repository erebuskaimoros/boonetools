# Independent Vault Explorer balances

Vault Details compares external-chain custody with `/thorchain/vaults/asgard`
accounting. THORNode provides the vault roster, addresses, expected inventory,
pool prices and metadata. It does not supply the independent balance column.
Midgard is not used for these balances.

## Coverage

| Chain | Independent source | Amount checked |
| --- | --- | --- |
| BTC | Blockstream Esplora; mempool.space fallback | Address UTXOs, including mempool changes |
| LTC | LitecoinSpace; BlockCypher fallback | Address UTXOs, including mempool changes |
| BCH | Haskoin; Blockchain.com Haskoin fallback | Confirmed plus unconfirmed satoshis |
| DOGE | BlockCypher; Blockchair fallback | Final address balance; Blockchair reports its indexed balance |
| ETH, AVAX, BSC, Base | PublicNode and chain-specific public RPC fallback | Native balance and known pool/vault ERC-20 assets |
| GAIA | Cosmos Directory; PublicNode REST fallback | Complete paginated Cosmos Hub bank inventory, matched to ATOM and known IBC denominations |
| SOL | PublicNode; Solana mainnet RPC fallback | Confirmed native SOL balance |
| XRP | XRPL Cluster; Ripple fallback | Native XRP in the validated ledger |
| TRON | PublicNode; TronGrid fallback | Native TRX and USDT via read-only contract call |
| ZEC | Zelcore Blockbook; Blockchair fallback | Transparent balance of the TEX address's P2PKH (`t1`) equivalent, confirmed plus unconfirmed; Blockchair reports its indexed balance |

Other assets remain explicitly **THORNode only**. No independent amount is
invented for unknown denominations, SPL tokens, other TRC-20 tokens, private
chains, Zcash shielded pools, or new custody models. The model queries native assets even when they
are absent from THORNode's coin list. Token discovery uses known pool/vault
assets, not arbitrary token scanning. Prices still come from THORNode.

THORNode reports ZEC vault addresses as ZIP-320 TEX addresses (bech32m, hrp
`tex`, 20-byte pubkey hash). The collector converts them locally to the
equivalent transparent `t1` address that explorers index; an address that fails
the bech32m checksum, hrp or 20-byte payload check is unavailable.

## EVM custody

The mainnet V6.1 router at `0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4`
uses **direct vault custody**. Read the token's `balanceOf(vault)`; its compatibility
`vaultAllowance` method just wraps that same call. AVAX and Base used this
router in the September 26, 2026 live check.

The recognized legacy ETH and BSC routers hold tokens centrally. Read their
per-vault `vaultAllowance(vault, token)` and separately compare the router's
actual `balanceOf(router)` with the sum of allowances for all listed vaults.
Native balances, allowances, decimals and backing checks use a pinned block
per EVM chain. A lower actual router balance raises a shared-custody shortfall;
it must not be allocated arbitrarily to an individual vault. Covered backing
only means enough tokens for the listed allowances, not an audit of every
possible router liability. Unknown router addresses fail closed for tokens.
Update the reviewed custody mapping when routers migrate.

Custody reference: THORNode `chain/evm/contracts/THORChain_RouterV6.sol`,
`THORChain_RouterV4.sol` and
`chain/evm/deployment/routerv6/Mainnet-RouterV61-Deployment.md`.
GAIA identity mapping is copied from THORNode `config/default.yaml`; amounts
are always read from Cosmos Hub, never from that configuration or THORNode.

## Refresh and failure behavior

The existing `boonetools-visitor-data.timer` runs once per minute and handles
visitor-requested snapshot refreshes. The backend's `vault-l1-balances:v1`
acquisition cache shares an observation for the same custody targets and asset
set for 60 seconds, reattaching the latest THORNode accounting for comparison. Public `/functions/v1/vault-explorer-snapshot` requests stay
provider-free. Browsers fetch that snapshot every 15 seconds while visible;
Refresh requests the latest shared snapshot and queues collection if stale.
This is a demand-driven comparison page, not an unattended incident monitor.

Collection has a 40-second overall budget, six concurrent chain jobs, per-chain
serial explorer requests, six-second request deadlines, and EVM batches of at
most 40 calls with two batches in flight per chain. RPC item errors retry only
failed items at the alternate provider. Each successful result records provider,
observation time, and block/slot where available. It expires after 90 seconds;
five-second client-side age updates run separately from network refreshes so a
slow request cannot freeze a fresh indicator.

Invalid/missing values, unsafe JSON integers, failed pagination, unknown token
decimals, and provider errors are **unavailable**, never zero. Failed checks
never acquire a fresh L1 timestamp. One failed vault or token leaves successful
checks intact. Zero L1 balances remain visible when THORNode records a balance,
including assets without prices. The details card value sums fresh priced L1
observations only and shows coverage separately. Legacy snapshots from an older
backend remain THORNode-only until the new collector publishes.

A deficit raises a "lower than THORNode" alert only when it exceeds 0.01% of
THORNode's figure (`SHORTFALL_TOLERANCE_BPS`). Smaller deficits, typically
unsettled outbound fees, are labelled "within fee tolerance" and counted
separately. The header says balances are delayed once the older of the
`vaults` and `l1_balances` fields passes the same 90-second expiry
(`BALANCE_DELAY_MS`); slower fields such as `nodes` do not trigger it.

A negative difference is an investigation signal, not proof of a hack: pending
transfers, churn and different THORNode/L1 observation times also cause gaps.
Explorer/RPC responses are trusted observations, not cryptographic proof or
multi-provider consensus. No automatic transactions or notifications occur.

## Release and verification

Deploy backend and frontend together using the existing project deployment
workflow. No migration, new service, credential, or timer change is required.
Allow the normal minute timer to publish the upgraded snapshot; confirm
`field_meta.l1_balances`, coin `balance_status`/`thornode_amount` and
`routerChecks` appear before declaring coverage live. Do not force a provider
warmup as part of deployment.

Focused checks:

```sh
node --test backend/tests/vault-balances.test.js backend/tests/visitor-snapshots.test.js tests/vault-explorer-balances.test.js tests/vault-explorer-assets.test.js
npm run check
npm run build
```

Provider references: [Esplora API](https://github.com/Blockstream/esplora/blob/master/API.md),
[BlockCypher address balances](https://www.blockcypher.com/dev/bitcoin/#address-balance-endpoint),
[Haskoin Store](https://github.com/jprupp/haskoin-store),
[Ethereum JSON-RPC](https://ethereum.org/en/developers/docs/apis/json-rpc/),
[XRPL account_info](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_info),
[Solana getBalance](https://solana.com/docs/rpc/http/getbalance),
[TRON contract reads](https://developers.tron.network/reference/triggerconstantcontract),
[Blockbook API](https://github.com/trezor/blockbook/blob/master/docs/api.md),
[Blockchair address dashboards](https://blockchair.com/api/docs#link_300),
[ZIP-320 TEX addresses](https://zips.z.cash/zip-0320).
