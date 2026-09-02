export function acquisitionDatabase() {
  const rows = new Map();
  return { rows, async query(sql, params = []) {
    const key = `${params[0]}:${params[1]}`;
    if (sql.includes('pg_advisory')) return { rows: [{ locked: true }] };
    if (sql.includes('from source_observations')) return { rows: rows.has(key) ? [rows.get(key)] : [] };
    if (sql.includes('insert into source_observations')) {
      const old = rows.get(key);
      if (old?.completed_at && !(params[8] && params[6])) return { rows: [], rowCount: 0 };
      const row = { namespace: params[0], identity: params[1], payload_json: JSON.parse(params[2]),
        source: params[3], observed_at: params[4], expires_at: params[5], completed_at: params[6],
        metadata_json: JSON.parse(params[7]) };
      rows.set(key, row);
      return { rows: [row], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
}
