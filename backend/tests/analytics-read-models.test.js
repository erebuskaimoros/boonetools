import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test';

const {
  buildRapidSwapsSummaryPayload,
  selectRapidSwapChartBuckets
} = await import('../src/shared/rapid-swaps-dashboard.js');
const { getRapidSwapsPagination } = await import('../src/handlers/rapid-swaps.js');
const {
  decodeReservePaymentCursor,
  getRujiraReservePaymentEventPage,
  getRujiraReservePaymentsDashboardPayload
} = await import('../src/shared/rujira-reserve-payments.js');
const { buildNodeVotesSummaryPayload } = await import('../src/handlers/node-votes.js');
const { buildTcFeeDashPayload } = await import('../src/shared/tc-fee-dash.js');
const {
  buildRapidSwapMarketHistoryPayload,
  selectRapidSwapMarketHistory
} = await import('../src/shared/rapid-swaps-market-history.js');
const { refreshNodeVotesReadModel } = await import('../src/shared/node-votes-read-model.js');

test('rapid swaps defaults to a bounded page and requires explicit legacy opt-in for all rows', () => {
  const normal = getRapidSwapsPagination(new URL('http://localhost/rapid-swaps'));
  assert.equal(normal.includeAll, false);
  assert.equal(normal.limit, 50);

  const ignored = getRapidSwapsPagination(new URL('http://localhost/rapid-swaps?include_all=true'));
  assert.equal(ignored.includeAll, false);

  const legacy = getRapidSwapsPagination(new URL('http://localhost/rapid-swaps?legacy=1&include_all=true'));
  assert.equal(legacy.includeAll, true);
});

test('rapid swap chart buckets retain cumulative seeds without raw rows', () => {
  const result = selectRapidSwapChartBuckets([
    { bucket_start: '2026-07-01T00:00:00.000Z', swap_count: 2, cumulative_count: 2, cumulative_volume_usd: 20 },
    { bucket_start: '2026-07-02T00:00:00.000Z', swap_count: 3, cumulative_count: 5, cumulative_volume_usd: 50 },
    { bucket_start: '2026-07-03T00:00:00.000Z', swap_count: 4, cumulative_count: 9, cumulative_volume_usd: 90 }
  ], {
    from: Date.parse('2026-07-02T00:00:00.000Z') / 1000,
    to: Date.parse('2026-07-04T00:00:00.000Z') / 1000
  });

  assert.equal(result.buckets.length, 2);
  assert.equal(result.rowCount, 7);
  assert.equal(result.cumulativeCountBefore, 2);
  assert.equal(result.cumulativeVolumeBefore, 20);
});

test('rapid swap read model includes compact aggregates for every non-table view', async () => {
  const topSwapRow = {
    tx_id: 'TOP',
    action_date: '2026-04-25T00:00:00Z',
    observed_at: '2026-04-25T00:01:00Z',
    source_asset: 'BTC.BTC',
    target_asset: 'THOR.RUNE',
    comparable_volume_usd: 1000,
    streaming_count: 10,
    blocks_used: 2
  };
  const latestSwapRow = {
    tx_id: 'LATEST',
    action_date: '2026-07-18T00:00:00Z',
    observed_at: '2026-07-18T00:01:00Z',
    source_asset: 'BTC.BTC',
    target_asset: 'THOR.RUNE',
    comparable_volume_usd: 100,
    streaming_count: 10,
    blocks_used: 2
  };
  const client = {
    async query(sql, params = []) {
      if (sql.includes('min(observed_at)')) return { rows: [{ total_tracked: 1, cumulative_volume_usd: 100, total_subs: 10, total_blocks_used: 2, saved_blocks: 8, recent_24h_count: 1, recent_24h_volume_usd: 100 }] };
      if (sql.includes('order by comparable_volume_usd')) return { rows: [topSwapRow] };
      if (sql.includes('order by action_date desc, tx_id asc')) return { rows: [latestSwapRow] };
      if (sql.includes('where action_date >=') && sql.includes('limit $2')) return { rows: [latestSwapRow] };
      if (sql.includes("date_trunc('day'")) return { rows: [{ bucket_start: '2026-07-18', swap_count: 1, comparable_volume_usd: 100, total_subs: 10, total_blocks_used: 2, saved_blocks: 8 }] };
      if (sql.includes('cross join lateral')) return { rows: [
        { dimension: 'sub_swaps', label: '6-10', sort_order: 3, swap_count: 1, volume_usd: 100 },
        { dimension: 'time_saved_seconds', label: '<1m', sort_order: 2, swap_count: 1, volume_usd: 100 }
      ] };
      if (sql.includes('group by affiliate')) return { rows: [{ affiliate: 'be', swap_count: 1, volume_usd: 100 }] };
      if (sql.includes('group by source_asset')) return { rows: [{ source_asset: 'BTC.BTC', target_asset: 'THOR.RUNE', swap_count: 1, volume_usd: 100, avg_saved_blocks: 8, avg_pct_faster: 80 }] };
      if (sql.includes('rapid_swap_candidates')) return { rows: [{ count: 0 }] };
      if (sql.includes('rapid_swap_sync_state')) return { rows: [{ last_scanned_height: 1, last_scanned_at: '2026-07-18T00:01:00Z', stats_json: {} }] };
      if (sql.includes('rapid_swap_job_runs')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql.slice(0, 80)} ${params}`);
    }
  };

  const payload = await buildRapidSwapsSummaryPayload(client, {
    now: new Date('2026-07-18T00:02:00Z')
  });
  assert.equal(payload.chart_buckets.length, 1);
  assert.equal(payload.top_20[0].tx_id, 'TOP');
  assert.equal(payload.latest_20[0].tx_id, 'LATEST');
  assert.equal(payload.preaggregates.distributions.sub_swaps[0].bucket, '6-10');
  assert.equal(payload.preaggregates.affiliates[0].affiliate, 'be');
  assert.equal(payload.preaggregates.paths[0].avg_time_saved_seconds, 48);
  assert.deepEqual(payload.preaggregates.sankey[0], {
    source_asset: 'BTC.BTC',
    target_asset: 'THOR.RUNE',
    swap_count: 1,
    leg_volume_usd: 100,
    volume_usd: 100
  });
});

test('Reserve payment history uses an opaque bounded cursor', async () => {
  const calls = [];
  const rows = [1, 2, 3].map((height) => ({
    event_key: `event-${height}`,
    height,
    block_time: `2026-07-${20 - height}T00:00:00Z`,
    tx_id: `tx-${height}`,
    amount_base: 100000000,
    amount_rune: 1,
    rune_price_usd: 2,
    amount_usd: 2,
    coin: '100000000 THOR.RUNE',
    source: 'dune'
  }));
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows };
    }
  };
  const first = await getRujiraReservePaymentEventPage(client, { limit: 2 });
  assert.equal(first.events.length, 2);
  assert.equal(first.pagination.has_next, true);
  assert.ok(decodeReservePaymentCursor(first.pagination.next_cursor));

  await getRujiraReservePaymentEventPage(client, {
    limit: 2,
    cursor: first.pagination.next_cursor
  });
  assert.equal(calls[1].params.length, 4);
  assert.match(calls[1].sql, /block_time, height, event_key/);
});

test('Reserve summary uses all-history aggregates and keeps its bounded compatibility events chronological', async () => {
  const recentRows = [
    { event_key: 'new', height: 2, block_time: '2026-07-18T00:00:00Z', tx_id: '', payment_type: 'pol', recipient: 'thor1pol', memo: 'POL', amount_base: 1, amount_rune: 1, rune_price_usd: 2, amount_usd: 2, source: 'scheduled-cadence' },
    { event_key: 'old', height: 1, block_time: '2026-07-17T00:00:00Z', tx_id: 'old', payment_type: 'reserve', recipient: 'thor1reserve', memo: 'RESERVE', amount_base: 2, amount_rune: 2, rune_price_usd: 2, amount_usd: 4, source: 'dune' }
  ];
  const client = {
    async query(sql) {
      if (sql.includes("date_trunc('week'")) return { rows: [{ week_start: '2026-07-13', payments: 1, payment_rune: 2, payment_usd: 4, rune_price_usd: 2, pol_payments: 1, pol_rune: 1, pol_usd: 2, settlement_payments: 2, settlement_rune: 3, settlement_usd: 6, settlement_rune_price_usd: 2 }] };
      if (sql.includes("date_trunc('day'")) return { rows: [
        { day_start: '2026-07-17', payments: 1, payment_rune: 2, payment_usd: 4, rune_price_usd: 2, pol_payments: 0, pol_rune: 0, pol_usd: 0, settlement_payments: 1, settlement_rune: 2, settlement_usd: 4, settlement_rune_price_usd: 2 },
        { day_start: '2026-07-18', payments: 0, payment_rune: 0, payment_usd: 0, rune_price_usd: 0, pol_payments: 1, pol_rune: 1, pol_usd: 2, settlement_payments: 1, settlement_rune: 1, settlement_usd: 2, settlement_rune_price_usd: 2 }
      ] };
      if (sql.includes('select event_key, height')) return { rows: recentRows };
      if (sql.includes('event_count')) return { rows: [{ event_count: 2000, reserve_event_count: 1200, pol_event_count: 800, active_heights: 1200, settlement_active_heights: 1200, payment_rune: 2, payment_usd: 4, pol_rune: 1, pol_usd: 2, settlement_rune: 3, settlement_usd: 6, min_height: 1, max_height: 2, first_payment_at: '2026-01-01T00:00:00Z', latest_payment_at: '2026-07-18T00:00:00Z', first_settlement_at: '2026-01-01T00:00:00Z', latest_settlement_at: '2026-07-18T00:00:00Z', updated_at: '2026-07-18T00:01:00Z' }] };
      return { rows: [] };
    }
  };
  const payload = await getRujiraReservePaymentsDashboardPayload(client, { eventLimit: 100 });
  assert.equal(payload.daily.length, 2);
  assert.equal(payload.daily.at(-1).cumulative_usd, 4);
  assert.equal(payload.daily.at(-1).cumulative_pol_usd, 2);
  assert.equal(payload.daily.at(-1).cumulative_settlement_usd, 6);
  assert.equal(payload.meta.eventCount, 1200);
  assert.equal(payload.meta.polEventCount, 800);
  assert.equal(payload.meta.settlementEventCount, 2000);
  assert.equal(payload.meta.totalPaymentUsd, 4);
  assert.equal(payload.meta.totalPolUsd, 2);
  assert.equal(payload.meta.totalPolPaymentUsd, 2);
  assert.equal(payload.meta.totalSettlementUsd, 6);
  assert.equal(payload.recent_events[0].paymentType, 'pol');
  assert.deepEqual(payload.events.map((row) => row.event_key), ['old', 'new']);
  assert.deepEqual(payload.recent_events.map((row) => row.event_key), ['new', 'old']);
  assert.equal(payload.events_page.scope, 'latest');
  assert.equal(payload.meta.firstPaymentAt, '2026-01-01T00:00:00.000+00:00');
});

test('node vote read model strips large histories and stays DB-only', async () => {
  const voteRows = [{
    event_key: 'vote-1',
    tx_id: 'TX1',
    height: 10,
    block_time: '2026-07-18T00:00:00Z',
    event_index: 0,
    node_address: 'thor1node00000000000000000000000000000000000',
    node_operator_address: 'thor1operator000000000000000000000000000000',
    node_status: 'Active',
    mimir_key: 'HALTTRADING',
    vote_value: '1',
    vote_value_numeric: 1,
    source: 'dune',
    observed_at: '2026-07-18T00:01:00Z'
  }];
  const client = {
    async query(sql) {
      if (sql.includes('from node_votes')) return { rows: voteRows };
      return { rows: [] };
    }
  };
  const result = await buildNodeVotesSummaryPayload(client, {
    now: new Date('2026-07-18T00:02:00Z'),
    since: '2026-01-01T00:00:00Z'
  });
  assert.equal(result.payload.by_vote.length, 1);
  assert.equal(result.payload.by_vote[0].vote_history, undefined);
  assert.equal(result.payload.by_vote[0].node_votes, undefined);
  assert.ok(Array.isArray(result.payload.by_vote[0].effective_history));
  assert.equal(result.payload.by_node[0].vote_history, undefined);
  assert.equal(result.payload.chain_state.source, 'stored-node-vote-metadata');
});

test('failed Node provider refresh records an error without republishing stale chain state', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes('insert into api_read_model_runs')) return { rows: [{ id: 44 }] };
      if (sql.includes('from api_read_models')) return { rows: [] };
      return { rows: [] };
    }
  };
  await assert.rejects(() => refreshNodeVotesReadModel({
    client,
    force: true,
    now: new Date('2026-07-18T00:02:00Z'),
    loadNodeVoteChainState: async () => { throw new Error('thornode unavailable'); }
  }), /thornode unavailable/);
  assert.equal(statements.some((sql) => sql.includes('insert into api_read_models')), false);
  assert.equal(statements.some((sql) => sql.includes('update api_read_model_runs')), true);
});

test('TC Fee Dash payload is built once from the canonical database window', async () => {
  const client = {
    async query() {
      return { rows: [{
        id: 'day:2026-07-17',
        period: 'day',
        window_start: '2026-07-17',
        window_end: '2026-07-18',
        window_label: 'Jul 17',
        tc_fees_usd: 10,
        global_exchange_volume_usd: 1_000_000,
        thorchain_volume_usd: 100_000,
        updated_at: '2026-07-18T00:00:00Z'
      }] };
    }
  };
  const result = await buildTcFeeDashPayload(client, {
    generatedAt: '2026-07-18T00:01:00Z'
  });
  assert.equal(result.payload.rows.length, 1);
  assert.equal(result.payload.meta.period, 'day');
  assert.equal(result.sourceUpdatedAt, '2026-07-18T00:00:00.000Z');
});

test('scheduled swap-history snapshot supports bounded hourly and calendar-week reads', async () => {
  const calls = [];
  const payload = await buildRapidSwapMarketHistoryPayload({
    now: new Date('2026-07-20T12:34:00Z'),
    startTime: '2026-04-01T00:00:00Z',
    fetchDune: async ({ interval, from, to }) => {
      calls.push({ interval, from, to });
      const step = interval === 'hour' ? 3600 : 86400;
      return {
        meta: { source: 'dune' },
        intervals: [0, 1, 2].map((offset) => ({
          startTime: String(from + offset * step),
          endTime: String(from + (offset + 1) * step),
          totalVolumeUSD: '100',
          totalCount: '2'
        }))
      };
    }
  });
  assert.deepEqual(calls.map((call) => call.interval), ['hour', 'day']);
  assert.ok(calls.every((call) => call.from >= Date.parse('2026-04-01T00:00:00Z') / 1000));
  assert.equal(payload.segments.hour.intervals.length, 3);
  assert.equal(payload.segments.day.intervals.length, 3);

  const monday = Date.parse('2026-07-13T00:00:00Z') / 1000;
  const weekly = selectRapidSwapMarketHistory({
    as_of: '2026-07-20T12:00:00Z',
    segments: {
      day: {
        source: 'dune',
        intervals: [0, 1].map((offset) => ({
          startTime: String(monday + offset * 86400),
          endTime: String(monday + (offset + 1) * 86400),
          totalVolumeUSD: '100',
          totalCount: '2'
        }))
      }
    }
  }, {
    interval: 'week',
    from: monday,
    to: monday + 7 * 86400
  });
  assert.equal(weekly.intervals.length, 1);
  assert.equal(weekly.intervals[0].startTime, String(monday));
  assert.equal(weekly.intervals[0].totalVolumeUSD, '200');
  assert.equal(weekly.intervals[0].totalCount, '4');
});

test('Midgard swap-history fallback chunks ranges at the provider interval cap', async () => {
  const calls = [];
  const payload = await buildRapidSwapMarketHistoryPayload({
    now: new Date('2026-07-20T12:00:00Z'),
    startTime: '2026-07-01T00:00:00Z',
    fetchDune: async () => { throw new Error('dune billing limit'); },
    fetchMidgard: async ({ interval, from, to }) => {
      const step = interval === 'hour' ? 3600 : 86400;
      calls.push({ interval, from: Number(from), to: Number(to), step });
      return {
        meta: { source: 'midgard' },
        intervals: [{
          startTime: from,
          endTime: String(Math.min(Number(to), Number(from) + step)),
          totalVolumeUSD: '1',
          totalCount: '1'
        }]
      };
    }
  });

  const hourCalls = calls.filter((call) => call.interval === 'hour');
  const dayCalls = calls.filter((call) => call.interval === 'day');
  assert.equal(hourCalls.length, 2);
  assert.equal(dayCalls.length, 1);
  assert.ok(calls.every((call) => call.to - call.from <= 400 * call.step));
  assert.equal(payload.segments.hour.source, 'midgard');
  assert.equal(payload.segments.hour.meta.chunks, 2);
  assert.equal(payload.segments.day.meta.chunks, 1);
});

test('swap-history segment fallback preserves its source watermark and remains visibly stale', async () => {
  const priorObservedAt = '2026-07-19T12:00:00.000Z';
  const hourStart = Date.parse('2026-07-19T10:00:00Z') / 1000;
  const dayStart = Date.parse('2026-07-19T00:00:00Z') / 1000;
  const payload = await buildRapidSwapMarketHistoryPayload({
    now: new Date('2026-07-20T12:00:00Z'),
    startTime: '2026-04-01T00:00:00Z',
    previous: {
      as_of: priorObservedAt,
      source_updated_at: priorObservedAt,
      segments: {
        hour: {
          interval: 'hour',
          source: 'dune',
          observed_at: priorObservedAt,
          intervals: [{ startTime: String(hourStart), endTime: String(hourStart + 3600), totalVolumeUSD: '1', totalCount: '1' }]
        },
        day: {
          interval: 'day',
          source: 'midgard',
          observed_at: priorObservedAt,
          intervals: [{ startTime: String(dayStart), endTime: String(dayStart + 86400), totalVolumeUSD: '2', totalCount: '1' }]
        }
      }
    },
    fetchDune: async () => { throw new Error('dune down'); },
    fetchMidgard: async () => { throw new Error('midgard down'); }
  });

  assert.equal(payload.as_of, '2026-07-20T12:00:00.000Z');
  assert.equal(payload.source_updated_at, priorObservedAt);
  assert.equal(payload.stale, true);
  assert.equal(payload.segments.hour.observed_at, priorObservedAt);

  const selected = selectRapidSwapMarketHistory(payload, {
    interval: 'hour',
    from: hourStart,
    to: hourStart + 3600,
    nowMs: Date.parse('2026-07-20T12:00:00Z')
  });
  assert.equal(selected.stale, true);
  assert.equal(selected.meta.source_updated_at, priorObservedAt);
  assert.equal(selected.meta.source_age_seconds, 86_400);
});

test('swap-history refresh fetches overlap windows and merges them into retained history', async () => {
  const now = new Date('2026-07-20T12:00:00Z');
  const oldHour = Date.parse('2026-07-10T00:00:00Z') / 1000;
  const recentHour = Date.parse('2026-07-20T10:00:00Z') / 1000;
  const oldDay = Date.parse('2026-07-01T00:00:00Z') / 1000;
  const recentDay = Date.parse('2026-07-19T00:00:00Z') / 1000;
  const calls = [];
  const payload = await buildRapidSwapMarketHistoryPayload({
    now,
    startTime: '2026-07-01T00:00:00Z',
    previous: {
      as_of: '2026-07-20T10:30:00Z',
      segments: {
        hour: {
          observed_at: '2026-07-20T10:30:00Z',
          intervals: [oldHour, recentHour].map((startTime) => ({
            startTime: String(startTime),
            endTime: String(startTime + 3600),
            totalVolumeUSD: '1',
            totalCount: '1'
          }))
        },
        day: {
          observed_at: '2026-07-20T10:30:00Z',
          intervals: [oldDay, recentDay].map((startTime) => ({
            startTime: String(startTime),
            endTime: String(startTime + 86400),
            totalVolumeUSD: '1',
            totalCount: '1'
          }))
        }
      }
    },
    fetchDune: async ({ interval, from, to }) => {
      calls.push({ interval, from, to });
      const step = interval === 'hour' ? 3600 : 86400;
      return {
        intervals: [{
          startTime: String(from),
          endTime: String(from + step),
          totalVolumeUSD: '9',
          totalCount: '3'
        }]
      };
    }
  });

  const hourCall = calls.find((call) => call.interval === 'hour');
  const dayCall = calls.find((call) => call.interval === 'day');
  assert.equal(hourCall.from, recentHour + 3600 - 48 * 3600);
  assert.equal(dayCall.from, recentDay + 86400 - 14 * 86400);
  assert.equal(payload.segments.hour.incremental, true);
  assert.equal(payload.segments.day.incremental, true);
  assert.ok(payload.segments.hour.intervals.some((row) => Number(row.startTime) === oldHour));
  assert.ok(payload.segments.day.intervals.some((row) => Number(row.startTime) === oldDay));
  assert.ok(payload.segments.hour.intervals.some((row) => row.totalVolumeUSD === '9'));
});

test('swap-history provider deadlines fall back cleanly without object-string warnings', async () => {
  const payload = await buildRapidSwapMarketHistoryPayload({
    now: new Date('2026-07-20T12:00:00Z'),
    startTime: '2026-07-01T00:00:00Z',
    duneTimeoutMs: 5,
    fetchDune: async () => new Promise(() => {}),
    fetchMidgard: async ({ interval, from }) => {
      const step = interval === 'hour' ? 3600 : 86400;
      return {
        intervals: [{
          startTime: String(from),
          endTime: String(Number(from) + step),
          totalVolumeUSD: '1',
          totalCount: '1'
        }]
      };
    }
  });
  assert.equal(payload.segments.hour.source, 'midgard');
  assert.equal(payload.segments.day.source, 'midgard');
  assert.match(payload.warning, /timed out after 5ms/);
  assert.doesNotMatch(payload.warning, /\[object Object\]/);
});
