import { getVoteKeyReference } from '../../../shared/node-votes/key-reference.js';
import { createHash } from 'node:crypto';
import { getManualVoteKeyReference, MANUAL_REFERENCE_KEY_PATTERN } from '../../../shared/node-votes/manual-references.js';

export function collectReferenceKeys(payload) {
  return [...new Set([
    ...(payload?.by_vote || []).map(row => row.mimir_key),
    ...Object.keys(payload?.network_values?.mimirs || {}),
    ...(payload?.latest_events || []).map(row => row.mimir_key)
  ].map(key => String(key || '').trim().toUpperCase()).filter(key => /^[A-Z0-9_.-]{1,180}$/.test(key)))].sort();
}

export function createReferenceStore(client) {
  const query = (sql, values) => client.query(sql, values);
  async function applyManualReference(key, reference) {
    const fingerprint = createHash('sha256').update(JSON.stringify(reference)).digest('hex');
    await query('begin');
    try {
      await query('insert into vote_key_references(vote_key) values($1) on conflict do nothing', [key]);
      const { rows: [previous] } = await query(`select *, reference_json=$2::jsonb as matches
        from vote_key_references where vote_key=$1 for update`, [key, reference]);
      if (!previous.matches || previous.evidence_hash !== fingerprint) {
        // Preserve legacy entries even if an older deployment never wrote their
        // seed revision. Never overwrite a generated or reviewed audit record.
        if (previous.reference_json) await query(`insert into vote_key_reference_revisions
          (vote_key,evidence_hash,source_version,reference_json,evidence_json,model,outcome)
          select $1,$2,$3,$4,$5,'','manual_override_previous'
          where not exists (select 1 from vote_key_reference_revisions where vote_key=$1 and reference_json=$4::jsonb)`,
        [key, previous.evidence_hash, previous.source_version, previous.reference_json,
          { preservedBeforeManualCorrection: true, sources: previous.reference_json.sources || [] }]);
        await query(`update vote_key_references set reference_json=$2, evidence_hash=$3, source_version='',
          last_checked_at=now(), last_error='', next_attempt_at='infinity', updated_at=now() where vote_key=$1`,
        [key, reference, fingerprint]);
        await query(`insert into vote_key_reference_revisions
          (vote_key,evidence_hash,source_version,reference_json,evidence_json,model,outcome)
          values($1,$2,'',$3,$4,'','manual_override')`,
        [key, fingerprint, reference, { bundled: true, provenance: reference.provenance, nonbinding: reference.nonbinding }]);
      }
      await query('commit');
    } catch (error) { await query('rollback'); throw error; }
  }
  return {
    async seed(keys) {
      // Also correct saved aliases that have left the rolling vote inventory.
      const { rows: existingManual } = await query('select vote_key from vote_key_references where vote_key ~ $1', [MANUAL_REFERENCE_KEY_PATTERN]);
      for (const key of new Set([...keys, ...existingManual.map(row => row.vote_key)])) {
        const manual = getManualVoteKeyReference(key);
        if (manual) { await applyManualReference(key, manual); continue; }
        const seed = getVoteKeyReference(key);
        const known = seed.status !== 'unknown';
        await query(`with inserted as (
          insert into vote_key_references(vote_key, reference_json, source_version, next_attempt_at)
          values($1,$2,$3,now() + case when $4 then interval '1 day' else interval '0 seconds' end)
          on conflict(vote_key) do nothing returning vote_key
        ) insert into vote_key_reference_revisions
          (vote_key,evidence_hash,source_version,reference_json,evidence_json,model,outcome)
          select vote_key,'',$3,$2,$5,'','reviewed_seed' from inserted where $4`,
        [key, known ? seed : null, known ? seed.review.version : '', known,
          { bundled: true, sources: seed.sources, review: seed.review }]);
      }
    },
    async state() { return (await query('select * from vote_key_reference_worker where singleton')).rows[0]; },
    async due(version, limit) {
      return (await query(`select * from vote_key_references
        where vote_key !~ $3 and (next_attempt_at <= now() or (source_version <> '' and source_version <> $1 and last_error = ''))
        order by (reference_json is null) desc, next_attempt_at, vote_key limit $2`, [version, limit, MANUAL_REFERENCE_KEY_PATTERN])).rows;
    },
    async claimCall(maxCalls) {
      const { rows } = await query(`update vote_key_reference_worker set
        calls_today = case when usage_day = (now() at time zone 'UTC')::date then calls_today + 1 else 1 end,
        usage_day = (now() at time zone 'UTC')::date
        where singleton and (paused_until is null or paused_until <= now())
          and (usage_day <> (now() at time zone 'UTC')::date or calls_today < $1)
        returning calls_today`, [maxCalls]);
      return Boolean(rows.length);
    },
    async pause(reason, minutes) {
      await query(`update vote_key_reference_worker set paused_until = now() + $2 * interval '1 minute', last_error=$1 where singleton`, [reason, minutes]);
    },
    async defer(key, reason, minutes = 1440) {
      if (getManualVoteKeyReference(key)) return;
      await query(`update vote_key_references set last_checked_at=now(), last_error=$2,
        next_attempt_at=now() + $3 * interval '1 minute', updated_at=now() where vote_key=$1`, [key, reason, minutes]);
    },
    async unchanged(key, version) {
      if (getManualVoteKeyReference(key)) return;
      await query(`update vote_key_references set source_version=$2, last_checked_at=now(), last_error='',
        next_attempt_at=now() + interval '1 day', updated_at=now() where vote_key=$1`, [key, version]);
    },
    async save(key, evidence, evidenceHash, result, model, usage) {
      // A stale queued generation cannot override an editorial exception. This
      // decision comes from the bundled key allowlist, never model metadata.
      if (getManualVoteKeyReference(key)) return { skipped: true, reason: 'manual_reference' };
      await query('begin');
      try {
        await query(`insert into vote_key_reference_revisions
          (vote_key,evidence_hash,source_version,reference_json,evidence_json,model,outcome,usage_json)
          values($1,$2,$3,$4,$5,$6,$7,$8)`, [key, evidenceHash, evidence.version, result.reference || null,
          evidence, model, result.resolved ? 'generated' : 'unresolved', usage]);
        await query(`update vote_key_references set reference_json=coalesce($2,reference_json), evidence_hash=$3,
          source_version=$4, last_checked_at=now(), last_error=$5, next_attempt_at=now() + interval '1 day', updated_at=now()
          where vote_key=$1`, [key, result.reference || null, evidenceHash, evidence.version,
          result.resolved ? '' : 'insufficient_evidence']);
        await query('commit');
      } catch (error) { await query('rollback'); throw error; }
    },
    async publicCatalog() {
      const { rows } = await query('select vote_key,reference_json,last_error from vote_key_references order by vote_key');
      return Object.fromEntries(rows.filter(row => row.reference_json).map(row => [row.vote_key,
        getManualVoteKeyReference(row.vote_key) || { ...row.reference_json, update_pending: Boolean(row.last_error) }]));
    }
  };
}
