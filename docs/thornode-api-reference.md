# THORNode API Documentation

## Overview

THORNode provides a RESTful API for interacting with the THORChain network. BooneTools should prefer Liquify gateway endpoints first, with official `thorchain.network` hosts retained as fallbacks where failover is available.

## Base URLs

| Service | URL | Description |
|---------|-----|-------------|
| THORNode (Primary) | `https://gateway.liquify.com/chain/thorchain_api` | Liquify gateway THORNode API |
| THORNode (Fallback) | `https://thornode.thorchain.network` | Official THORNode API |
| Midgard (Primary) | `https://gateway.liquify.com/chain/thorchain_midgard` | Liquify gateway Midgard API |
| Midgard (Fallback) | `https://midgard.thorchain.network` | Official Midgard API |
| RPC (Primary) | `https://gateway.liquify.com/chain/thorchain_rpc` | Liquify gateway RPC |
| RPC (Fallback) | `https://rpc.thorchain.network` | Official RPC |

## Interactive Documentation

- **THORNode Swagger:** https://gateway.liquify.com/chain/thorchain_api/thorchain/doc/
- **Midgard Swagger:** https://gateway.liquify.com/chain/thorchain_midgard/v2/doc
- **OpenAPI Spec:** https://gateway.liquify.com/chain/thorchain_api/thorchain/doc/openapi.yaml

## Rate Limits & Best Practices

- Add `x-client-id` header for public endpoints
- ~100 requests/minute for Midgard
- Handle HTTP 429 (rate limit) with exponential backoff
- Handle HTTP 503 (node overload) with retry logic

---

## THORNode Endpoints

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/ping` | Health check, returns "pong" |

### Pools

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/pools` | All pool information |
| GET | `/thorchain/pool/{asset}` | Single pool data |
| GET | `/thorchain/dpools` | All derived pools |
| GET | `/thorchain/dpool/{asset}` | Single derived pool |

### Pool Slip

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/slips` | Pool slip info across all L1 pools |
| GET | `/thorchain/slip/{asset}` | Pool slip for single asset |

### Liquidity Providers

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/pool/{asset}/liquidity_providers` | All LPs for asset |
| GET | `/thorchain/pool/{asset}/liquidity_provider/{address}` | LP details for address |

### Savers

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/pool/{asset}/savers` | All savers for pool |
| GET | `/thorchain/pool/{asset}/saver/{address}` | Individual saver position |

### Oracle

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/oracle/prices` | All oracle prices |
| GET | `/thorchain/oracle/price/{symbol}` | Price for single symbol |

### TCY Stakers

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/tcy_stakers` | All TCY staker information |
| GET | `/thorchain/tcy_staker/{address}` | Individual staker details |

### TCY Claimers

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/tcy_claimers` | All claimer information |
| GET | `/thorchain/tcy_claimer/{address}` | Individual claimer details |

### RUNE Pool

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/runepool` | RUNE pool data |
| GET | `/thorchain/rune_providers` | All RUNE providers |
| GET | `/thorchain/rune_provider/{address}` | Individual provider details |

### Transactions

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/tx/{hash}` | Observed transaction by hash |
| GET | `/thorchain/tx/details/{hash}` | Transaction signers and details |
| GET | `/thorchain/tx/stages/{hash}` | Transaction processing stages |
| GET | `/thorchain/tx/status/{hash}` | Transaction status |
| GET | `/thorchain/tx/{hash}/signers` | Signers (deprecated) |

### Nodes

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/nodes` | All registered validators |
| GET | `/thorchain/node/{address}` | Single node info |
| GET | `/thorchain/ban/{address}` | Node ban status |

### Vaults

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/vaults/asgard` | Asgard vault data |
| GET | `/thorchain/vaults/yggdrasil` | Yggdrasil vault data |
| GET | `/thorchain/vaults/pubkeys` | All vault public keys |
| GET | `/thorchain/vault/{pubkey}` | Vault by public key |

### Network

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/network` | Network statistics |
| GET | `/thorchain/inbound_addresses` | Asgard deposit addresses |
| GET | `/thorchain/lastblock` | Last block info all chains |
| GET | `/thorchain/lastblock/{chain}` | Last block for specific chain |
| GET | `/thorchain/version` | Node and network versions |
| GET | `/thorchain/constants` | Configuration constants |
| GET | `/thorchain/ragnarok` | Ragnarok status boolean |

### Fees

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/outbound_fees` | Outbound fees across all chains |
| GET | `/thorchain/outbound_fee/{asset}` | Single asset outbound fee |

### Upgrade Proposals

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/upgrade_proposals` | Current upgrade proposals |
| GET | `/thorchain/upgrade_proposal/{name}` | Single proposal details |
| GET | `/thorchain/upgrade_votes/{name}` | Votes for proposal |

### Streaming Swaps

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/swaps/streaming` | All streaming swap states |
| GET | `/thorchain/swap/streaming/{hash}` | Single streaming swap state |

### Clout

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/clout/swap/{address}` | Swapper clout score |

### Trade Units

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/trade/units` | All trade asset units |
| GET | `/thorchain/trade/unit/{asset}` | Trade asset units and depth |

### Trade Accounts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/trade/account/{address}` | Trade account details |
| GET | `/thorchain/trade/accounts/{asset}` | All accounts for asset |

### Secured Assets

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/securedassets` | All secured assets |
| GET | `/thorchain/securedasset/{asset}` | Single asset size and ratio |

### Queue

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/queue` | Queue statistics |
| GET | `/thorchain/queue/swap` | Swap queue items |
| GET | `/thorchain/queue/swap/details/{tx_id}` | Swap state details |
| GET | `/thorchain/queue/limit_swaps` | Paginated limit swaps |
| GET | `/thorchain/queue/limit_swaps/summary` | Limit swap statistics |
| GET | `/thorchain/queue/scheduled` | Scheduled queue |
| GET | `/thorchain/queue/outbound` | Outbound queue with RUNE values |

### TSS / Keysign

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/keysign/{height}` | Keysign info by height |
| GET | `/thorchain/keysign/{height}/{pubkey}` | Keysign for height/pubkey |
| GET | `/thorchain/keygen/{height}/{pubkey}` | Keygen info |
| GET | `/thorchain/metrics` | Keygen/keysign metrics |
| GET | `/thorchain/metric/keygen/{pubkey}` | Vault keygen metrics |

### Thornames

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/thorname/{name}` | Registered addresses for THORName |

### Mimir (Network Parameters)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/mimir` | Active mimir configuration |
| GET | `/thorchain/mimir/key/{key}` | Single mimir key value |
| GET | `/thorchain/mimir/admin` | Admin mimir config |
| GET | `/thorchain/mimir/nodes_all` | All node mimir votes |
| GET | `/thorchain/mimir/node/{address}` | Single node mimir config |

### Reference Memos

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/memo/{asset}/{reference}` | Memo by asset/reference |
| GET | `/thorchain/memo/{hash}` | Memo by hash |
| GET | `/thorchain/memo/check/{asset}/{amount}` | Preflight check |

### Quotes

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/quote/swap` | Swap quote with memo |
| GET | `/thorchain/quote/limit` | Limit order quote |
| GET | `/thorchain/quote/loan/open` | Lending quote |

### Invariants

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/invariants` | Available invariants list |
| GET | `/thorchain/invariant/{invariant}` | Run specific invariant |

### Block & Export

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/block` | Current block details |
| GET | `/thorchain/export` | Genesis export |

### Contracts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/thorchain/codes` | Whitelisted contract codes |

---

## Cosmos SDK Endpoints

These endpoints follow standard Cosmos SDK patterns:

### Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/auth/accounts/{address}` | Account info for address |

### Bank

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/bank/balances/{address}` | Token balances for address |
| GET | `/cosmos/bank/v1beta1/balances/{address}` | Balances (v1beta1) |
| GET | `/cosmos/bank/v1beta1/supply/by_denom?denom=rune` | RUNE supply |

---

## Midgard API (v2)

Midgard provides aggregated analytics data. BooneTools primary base URL: `https://gateway.liquify.com/chain/thorchain_midgard/v2`

### Key Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/v2/pools` | All pools with analytics |
| GET | `/v2/pool/{asset}` | Single pool analytics |
| GET | `/v2/member/{address}` | LP positions for address |
| GET | `/v2/members` | All liquidity providers |
| GET | `/v2/bonds/{address}` | Bond info for address |
| GET | `/v2/churns` | Churn history |
| GET | `/v2/health` | API health status |
| GET | `/v2/network` | Network statistics |
| GET | `/v2/stats` | Protocol statistics |
| GET | `/v2/history/swaps` | Swap history |
| GET | `/v2/history/earnings` | Earnings history |
| GET | `/v2/history/tvl` | TVL history |
| GET | `/v2/actions` | Transaction actions |

Full documentation: https://gateway.liquify.com/chain/thorchain_midgard/v2/doc

---

## External Resources

- [THORNode Stack Overview](https://docs.thorchain.org/thornodes/overview/thornode-stack)
- [THORChain Dev Docs](https://dev.thorchain.org)
- [Nine Realms Ops Dashboard](https://ops.ninerealms.com/links)
- [THORNode GitLab Repository](https://gitlab.com/thorchain/thornode)
