// Public HTTP providers, ordered by preference. NativeSwap is a recent-state
// fallback, not a replacement for a configured archive or a Midgard service.
export const LIQUIFY_THORNODE = 'https://gateway.liquify.com/chain/thorchain_api';
export const NATIVESWAP_THORNODE = 'https://public-thornode.nativeswap.io';
export const LIQUIFY_RPC = 'https://gateway.liquify.com/chain/thorchain_rpc';
export const LIQUIFY_MIDGARD = 'https://gateway.liquify.com/chain/thorchain_midgard/v2';
export const NATIVESWAP_RPC = 'https://public-thorchain-rpc.nativeswap.io';
export const THORNODE_PUBLIC_URLS = Object.freeze([LIQUIFY_THORNODE, NATIVESWAP_THORNODE]);
export const RPC_PUBLIC_URLS = Object.freeze([LIQUIFY_RPC, NATIVESWAP_RPC]);
export const MIDGARD_PUBLIC_URLS = Object.freeze([LIQUIFY_MIDGARD]);
