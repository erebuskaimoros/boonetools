import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { isDeepStrictEqual } from 'node:util';
import { config } from './lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key.startsWith('--') && value && !value.startsWith('--')) {
    args.set(key.slice(2), value);
    index += 1;
  }
}

const oldBase = process.env.OLD_BACKEND_BASE || `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co/functions/v1`;
const oldKey = process.env.OLD_BACKEND_KEY || process.env.VITE_NODEOP_API_KEY || process.env.VITE_RAPID_SWAPS_API_KEY || '';
const newBase = process.env.NEW_BACKEND_BASE || `http://127.0.0.1:${config.port}`;
const newKey = process.env.NEW_BACKEND_KEY || config.publicApiKey || '';
const nodeAddress = args.get('node-address') || process.env.VERIFY_NODE_ADDRESS || '';
const bondAddress = args.get('bond-address') || process.env.VERIFY_BOND_ADDRESS || '';

const cases = [
  { name: 'nodeop-meta', path: '/nodeop-meta' },
  { name: 'nodeop-leaderboard', path: '/nodeop-leaderboard?windows=10&min_participation=3' },
  { name: 'rapid-swaps', path: '/rapid-swaps' },
  { name: 'stock-prices', path: '/stock-prices?symbols=SPY,VT,GC=F' }
];

if (nodeAddress) {
  cases.unshift({
    name: 'nodeop-performance',
    path: `/nodeop-performance?node_address=${encodeURIComponent(nodeAddress)}`
  });
}

if (bondAddress) {
  cases.push({
    name: 'bond-history-current',
    path: `/bond-history?bond_address=${encodeURIComponent(bondAddress)}`
  });
  cases.push({
    name: 'bond-history-historical',
    path: `/bond-history?bond_address=${encodeURIComponent(bondAddress)}&include_historical=true`
  });
}

function stripVolatile(value) {
  if (Array.isArray(value)) {
    return value.map(stripVolatile);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if ([
      'as_of',
      'last_run_at',
      'last_scanned_at',
      'last_heartbeat',
      'freshness_seconds',
      'age_seconds',
      'observed_at'
    ].includes(key)) {
      continue;
    }

    output[key] = stripVolatile(child);
  }
  return output;
}

async function fetchJson(base, apiKey, routePath) {
  const response = await fetch(`${base}${routePath}`, {
    headers: {
      Accept: 'application/json',
      ...(apiKey ? { apikey: apiKey, Authorization: `Bearer ${apiKey}` } : {})
    }
  });

  const payload = await response.json().catch(() => null);
  return {
    status: response.status,
    payload
  };
}

let failed = false;

for (const testCase of cases) {
  const [oldResult, newResult] = await Promise.all([
    fetchJson(oldBase, oldKey, testCase.path),
    fetchJson(newBase, newKey, testCase.path)
  ]);

  const oldNormalized = stripVolatile(oldResult.payload);
  const newNormalized = stripVolatile(newResult.payload);
  const matches = oldResult.status === newResult.status && isDeepStrictEqual(oldNormalized, newNormalized);

  console.log(`${testCase.name}: ${matches ? 'OK' : 'DIFF'} (old=${oldResult.status}, new=${newResult.status})`);
  if (!matches) {
    failed = true;
    console.log(JSON.stringify({
      old: oldNormalized,
      new: newNormalized
    }, null, 2));
  }
}

process.exit(failed ? 1 : 0);
