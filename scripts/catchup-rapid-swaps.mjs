#!/usr/bin/env node

/**
 * One-time catchup: scan Midgard history back to a target date,
 * find rapid swaps we missed, and upsert them to Supabase.
 */

import { createClient } from '@supabase/supabase-js';
import {
  normalizeRapidSwapAction,
  buildAssetUsdIndex
} from '../src/lib/rapid-swaps/model.js';

const SUPABASE_URL = 'https://wksusryhzxheozpgghpp.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_KEY) {
  console.error('Set SUPABASE_SERVICE_ROLE_KEY env var');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const MIDGARD_BASES = [
  'https://midgard.thorchain.network/v2',
  'https://midgard.liquify.com/v2'
];

const THORNODE_BASES = [
  'https://thornode.thorchain.network',
  'https://thornode.thorchain.liquify.com'
];

const PAGE_LIMIT = 50;
const TARGET_DATE = new Date('2026-03-22T00:00:00Z');

let activeMidgard = 0;

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'x-client-id': 'BooneTools-Catchup' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) throw new Error(`Challenge response for ${url}`);
  return res.json();
}

async function fetchWithFallback(bases, path) {
  let lastErr;
  for (let i = 0; i < bases.length; i++) {
    const idx = (activeMidgard + i) % bases.length;
    try {
      const data = await fetchJson(`${bases[idx]}${path}`);
      activeMidgard = idx;
      return data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function fetchPriceIndex() {
  const [network, pools] = await Promise.all([
    fetchWithFallback(THORNODE_BASES, '/thorchain/network'),
    fetchWithFallback(THORNODE_BASES, '/thorchain/pools')
  ]);
  return buildAssetUsdIndex(network, Array.isArray(pools) ? pools : []);
}

async function fetchExistingTxIds() {
  const ids = new Set();
  let from = 0;
  const batchSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('rapid_swaps')
      .select('tx_id')
      .range(from, from + batchSize - 1);

    if (error) throw new Error(`Supabase query failed: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) {
      ids.add(row.tx_id);
    }

    from += batchSize;
    if (data.length < batchSize) break;
  }

  return ids;
}

async function run() {
  console.log('Fetching existing rapid swap tx_ids from Supabase...');
  const existingIds = await fetchExistingTxIds();
  console.log(`Found ${existingIds.size} existing rapid swaps in DB`);

  console.log('Fetching current price index...');
  const priceIndex = await fetchPriceIndex();

  let nextPageToken = '';
  let scannedPages = 0;
  let scannedActions = 0;
  let foundNew = 0;
  let totalUpserted = 0;
  let reachedTarget = false;
  let pendingRows = [];

  const UPSERT_BATCH = 50; // Upsert every 50 new swaps found

  console.log(`Scanning Midgard actions back to ${TARGET_DATE.toISOString()}...`);

  async function flushPending() {
    if (pendingRows.length === 0) return;
    const cleaned = pendingRows.map(r => { const { raw_action, ...rest } = r; return rest; });
    const { error } = await supabase
      .from('rapid_swaps')
      .upsert(cleaned, { onConflict: 'tx_id' });
    if (error) {
      console.error(`Upsert error: ${error.message}`);
    } else {
      totalUpserted += cleaned.length;
      console.log(`  >> Upserted ${cleaned.length} swaps (${totalUpserted} total)`);
    }
    pendingRows = [];
  }

  while (!reachedTarget) {
    const params = new URLSearchParams({
      type: 'swap',
      limit: String(PAGE_LIMIT)
    });
    if (nextPageToken) {
      params.set('nextPageToken', nextPageToken);
    }

    let payload;
    try {
      payload = await fetchWithFallback(MIDGARD_BASES, `/actions?${params.toString()}`);
    } catch (err) {
      console.error(`Failed to fetch page ${scannedPages + 1}: ${err.message}`);
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    const actions = payload?.actions || [];
    scannedPages++;
    scannedActions += actions.length;

    if (actions.length === 0) {
      console.log('No more actions returned');
      break;
    }

    for (const action of actions) {
      const row = normalizeRapidSwapAction(action, {
        observedAt: new Date().toISOString(),
        priceIndex
      });

      if (row && row.tx_id && !existingIds.has(row.tx_id)) {
        foundNew++;
        pendingRows.push(row);
        existingIds.add(row.tx_id); // Prevent duplicates within run
        console.log(`  NEW: ${row.tx_id.slice(0, 12)}... ${row.source_asset} -> ${row.target_asset} $${row.input_estimated_usd} (${row.streaming_count} subs, ${row.blocks_used} blks)`);
      }

      // Check if we've gone past our target date
      const actionDate = action?.date;
      let actionMs = 0;
      if (typeof actionDate === 'string' && actionDate.includes('T')) {
        actionMs = Date.parse(actionDate);
      } else {
        const numeric = Number(actionDate);
        if (numeric > 1e15) actionMs = Math.trunc(numeric / 1e6);
        else if (numeric > 1e12) actionMs = Math.trunc(numeric);
        else actionMs = Math.trunc(numeric * 1000);
      }

      if (actionMs > 0 && actionMs < TARGET_DATE.getTime()) {
        reachedTarget = true;
        break;
      }
    }

    // Flush pending rows periodically
    if (pendingRows.length >= UPSERT_BATCH) {
      await flushPending();
    }

    nextPageToken = payload?.meta?.nextPageToken || '';
    if (!nextPageToken) {
      console.log('No more pages');
      break;
    }

    if (scannedPages % 10 === 0) {
      console.log(`  Scanned ${scannedPages} pages (${scannedActions} actions), found ${foundNew} new rapid swaps so far...`);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  // Final flush
  await flushPending();

  console.log(`\nScan complete: ${scannedPages} pages, ${scannedActions} actions scanned`);
  console.log(`Found ${foundNew} new rapid swaps, upserted ${totalUpserted}`);
  console.log('Done!')
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
