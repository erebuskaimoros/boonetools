import { join } from 'node:path';
import { withCredentialLock, accessCredentials, listModels, generateWithSubscription, SubscriptionError } from '../lib/chatgpt-subscription.js';
import { collectReferenceKeys } from './catalog.js';
import { createSourceRepository, evidenceHash } from './sources.js';
import { REFERENCE_PROMPT, validateGeneratedReference } from './generate.js';

export async function processReferences({ store, payload, version, authDirectory, sourceDirectory,
  model, maxCalls = 20, maxItems = 2, now = new Date(), source = createSourceRepository(sourceDirectory),
  generate, publish = async () => {} }) {
  await store.seed(collectReferenceKeys(payload));
  await publish(await store.publicCatalog());
  const state = await store.state();
  if (state?.paused_until && new Date(state.paused_until) > now) return { skipped: true, reason: state.last_error };
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) return { skipped: true, reason: 'source_version_unavailable' };
  const due = await store.due(version, maxItems);
  if (!due.length) return { processed: 0 };
  await source.init(version);
  let processed = 0;
  for (const row of due) {
    const key = row.vote_key;
    try {
      const evidence = await source.find(key);
      if (!evidence.sources.length || evidence.reason || evidence.truncated) {
        await store.defer(key, evidence.reason || (evidence.truncated ? 'source_too_broad' : 'source_not_found'));
        continue;
      }
      const fingerprint = evidenceHash(evidence);
      if (fingerprint === row.evidence_hash) { await store.unchanged(key, version); continue; }
      // Reviewed bundled entries need no model call at their reviewed release.
      if (row.reference_json?.status === 'reviewed' && (
        (row.reference_json.review.version === version && evidence.kind !== 'adr') ||
        (evidence.kind === 'adr' && evidence.sources.every(s => row.reference_json.sources.some(link => link.commit === s.commit && link.file === s.file)))
      )) {
        await store.unchanged(key, version); continue;
      }
      if (!await store.claimCall(maxCalls)) break;
      let response;
      if (generate) response = await generate(evidence);
      else {
        const file = join(authDirectory, 'credentials.json');
        response = await withCredentialLock(file, async () => {
          const credentials = await accessCredentials(file);
          const available = await listModels(credentials);
          if (!available.some(item => item.slug === model)) throw new SubscriptionError('subscription_sharing_unsupported_capability');
          return generateWithSubscription(credentials, { model, instructions: REFERENCE_PROMPT, input: evidence });
        });
      }
      const result = validateGeneratedReference(response.text, evidence, { now, model });
      await store.save(key, evidence, fingerprint, result, model, response.usage);
      processed++;
    } catch (error) {
      if (error instanceof SubscriptionError || error.code === 'ENOENT') {
        const code = error.code === 'ENOENT' ? 'sign_in_required' : error.code;
        const minutes = /usage_limit|not_eligible|unauthorized|invalid_grant|usage_disabled|sign_in_required|unsupported/.test(code) ? 360 : 15;
        await store.pause(code, minutes);
        break;
      }
      // Source/model diagnostics are untrusted and never echoed to the website.
      await store.defer(key, 'reference_generation_failed', 60);
    }
  }
  await publish(await store.publicCatalog());
  return { processed };
}
