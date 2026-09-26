# Vault Explorer independent balance coverage — September 26, 2026

Implemented locally; not deployed in this task. See
[the balance source and operations contract](../docs/vault-explorer-balances.md).

A live read-only collection over five Asgard vaults successfully acquired all
250 nonzero/currently recorded external-asset rows across 12 chains. Twenty-seven
legacy-router backing comparisons completed. This verifies provider plumbing at
one observation time; it is not an ongoing attestation of vault solvency.

The critical implementation finding was that AVAX/Base V6.1 vaultAllowance
returns the token's direct vault balance. Comparing those allowances against
router-held tokens creates false deficits. ETH/BSC legacy routers still need
the separate shared-router backing comparison. The implementation now uses
reviewed router custody mappings and treats unfamiliar routers as unavailable.

LTC needed BlockCypher fallback when LitecoinSpace returned intermittent 502s.
TRON reads moved to PublicNode's account/constant-contract endpoints with
TronGrid fallback after TronGrid explorer rate limits. BCH uses Haskoin:
Blockchair rejected the initial probe and the old FullStack endpoint returned
HTML. No sensitive provider credentials were used.

Tests cover drained vaults, visible zeros, unpriced assets, provider/RPC item
failures, fallback, custody models, exact units, Cosmos pagination, client expiry,
TRON contract encoding, and independent snapshot reuse. Backend acquisition
uses the existing visitor job and source-observation cache; frontend no longer
queries ETH/LTC directly.
