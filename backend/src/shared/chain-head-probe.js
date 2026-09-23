import { config } from '../lib/config.js';
import { fetchThorchainRpc } from './rpc.js';

const RPC_PROBE_TIMEOUT_MS = 4_000;
const MAX_FUTURE_BLOCK_MS = 30_000;
export const MAX_STREAM_BLOCK_AGE_MS = 90_000;

// HTTP success only proves that a node answered. Compare every configured RPC
// node and the durable watermark before accepting it as the live chain head.
export async function fetchCurrentRpcHead(options = {}) {
  const fetchRpc = options.fetchRpc || fetchThorchainRpc;
  const now = options.now || Date.now;
  const rpcUrls = [...new Set(options.rpcUrls || config.rpcRestUrls)];
  const results = await Promise.allSettled(rpcUrls.map(async (base) => {
    const payload = await fetchRpc('/status', {}, {
      rpcUrls: [base], timeoutMs: RPC_PROBE_TIMEOUT_MS, cooldownClient: options.client
    });
    const sync = payload?.result?.sync_info;
    const height = Number(sync?.latest_block_height);
    const blockMs = Date.parse(sync?.latest_block_time);
    const checkedMs = now();
    if (!Number.isSafeInteger(height) || height <= 0 || !Number.isFinite(blockMs)
      || blockMs > checkedMs + MAX_FUTURE_BLOCK_MS) {
      throw new Error('RPC returned an invalid chain head');
    }
    return {
      height,
      time: new Date(blockMs).toISOString(),
      block_hash: String(sync.latest_block_hash || ''),
      catching_up: sync.catching_up !== false,
      verified_at: new Date(checkedMs).toISOString(),
      source: 'rpc-status'
    };
  }));
  const heads = results.filter((row) => row.status === 'fulfilled').map((row) => row.value);
  const minimumHeight = Math.max(Number(options.minimumHeight) || 0, ...heads.map((head) => head.height));
  const head = heads.filter((row) => !row.catching_up && row.height >= minimumHeight)
    .sort((left, right) => right.height - left.height)[0];
  if (!head) throw new Error('No synced RPC provider could confirm the current chain head');
  return head;
}

export function classifyStreamBlock(header = {}, options = {}) {
  const height = Number(header.height);
  const blockMs = Date.parse(header.time);
  const nowMs = options.nowMs ?? Date.now();
  const lastHeight = Number(options.lastHeight) || 0;
  const invalid = !Number.isSafeInteger(height) || height <= 0 || !Number.isFinite(blockMs);
  const replay = nowMs - blockMs > MAX_STREAM_BLOCK_AGE_MS;
  const future = blockMs > nowMs + MAX_FUTURE_BLOCK_MS;
  if (invalid || replay || future || height < lastHeight) {
    return { accept: false, reconnect: true, reason: invalid ? 'invalid header' : 'stale or regressing block feed' };
  }
  return { accept: height > lastHeight, reconnect: false, reason: '' };
}
