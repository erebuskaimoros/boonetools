const VALID_SCOPES = new Set(['current', 'historical']);
const MAX_ATTEMPTS = 5;
const RUNNING_LEASE_MINUTES = 20;

async function defaultQuery(sql, params) {
  const { query } = await import('../db/pool.js');
  return query(sql, params);
}

async function defaultGetClient() {
  const { getClient } = await import('../db/pool.js');
  return getClient();
}

function normalizeScope(scope) {
  return scope === 'historical' ? 'historical' : 'current';
}

export async function enqueueBondHistoryRefresh(payload, dependencies = {}) {
  const runQuery = dependencies.query || defaultQuery;
  const bondAddress = String(payload?.bondAddress || '').trim().toLowerCase();
  const scope = normalizeScope(payload?.scope);

  if (!bondAddress || !VALID_SCOPES.has(scope)) {
    throw new Error('A valid bond address and refresh scope are required');
  }

  const { rows } = await runQuery(
    `insert into bond_history_refresh_queue (
       bond_address,
       scope,
       include_bond_txs,
       status,
       requested_at,
       available_at,
       updated_at
     )
     values ($1, $2, $3, 'pending', now(), now(), now())
     on conflict (bond_address, scope)
     do update set
       include_bond_txs = bond_history_refresh_queue.include_bond_txs or excluded.include_bond_txs,
       status = case
         when bond_history_refresh_queue.status = 'running' then 'running'
         else 'pending'
       end,
       requested_at = case
         when bond_history_refresh_queue.status = 'running'
           and excluded.include_bond_txs
           and not bond_history_refresh_queue.include_bond_txs then now()
         when bond_history_refresh_queue.status in ('running', 'pending')
           then bond_history_refresh_queue.requested_at
         else now()
       end,
       available_at = case
         when bond_history_refresh_queue.status = 'running' then bond_history_refresh_queue.available_at
         when bond_history_refresh_queue.status = 'pending' then bond_history_refresh_queue.available_at
         else now()
       end,
       attempts = case
         when bond_history_refresh_queue.status in ('completed', 'failed') then 0
         else bond_history_refresh_queue.attempts
       end,
       completed_at = null,
       last_error = case
         when bond_history_refresh_queue.status = 'pending' then bond_history_refresh_queue.last_error
         else null
       end,
       updated_at = now()
     returning bond_address, scope, include_bond_txs, status, attempts, requested_at, available_at`,
    [bondAddress, scope, Boolean(payload?.includeBondTxs)]
  );

  return rows[0] || null;
}

export async function claimBondHistoryRefresh(dependencies = {}) {
  const acquireClient = dependencies.getClient || defaultGetClient;
  const client = await acquireClient();

  try {
    await client.query('begin');
    const { rows } = await client.query(
      `select bond_address, scope, include_bond_txs, attempts
       from bond_history_refresh_queue
       where available_at <= now()
         and (
           status = 'pending'
           or (
             status = 'running'
             and started_at < now() - ($1::text || ' minutes')::interval
           )
         )
       order by requested_at asc
       for update skip locked
       limit 1`,
      [String(RUNNING_LEASE_MINUTES)]
    );

    const job = rows[0];
    if (!job) {
      await client.query('commit');
      return null;
    }

    const claimed = await client.query(
      `update bond_history_refresh_queue
       set status = 'running',
           attempts = attempts + 1,
           started_at = date_trunc('milliseconds', now()),
           completed_at = null,
           updated_at = now()
       where bond_address = $1 and scope = $2
       returning bond_address,
                 scope,
                 include_bond_txs,
                 attempts,
                 requested_at::text as requested_at,
                 started_at::text as started_at`,
      [job.bond_address, job.scope]
    );
    await client.query('commit');
    return claimed.rows[0] || null;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function completeBondHistoryRefresh(job, result = {}, dependencies = {}) {
  const runQuery = dependencies.query || defaultQuery;
  const claimedRequestedAt = job?.requested_at || new Date(0).toISOString();
  const claimStartedAt = job?.started_at || new Date(0).toISOString();
  const { rows = [] } = await runQuery(
    `update bond_history_refresh_queue
     set status = case
           when requested_at > $3::timestamptz then 'pending'
           else 'completed'
         end,
         attempts = 0,
         include_bond_txs = case
           when requested_at > $3::timestamptz then include_bond_txs
           else false
         end,
         available_at = case
           when requested_at > $3::timestamptz then now()
           else available_at
         end,
         started_at = null,
         completed_at = case
           when requested_at > $3::timestamptz then null
           else now()
         end,
         last_error = null,
         updated_at = now()
     where bond_address = $1 and scope = $2
       and started_at = $4::timestamptz
     returning status, attempts, requested_at, available_at`,
    [job.bond_address, job.scope, claimedRequestedAt, claimStartedAt]
  );
  return {
    ...job,
    ...(rows[0] || {}),
    status: rows[0]?.status || 'superseded',
    result
  };
}

export async function failBondHistoryRefresh(job, refreshError, dependencies = {}) {
  const runQuery = dependencies.query || defaultQuery;
  const attempts = Number(job?.attempts || 1);
  const terminal = attempts >= MAX_ATTEMPTS;
  const retryDelaySeconds = Math.min(3600, 30 * (2 ** Math.max(0, attempts - 1)));
  const message = String(refreshError?.message || refreshError || 'Bond history refresh failed').slice(0, 4000);
  const claimedRequestedAt = job?.requested_at || new Date(0).toISOString();
  const claimStartedAt = job?.started_at || new Date(0).toISOString();

  const { rows = [] } = await runQuery(
    `update bond_history_refresh_queue
     set status = case
           when requested_at > $6::timestamptz then 'pending'
           else $3
         end,
         attempts = case
           when requested_at > $6::timestamptz then 0
           else attempts
         end,
         available_at = case
           when requested_at > $6::timestamptz then now()
           when $3 = 'failed' then available_at
           else now() + ($4::text || ' seconds')::interval
         end,
         started_at = null,
         completed_at = case
           when requested_at > $6::timestamptz then null
           when $3 = 'failed' then now()
           else null
         end,
         last_error = case
           when requested_at > $6::timestamptz then null
           else $5
         end,
         updated_at = now()
     where bond_address = $1 and scope = $2
       and started_at = $7::timestamptz
     returning status, attempts, requested_at, available_at`,
    [
      job.bond_address,
      job.scope,
      terminal ? 'failed' : 'pending',
      String(retryDelaySeconds),
      message,
      claimedRequestedAt,
      claimStartedAt
    ]
  );

  return {
    ...job,
    ...(rows[0] || {}),
    status: rows[0]?.status || 'superseded',
    retry_delay_seconds: rows[0]?.status === 'pending'
      ? retryDelaySeconds
      : null,
    error: message
  };
}
