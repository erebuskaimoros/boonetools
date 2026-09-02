import test from 'node:test';
import assert from 'node:assert/strict';
import { acquisitionMetrics, providerMetricKey } from '../src/lib/acquisition-metrics.js';
import { requestFromProviders } from '../src/lib/provider-client.js';

test('outbound counters exclude blocked calls and redact provider credentials and request identities', async () => {
  acquisitionMetrics({ reset: true });
  const base = 'https://gateway.invalid/api=secret/chain/thorchain_api';
  assert.equal(providerMetricKey(`${base}/thorchain/node/private-address?key=private`),
    'gateway.invalid/chain/thorchain_api/thorchain/node/:id');
  await requestFromProviders({ bases: [base], path: '/thorchain/nodes', fetchImpl: async () => new Response('[]') });
  await assert.rejects(requestFromProviders({ bases: [base], path: '/thorchain/nodes',
    beforeRequest: () => { const error = new Error('fixture'); error.name = 'ProviderCooldownError'; throw error; },
    fetchImpl: () => { throw new Error('must not run'); } }));
  const metrics = acquisitionMetrics({ reset: true });
  assert.equal(metrics.providers[0].attempts, 1);
  assert.equal(metrics.providers[0].succeeded, 1);
  assert.equal(metrics.providers[0].cooldown_skipped, 1);
  assert.equal(JSON.stringify(metrics).includes('secret'), false);
  assert.equal(acquisitionMetrics(), null);
});
