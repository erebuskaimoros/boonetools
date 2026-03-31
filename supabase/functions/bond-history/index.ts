import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  CORS_HEADERS,
  errorResponse,
  jsonResponse,
  requireMethod,
  isValidThorAddress
} from '../_shared/validation.ts';
import { fetchThorchain, fetchChurns } from '../_shared/thornode.ts';

function createAdminClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

/** Fetch node data at a specific block height from the official THORNode endpoint. */
async function fetchNodeAtHeight(nodeAddress: string, height: number): Promise<any> {
  const endpoint = `/thorchain/node/${nodeAddress}?height=${height}`;
  return fetchThorchain(endpoint, { historical: true });
}

/** Fetch network data at a specific block height */
async function fetchNetworkAtHeight(height: number): Promise<any> {
  const endpoint = `/thorchain/network?height=${height}`;
  return fetchThorchain(endpoint, { historical: true });
}

/** Get current node addresses for a bond provider */
async function getCurrentNodeAddresses(bondAddress: string): Promise<string[]> {
  const res = await fetch(
    `https://midgard.thorchain.network/v2/bonds/${bondAddress}`,
    { headers: { Accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`Midgard bonds failed (${res.status})`);
  const data = await res.json();
  return (data.nodes || [])
    .filter((n: any) => Number(n.bond) > 1e8)
    .map((n: any) => n.address);
}

/** Get ALL node addresses a bond provider has ever bonded to (current + historical via Midgard actions).
 *  Also returns the earliest block height at which a current node was bonded to. */
async function getAllNodeAddresses(bondAddress: string): Promise<{
  current: string[];
  all: string[];
  currentNodesSinceHeight: number;
}> {
  const currentNodes = await getCurrentNodeAddresses(bondAddress);
  const currentSet = new Set<string>(currentNodes);
  const nodeSet = new Set<string>(currentNodes);
  let earliestCurrentBondHeight = Infinity;

  try {
    let offset = 0;
    const limit = 50;
    let hasMore = true;
    while (hasMore) {
      const res = await fetch(
        `https://midgard.thorchain.network/v2/actions?address=${bondAddress}&type=bond&limit=${limit}&offset=${offset}`,
        { headers: { Accept: 'application/json' } }
      );
      if (!res.ok) break;
      const data = await res.json();
      const actions = data.actions || [];
      for (const action of actions) {
        const nodeAddr = action.metadata?.bond?.nodeAddress;
        if (!nodeAddr || !nodeAddr.startsWith('thor1')) continue;
        nodeSet.add(nodeAddr);
        // Track the earliest bond action to a current node
        if (currentSet.has(nodeAddr)) {
          const h = Number(action.height);
          if (h > 0 && h < earliestCurrentBondHeight) {
            earliestCurrentBondHeight = h;
          }
        }
      }
      if (actions.length < limit) {
        hasMore = false;
      } else {
        offset += limit;
      }
    }
  } catch { /* best-effort — current nodes still available */ }

  return {
    current: currentNodes,
    all: Array.from(nodeSet),
    currentNodesSinceHeight: earliestCurrentBondHeight === Infinity ? 0 : earliestCurrentBondHeight
  };
}

/** Fetch current exchange rates for multi-currency support */
async function fetchRatesJson(): Promise<Record<string, number> | null> {
  try {
    const [fiatRes, cryptoRes] = await Promise.allSettled([
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=thorchain&vs_currencies=eur,gbp,jpy,btc,xau'),
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero,zcash&vs_currencies=usd')
    ]);

    const rates: Record<string, number> = {};

    if (fiatRes.status === 'fulfilled' && fiatRes.value.ok) {
      const data = await fiatRes.value.json();
      const tc = data?.thorchain;
      // Store USD-to-fiat conversion factors (derived from RUNE prices)
      // We store the USD price of each asset, so for fiat: USD/EUR rate
      if (tc?.eur) rates.EUR = 1 / tc.eur; // Not direct — see note below
      if (tc?.gbp) rates.GBP = 1 / tc.gbp;
      if (tc?.jpy) rates.JPY = 1 / tc.jpy;
      if (tc?.btc) rates.BTC = 1 / tc.btc; // Not useful this way
      if (tc?.xau) rates.XAU = 1 / tc.xau;
    }

    // Actually, we want to store the USD price of each asset so the frontend can do:
    // value_in_asset = value_in_usd / asset_usd_price
    // For fiat: EUR rate = how many USD per 1 EUR? We need a forex rate.
    // Better approach: store the RUNE price in each currency directly, matching the frontend rates format
    // Reset and use the proper approach
    const ratesFinal: Record<string, number> = {};

    if (fiatRes.status === 'fulfilled' && fiatRes.value.ok) {
      const data = await fiatRes.value.json();
      const tc = data?.thorchain;
      // These are RUNE prices in each currency (same format as frontend exchangeRates store)
      if (tc?.eur) ratesFinal.EUR = tc.eur;
      if (tc?.gbp) ratesFinal.GBP = tc.gbp;
      if (tc?.jpy) ratesFinal.JPY = tc.jpy;
      if (tc?.btc) ratesFinal.BTC = tc.btc;
      if (tc?.xau) ratesFinal.XAU = tc.xau;
    }

    if (cryptoRes.status === 'fulfilled' && cryptoRes.value.ok) {
      const data = await cryptoRes.value.json();
      // XMR and ZEC: we have their USD prices, compute RUNE/XMR and RUNE/ZEC
      // Not possible without RUNE/USD here — but we store the USD prices and let frontend compute
      if (data?.monero?.usd) ratesFinal.XMR_USD = data.monero.usd;
      if (data?.zcash?.usd) ratesFinal.ZEC_USD = data.zcash.usd;
    }

    // Try to get SPY/VT/gold from our stock-prices function
    try {
      const stockUrl = Deno.env.get('SUPABASE_URL') || '';
      const stockKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      if (stockUrl) {
        const stockRes = await fetch(`${stockUrl}/functions/v1/stock-prices?symbols=SPY,VT,GC=F`, {
          headers: { Authorization: `Bearer ${stockKey}`, apikey: stockKey }
        });
        if (stockRes.ok) {
          const stockData = await stockRes.json();
          if (stockData.SPY) ratesFinal.SPY_USD = stockData.SPY;
          if (stockData.VT) ratesFinal.VT_USD = stockData.VT;
          if (stockData['GC=F'] && !ratesFinal.XAU) ratesFinal.XAU_USD = stockData['GC=F'];
        }
      }
    } catch { /* Stock prices are best-effort */ }

    return Object.keys(ratesFinal).length > 0 ? ratesFinal : null;
  } catch {
    return null;
  }
}

/** Process one churn: get bond + pending reward for a bond provider across nodes */
async function processChurn(
  bondAddress: string,
  nodeAddresses: string[],
  churnHeight: number,
  churnTimestamp: number,
  ratesJson: Record<string, number> | null
): Promise<{ churn_height: number; churn_timestamp: number; rune_stack: number; rune_price: number; user_bond: number; rates_json: Record<string, number> | null }> {
  // Fetch all node data + network data in parallel
  const nodePromises = nodeAddresses.map(addr =>
    fetchNodeAtHeight(addr, churnHeight - 1).catch(() => null)
  );
  const networkPromise = fetchNetworkAtHeight(churnHeight).catch(() => null);

  const [nodeResults, networkData] = await Promise.all([
    Promise.all(nodePromises),
    networkPromise
  ]);

  let totalUserBond = 0;
  let totalUserBondOnly = 0;

  for (const nodeData of nodeResults) {
    if (!nodeData) continue;
    const providers = nodeData?.bond_providers?.providers || [];
    const operatorFee = Number(nodeData?.bond_providers?.node_operator_fee || 0) / 10000;
    const nodeCurrentAward = Number(nodeData?.current_award || 0) * (1 - operatorFee);

    let userBond = 0;
    let nodeTotalBond = 0;
    for (const p of providers) {
      if (p.bond_address === bondAddress) userBond = Number(p.bond);
      nodeTotalBond += Number(p.bond);
    }

    if (userBond > 0 && nodeTotalBond > 0) {
      totalUserBondOnly += userBond;
      totalUserBond += userBond + (userBond / nodeTotalBond) * nodeCurrentAward;
    }
  }

  const runePrice = Number(networkData?.rune_price_in_tor || 0) / 1e8;

  return {
    churn_height: churnHeight,
    churn_timestamp: churnTimestamp,
    rune_stack: Math.round(totalUserBond),
    user_bond: Math.round(totalUserBondOnly),
    rune_price: runePrice,
    rates_json: ratesJson
  };
}

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const methodError = requireMethod(req, 'GET');
  if (methodError) return errorResponse(methodError, 405);

  const url = new URL(req.url);
  const bondAddress = (url.searchParams.get('bond_address') || '').trim().toLowerCase();
  const includeHistorical = url.searchParams.get('include_historical') === 'true';

  if (!isValidThorAddress(bondAddress)) {
    return errorResponse('Invalid bond_address parameter', 400);
  }

  try {
    const db = createAdminClient();

    // 1. Get cached data
    const { data: cached, error: cacheErr } = await db
      .from('bond_history')
      .select('churn_height, churn_timestamp, rune_stack, user_bond, rune_price, rates_json')
      .eq('bond_address', bondAddress)
      .order('churn_height', { ascending: true });

    if (cacheErr) throw new Error(`DB read failed: ${cacheErr.message}`);

    // When switching to historical mode, cached zero-balance rows may be stale
    // (they were zero because only current nodes were checked). Re-fetch them.
    const cachedHeights = new Set(
      (cached || []).filter((r: any) => r.user_bond != null && (!includeHistorical || r.rune_stack > 0))
        .map((r: any) => r.churn_height)
    );
    const latestCached = cached && cached.length > 0
      ? Math.max(...cached.map((r: any) => r.churn_height))
      : 0;

    // 2. Get node addresses for this bond provider
    const { current: currentNodes, all: allNodes, currentNodesSinceHeight } = await getAllNodeAddresses(bondAddress);
    const hasHistorical = allNodes.length > currentNodes.length;
    const nodeAddresses = includeHistorical ? allNodes : currentNodes;
    if (nodeAddresses.length === 0) {
      return errorResponse('No active bonds found for this address', 404);
    }

    // 3. Get all churns from Midgard
    const allChurns = await fetchChurns();
    const churns = allChurns.map((c: any) => ({
      height: Number(c.height),
      timestampSec: Math.floor(Number(c.date) / 1e9)
    }));

    // 4. Find churns we need to fetch (not cached yet)
    const uncached = churns.filter((c: any) => !cachedHeights.has(c.height));

    // If everything is cached, return immediately
    if (uncached.length === 0) {
      const minHeight = includeHistorical ? 0 : currentNodesSinceHeight;
      const filtered = (cached || []).filter((r: any) => r.rune_stack > 0 && r.churn_height >= minHeight);
      return jsonResponse({
        bond_address: bondAddress,
        history: filtered,
        has_historical: hasHistorical,
        fetched: 0,
        total: filtered.length
      }, 200, { 'Cache-Control': 'public, max-age=30' });
    }

    // 5. Fetch uncached churns (newest first, stop when bond is zero for N consecutive)
    // Use higher threshold for historical mode since there can be gaps between nodes
    uncached.sort((a: any, b: any) => b.height - a.height);
    const zeroThreshold = includeHistorical ? 5 : 2;

    const newRows: any[] = [];
    let consecutiveZero = 0;

    // Fetch exchange rates once (current rates, same for all rows)
    const ratesJson = await fetchRatesJson();

    for (const churn of uncached) {
      const result = await processChurn(bondAddress, nodeAddresses, churn.height, churn.timestampSec, ratesJson);
      newRows.push({ bond_address: bondAddress, ...result });

      if (result.rune_stack === 0) {
        consecutiveZero++;
        if (consecutiveZero >= zeroThreshold) break;
      } else {
        consecutiveZero = 0;
      }
    }

    // 6. Upsert new rows to DB (chunks of 200)
    if (newRows.length > 0) {
      for (let i = 0; i < newRows.length; i += 200) {
        const chunk = newRows.slice(i, i + 200);
        const { error: upsertErr } = await db
          .from('bond_history')
          .upsert(chunk, { onConflict: 'bond_address,churn_height' });

        if (upsertErr) {
          console.error('Upsert error:', upsertErr.message);
        }
      }
    }

    // 7. Return combined data (cached + new), sorted chronologically
    const allData = [
      ...(cached || []),
      ...newRows.map(r => ({
        churn_height: r.churn_height,
        churn_timestamp: r.churn_timestamp,
        rune_stack: r.rune_stack,
        user_bond: r.user_bond,
        rune_price: r.rune_price,
        rates_json: r.rates_json
      }))
    ];

    // Deduplicate, sort, and filter
    const minHeight = includeHistorical ? 0 : currentNodesSinceHeight;
    const byHeight = new Map();
    for (const row of allData) {
      if (row.churn_height >= minHeight) {
        byHeight.set(row.churn_height, row);
      }
    }
    const history = Array.from(byHeight.values())
      .sort((a: any, b: any) => a.churn_height - b.churn_height);

    // Remove leading zero entries (before wallet bonded)
    while (history.length > 0 && history[0].rune_stack === 0) {
      history.shift();
    }

    return jsonResponse({
      bond_address: bondAddress,
      history,
      has_historical: hasHistorical,
      fetched: newRows.length,
      total: history.length
    }, 200, { 'Cache-Control': 'public, max-age=30' });

  } catch (err) {
    console.error('bond-history error:', err);
    return errorResponse(err instanceof Error ? err.message : 'Internal error', 500);
  }
});
