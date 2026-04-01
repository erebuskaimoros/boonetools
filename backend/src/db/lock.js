import { pool } from './pool.js';

export async function withAdvisoryLock(lockKey, callback) {
  const client = await pool.connect();
  let locked = false;

  try {
    const { rows } = await client.query('select pg_try_advisory_lock(hashtext($1)) as locked', [lockKey]);
    locked = Boolean(rows[0]?.locked);

    if (!locked) {
      return {
        ok: true,
        skipped: true,
        reason: 'lock_not_acquired'
      };
    }

    return await callback(client);
  } finally {
    if (locked) {
      await client.query('select pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => {});
    }
    client.release();
  }
}
