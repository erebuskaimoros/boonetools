import { Pool } from 'pg';
import { requireConfig } from '../lib/config.js';

const pool = new Pool({
  connectionString: requireConfig('databaseUrl'),
  max: 10
});

export { pool };

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function getClient() {
  return pool.connect();
}

export async function closePool() {
  await pool.end();
}
