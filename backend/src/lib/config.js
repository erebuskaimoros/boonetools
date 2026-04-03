import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultEnvPath = path.resolve(__dirname, '../../.env');

dotenv.config({
  path: process.env.BOONETOOLS_ENV_FILE || defaultEnvPath
});

function readInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function optional(value) {
  return String(value || '').trim();
}

export const config = Object.freeze({
  port: readInt('PORT', 8787),
  databaseUrl: optional(process.env.DATABASE_URL),
  publicApiKey: optional(
    process.env.PUBLIC_API_KEY
      || process.env.VITE_NODEOP_API_KEY
      || process.env.VITE_RAPID_SWAPS_API_KEY
  ),
  thornodePrimaryUrl: optional(process.env.THORNODE_PRIMARY_URL) || 'https://thornode.thorchain.network',
  thornodeArchiveUrl: optional(process.env.THORNODE_ARCHIVE_URL) || 'https://thornode-archive.ninerealms.com',
  thornodeFallbackUrl: optional(process.env.THORNODE_FALLBACK_URL) || 'https://thornode.ninerealms.com',
  midgardUrl: optional(process.env.MIDGARD_URL) || 'https://midgard.thorchain.network/v2',
  midgardFallbackUrl: optional(process.env.MIDGARD_FALLBACK_URL) || 'https://midgard.ninerealms.com/v2',
  rpcWsUrl: optional(process.env.RPC_WS_URL) || 'wss://rpc.thorchain.network/websocket',
  midgardDelayMs: readInt('MIDGARD_DELAY_MS', 5000),
  rapidSwapsMaxPages: readInt('RAPID_SWAPS_MAX_PAGES', 200),
  rapidSwapsCatchupMaxPages: readInt('RAPID_SWAPS_CATCHUP_MAX_PAGES', 200),
  rapidSwapsHeightOverlapBlocks: readInt('RAPID_SWAPS_HEIGHT_OVERLAP_BLOCKS', 1800),
  rapidSwapsMaxCandidateAttempts: readInt('RAPID_SWAPS_MAX_CANDIDATE_ATTEMPTS', 12),
  rapidSwapsPendingCandidateBatch: readInt('RAPID_SWAPS_PENDING_CANDIDATE_BATCH', 100)
});

export function requireConfig(key) {
  const value = config[key];
  if (!value) {
    throw new Error(`Missing required config: ${key}`);
  }
  return value;
}
