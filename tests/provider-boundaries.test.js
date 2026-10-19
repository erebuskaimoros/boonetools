import assert from 'node:assert/strict';
import test from 'node:test';
import { auditProviderSource, checkProviderBoundaries } from '../scripts/check-provider-boundaries.mjs';

const collector = 'backend/src/jobs/example-collector.js';
test('provider boundary guard rejects raw network calls including aliases and injected raw fetches', () => {
  for (const source of [
    'await fetch(url)', 'await globalThis.fetch(url)', 'await window["fetch"](url)',
    'const send = globalThis.fetch; await send(url)', 'await (options.fetchImpl || fetch)(url)',
    'await options.fetchImpl(url)', 'await fetchImpl(url)',
    'import http from "node:https";', 'const client = await import("undici");', 'import axios from "axios";'
  ]) assert.ok(auditProviderSource(collector, source).length, source);
});

test('provider boundary guard rejects hard-coded endpoint literals and backend transport bypasses', () => {
  for (const source of [
    'const base = "https://gateway.liquify.com/chain/thorchain_midgard/v2";',
    'request(`https://new-provider.example/history?day=${day}`);',
    'import { requestFromProviders } from "../../../shared/provider-client.js";',
    'import { createProviderServices } from "../../../shared/provider-services.js";'
  ]) assert.ok(auditProviderSource(collector, source).length, source);
  assert.ok(auditProviderSource('shared/new-client.js', 'const base = process.env.MIDGARD_URL;').length);
  assert.ok(auditProviderSource('shared/new-client.js', 'const base = process["env"].MIDGARD_URL;').length);
});

test('approved transport/catalog owners, comments and provider injection contracts remain valid', () => {
  assert.deepEqual(auditProviderSource('shared/thorchain-providers.js', 'export const base = "https://provider.example/v2";'), []);
  assert.deepEqual(auditProviderSource('shared/provider-client.js', 'await fetchImpl(url);'), []);
  assert.deepEqual(auditProviderSource(collector, '// fetch("https://provider.example")\nawait request("/health", {service: "midgard"});'), []);
  assert.deepEqual(auditProviderSource(collector, 'import { requestFromProviders } from "../lib/provider-client.js";\nrequestFromProviders({fetchImpl: options.fetchImpl});'), []);
  assert.deepEqual(auditProviderSource('backend/src/protocol-fee-comparison/collector.js', 'const metadata = {nearWalletSource: "https://docs.fastnear.com/transfers/query"};'), []);
});

test('current production sources satisfy the enforced provider boundaries', async () => {
  assert.deepEqual(await checkProviderBoundaries(new URL('../', import.meta.url).pathname), []);
});
