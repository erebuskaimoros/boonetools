import { fetchMidgardActions, fetchMidgard, MIDGARD_BASES } from './midgard.js';
import {
  buildAffiliateLegVolumeSeries, buildAffiliateTransactionRows,
  getAffiliateActionLegVolumeUsd, midgardActionTimestampSeconds,
  EXECUTED_LEG_VOLUME_BASIS
} from '../../../shared/dynamic-fees/affiliate-volume.js';

const DAY = 86400;
const REFRESH_MS = 15 * 60_000;
const MAX_TRANSACTION_ROWS = 1000;
const dateKey = (seconds) => new Date(Number(seconds) * 1000).toISOString().slice(0, 10);

export function affiliateActionIdentity(action) {
  const ids = [...new Set((action?.in || []).map((leg) => String(leg?.txID || '').trim().toUpperCase()).filter(Boolean))].sort();
  if (!ids.length) throw new Error('Affiliate action lacks a canonical inbound transaction identity');
  return ids.join(':');
}

export async function enqueueAffiliateHistory(client, params) {
  await client.query(`insert into dynamic_fee_affiliate_sync (affiliate, requested_from, requested_to)
    values ($1, $2, $3) on conflict (affiliate) do update set
      requested_from = least(dynamic_fee_affiliate_sync.requested_from, excluded.requested_from),
      requested_to = greatest(dynamic_fee_affiliate_sync.requested_to, excluded.requested_to),
      requested_at = now()`, [params.affiliate.toLowerCase(), params.fromTimestamp, params.toTimestamp]);
}

async function savePage(client, state, actions, token, seenTokens) {
  const records = actions.map((action) => ({
    action_key: affiliateActionIdentity(action), action_time: midgardActionTimestampSeconds(action.date),
    height: Number(action.height), leg_volume_usd: getAffiliateActionLegVolumeUsd(action), raw_action: action
  }));
  await client.query('begin');
  try {
    if (records.length) await client.query(`insert into dynamic_fee_affiliate_actions
      (affiliate, action_key, action_time, height, leg_volume_usd, raw_action)
      select $1, action_key, action_time, height, leg_volume_usd, raw_action
      from jsonb_to_recordset($2::jsonb) as r(action_key text, action_time bigint, height bigint, leg_volume_usd numeric, raw_action jsonb)
      on conflict (affiliate, action_key) do update set
        action_time = excluded.action_time, height = excluded.height,
        leg_volume_usd = excluded.leg_volume_usd, raw_action = excluded.raw_action, updated_at = now()
      where coalesce(dynamic_fee_affiliate_actions.raw_action->>'status', '') <> 'success'
         or excluded.raw_action->>'status' = 'success'`, [state.affiliate, JSON.stringify([...new Map(records.map((row) => [row.action_key, row])).values()])]);
    await client.query(`update dynamic_fee_affiliate_sync set page_token = $2,
      seen_tokens_json = $3::jsonb, last_error = null, updated_at = now() where affiliate = $1`,
    [state.affiliate, token, JSON.stringify(seenTokens)]);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
}

async function loadActions(client, state) {
  const { rows } = await client.query(`select raw_action from dynamic_fee_affiliate_actions
    where affiliate = $1 and action_time >= $2 and action_time < $3`, [state.affiliate, state.scan_from, state.scan_to]);
  return rows.map((row) => row.raw_action);
}

async function finishRange(client, state, points) {
  await client.query('begin');
  try {
    for (const point of points) await client.query(`insert into dynamic_fee_affiliate_days
      (affiliate, day, point_json, completed_at) values ($1, $2, $3::jsonb, $4)
      on conflict (affiliate, day) do update set point_json = excluded.point_json,
        completed_at = excluded.completed_at, observed_at = now()
      where dynamic_fee_affiliate_days.completed_at is null`,
    [state.affiliate, dateKey(point.startTime), JSON.stringify(point), point.completed_at]);
    await client.query(`update dynamic_fee_affiliate_sync set scan_from = null, scan_to = null,
      scan_watermark = null, source_base = null, page_token = '', seen_tokens_json = '[]',
      last_error = null, available_at = now(), updated_at = now() where affiliate = $1`, [state.affiliate]);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
}

/** A fixed range and opaque page cursor survive errors and per-run request budgets. */
export async function refreshAffiliateRange(client, state, options = {}) {
  const maxPages = Math.max(1, Math.min(20, Number(options.maxPages) || 10));
  const fetchActions = options.fetchActions || fetchMidgardActions;
  // A mutable day must scan a fixed source horizon, including after a restart,
  // so new activity cannot keep extending a bounded catch-up run.
  const scanUntil = Math.min(Number(state.scan_to), Number(state.scan_watermark));
  let token = state.page_token || '';
  const seenTokens = new Set(state.seen_tokens_json || []);
  let pages = 0;
  while (pages < maxPages) {
    const payload = await fetchActions({ type: 'swap', affiliate: state.affiliate, limit: '50',
      // Midgard's lower time bound is exclusive. Overlap one second and filter
      // locally so a transaction exactly at UTC midnight is still included.
      timestamp: String(scanUntil),
      ...(token ? { prevPageToken: token } : { fromTimestamp: String(Number(state.scan_from) - 1) })
    }, { bases: [state.source_base], cooldownClient: client });
    if (!Array.isArray(payload?.actions)) throw new Error('Invalid affiliate actions page');
    pages += 1;
    let reachedEnd = false;
    const actions = [];
    for (const action of payload.actions) {
      const timestamp = midgardActionTimestampSeconds(action?.date);
      if (!(timestamp > 0) || !(Number(action?.height) > 0)) throw new Error('Affiliate action is missing its timestamp or height');
      if (timestamp >= scanUntil) { reachedEnd = true; continue; }
      if (timestamp < Number(state.scan_from)) continue;
      affiliateActionIdentity(action);
      actions.push(action);
    }
    const next = String(payload?.meta?.prevPageToken || '');
    const complete = reachedEnd || payload.actions.length === 0;
    if (!complete && !next) {
      await (options.savePage || savePage)(client, state, actions, token, [...seenTokens]);
      throw new Error('Midgard nonempty affiliate page is missing its continuation token');
    }
    if (!complete && (next === token || seenTokens.has(next))) throw new Error('Midgard repeated an affiliate page token');
    if (!complete) seenTokens.add(next);
    // Keep the terminal page token until aggregation commits. A crash between
    // this transaction and finishRange safely replays that last page.
    await (options.savePage || savePage)(client, state, actions, complete ? token : next, [...seenTokens]);
    if (!complete) { token = next; continue; }
    const all = await (options.loadActions || loadActions)(client, state);
    const points = buildAffiliateLegVolumeSeries(all, { fromTimestamp: Number(state.scan_from), toTimestamp: Number(state.scan_to) });
    const nowMs = Number(options.nowMs ?? Date.now());
    for (const point of points) {
      const end = Number(point.endTime);
      const pending = all.some((action) => {
        const time = midgardActionTimestampSeconds(action.date);
        const price = Number(action?.metadata?.swap?.inPriceUSD);
        const coins = (action.in || []).flatMap((leg) => leg.coins || []);
        const usable = action.status === 'success' && Number.isFinite(price) && price > 0
          && coins.length > 0 && coins.every((coin) => /^\d+$/.test(String(coin.amount ?? '')));
        return time >= Number(point.startTime) && time < end && !usable;
      });
      point.pending = pending;
      point.completed_at = !pending && end <= Number(state.scan_watermark) && end <= nowMs / 1000 - 2 * DAY
        ? new Date(nowMs).toISOString() : null;
    }
    await (options.finishRange || finishRange)(client, state, points);
    return { complete: true, pages, days: points.length };
  }
  return { complete: false, pages };
}

async function nextRange(client, state, nowMs, options = {}) {
  const { rows } = await client.query(`select d as day
    from generate_series($2::bigint, $3::bigint - 86400, 86400) d
    left join dynamic_fee_affiliate_days p on p.affiliate = $1 and p.day = (to_timestamp(d) at time zone 'UTC')::date
    where p.day is null or (p.completed_at is null and p.observed_at < $4::timestamptz)
    order by case when d >= $5::bigint then 0 else 1 end, d asc`,
  [state.affiliate, state.requested_from, state.requested_to, new Date(nowMs - REFRESH_MS).toISOString(), Math.floor(nowMs / 1000 / DAY) * DAY - 2 * DAY]);
  if (!rows.length) return null;
  const first = Number(rows[0].day);
  const pending = new Set(rows.map((row) => Number(row.day)));
  let end = first + DAY;
  while (end - first < 7 * DAY && pending.has(end)) end += DAY;
  const base = (options.bases || MIDGARD_BASES)[0];
  const health = await (options.fetchMidgard || fetchMidgard)('/health', { bases: [base], cooldownClient: client });
  const watermark = Number(health?.lastAggregated?.timestamp);
  if (health?.database !== true || health?.inSync !== true || !(Number(health?.lastAggregated?.height) > 0)
    || !(watermark > 0) || watermark > Date.now() / 1000) throw new Error('Midgard aggregation watermark unavailable');
  await client.query(`update dynamic_fee_affiliate_sync set scan_from = $2, scan_to = $3,
    scan_watermark = $4, source_base = $5, page_token = '', seen_tokens_json = '[]', updated_at = now()
    where affiliate = $1`, [state.affiliate, first, end, watermark, base]);
  return { ...state, scan_from: first, scan_to: end, scan_watermark: watermark, source_base: base, page_token: '', seen_tokens_json: [] };
}

export async function refreshAffiliateQueue(client, options = {}) {
  let budget = Math.max(1, Math.min(20, Number(options.maxPages) || 20));
  const stats = { pages: 0, ranges: 0, errors: [] };
  for (let count = 0; count < 20 && budget > 0; count += 1) {
    const { rows } = await client.query(`select * from dynamic_fee_affiliate_sync
      where available_at <= now() and requested_at > now() - interval '7 days'
      order by available_at, requested_at limit 1`);
    let state = rows[0]; if (!state) break;
    try {
      if (!state.scan_from) state = await nextRange(client, state, Number(options.nowMs ?? Date.now()), options);
      if (!state) {
        await client.query(`update dynamic_fee_affiliate_sync set available_at = now() + interval '15 minutes' where affiliate = $1`, [rows[0].affiliate]);
        continue;
      }
      const result = await refreshAffiliateRange(client, state, { ...options, maxPages: budget });
      budget -= result.pages; stats.pages += result.pages; stats.ranges += Number(result.complete);
    } catch (error) {
      stats.errors.push({ affiliate: rows[0].affiliate, error: error?.message || String(error) });
      await client.query(`update dynamic_fee_affiliate_sync set available_at = now() + interval '5 minutes', last_error = $2 where affiliate = $1`,
      [rows[0].affiliate, error?.message || String(error)]);
      // A failed request also consumes the request budget; stop this run so a
      // shared provider outage cannot fan out across every requested affiliate.
      break;
    }
  }
  return stats;
}

export async function readAffiliateVolume(client, params) {
  const affiliate = params.affiliate.toLowerCase();
  await enqueueAffiliateHistory(client, { ...params, affiliate });
  const { rows } = await client.query(`select point_json, completed_at, observed_at from dynamic_fee_affiliate_days
    where affiliate = $1 and day >= $2::date and day < $3::date order by day`,
  [affiliate, dateKey(params.fromTimestamp), dateKey(params.toTimestamp)]);
  const points = rows.map((row) => row.point_json);
  let transactionRows = [];
  if (params.includeTransactions) {
    const result = await client.query(`select raw_action from dynamic_fee_affiliate_actions
      where affiliate = $1 and action_time >= $2 and action_time < $3
      order by leg_volume_usd desc, action_time desc, action_key limit $4`,
    [affiliate, params.fromTimestamp, params.toTimestamp, MAX_TRANSACTION_ROWS + 1]);
    transactionRows = result.rows;
  }
  const expected = Math.ceil((params.toTimestamp - params.fromTimestamp) / DAY);
  return {
    affiliate, fromTimestamp: params.fromTimestamp, toTimestamp: params.toTimestamp,
    volumeBasis: EXECUTED_LEG_VOLUME_BASIS, points,
    routeCount: points.reduce((sum, row) => sum + row.routeCount, 0),
    executedLegCount: points.reduce((sum, row) => sum + row.executedLegCount, 0),
    legVolumeUsd: points.reduce((sum, row) => sum + row.legVolumeUsd, 0),
    routeVolumeUsd: points.reduce((sum, row) => sum + row.routeVolumeUsd, 0),
    partial: points.length < expected || points.some((point) => point.pending),
    stale: rows.some((row) => !row.completed_at && Date.parse(row.observed_at) < Date.now() - REFRESH_MS),
    coverage: { days_requested: expected, days_available: points.length, days_completed: rows.filter((row) => row.completed_at).length },
    observed_at: rows.length ? new Date(Math.max(...rows.map((row) => Date.parse(row.observed_at)))).toISOString() : null,
    ...(params.includeTransactions ? { transactions: buildAffiliateTransactionRows(transactionRows.slice(0, MAX_TRANSACTION_ROWS).map((row) => row.raw_action), params), transactions_truncated: transactionRows.length > MAX_TRANSACTION_ROWS } : {}),
    source: 'midgard-actions'
  };
}
