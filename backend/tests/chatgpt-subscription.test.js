import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createSignIn, consumeCallback, verifyIdentity, prepareHost, protectedWrite,
  protectedRead, withCredentialLock, accessCredentials, generateWithSubscription,
  readCompletedResponse, finishSignIn, CHATGPT_ISSUER } from '../src/lib/chatgpt-subscription.js';

const now = Date.now();
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256' };
const jwks = { keys: [jwk] };
const sign = (claims = {}) => new SignJWT({ sub: 'user', nonce: 'nonce', ...claims })
  .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(CHATGPT_ISSUER)
  .setAudience('client').setIssuedAt(Math.floor(now / 1000)).setExpirationTime(Math.floor(now / 1000) + 3600).sign(privateKey);
const fixture = { client_id: 'client', subject: 'user', access_token: 'PRIVATE_ACCESS', refresh_token: 'PRIVATE_REFRESH',
  scopes: ['chatgpt.tokens.use.direct', 'resource.invoke'], expires_at: now - 1000 };
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const eventStream = events => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
const complete = text => ({ type: 'response.completed', response: { status: 'completed', output: [
  { type: 'message', content: [{ type: 'output_text', text }] }
] } });

test('registration uses PKCE, state, nonce, app name, resource and stable host; callbacks are one-use', () => {
  const host = 'urn:uuid:12345678-1234-1234-1234-123456789abc';
  const { pending, url } = createSignIn(host, 'http://127.0.0.1:4321/auth/callback', null, now);
  const params = new URL(url).searchParams;
  assert.equal(params.get('client_id'), 'dynamic_agent_client');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.notEqual(params.get('code_challenge'), pending.verifier);
  assert.equal(params.get('ext_agent_host_id'), host);
  assert.ok(params.get('scope').includes('chatgpt.tokens.use.direct'));
  assert.throws(() => consumeCallback(pending, 'http://127.0.0.1/?state=wrong', now), /state/);
  const callback = `http://127.0.0.1/?state=${pending.state}&code=secret&client_id=client`;
  assert.deepEqual(consumeCallback(pending, callback, now), { clientId: 'client', code: 'secret' });
  assert.throws(() => consumeCallback(pending, callback, now), /state/);
  const returning = createSignIn(host, pending.redirectUri, fixture, now);
  assert.equal(new URL(returning.url).searchParams.has('agent_name_hint'), false);
  assert.throws(() => consumeCallback(returning.pending, `http://127.0.0.1/?state=${returning.pending.state}&code=a&client_id=other`, now), /client/);
});

test('OIDC validates signed identity, nonce, audience, expiry and selected account', async () => {
  const token = await sign();
  const expected = { clientId: 'client', nonce: 'nonce', subject: 'user', jwks, now };
  assert.equal((await verifyIdentity(token, expected)).sub, 'user');
  await assert.rejects(verifyIdentity(token, { ...expected, nonce: 'wrong' }));
  await assert.rejects(verifyIdentity(token, { ...expected, subject: 'other' }));
  await assert.rejects(verifyIdentity(token, { ...expected, clientId: 'other' }));
  await assert.rejects(verifyIdentity(token, { ...expected, now: now + 4_000_000 }));
  await assert.rejects(verifyIdentity(`${token.slice(0, -12)}tampered`, expected));
});

test('token exchange uses issued client ID and validates identity before accepting granted scopes', async () => {
  const host = 'urn:uuid:12345678-1234-1234-1234-123456789abc';
  const flow = createSignIn(host, 'http://127.0.0.1:4321/auth/callback', null, now);
  const token = await sign({ nonce: flow.pending.nonce });
  let calls = 0;
  const saved = await finishSignIn(flow.pending, `http://127.0.0.1/?state=${flow.pending.state}&client_id=client&code=code`, {
    now, fetchImpl: async (url, options) => {
      calls++;
      if (url.endsWith('jwks.json')) return json(jwks);
      assert.equal(options.body.get('client_id'), 'client');
      assert.equal(options.body.get('redirect_uri'), flow.pending.redirectUri);
      assert.equal(options.body.get('code_verifier'), flow.pending.verifier);
      return json({ id_token: token, access_token: 'a', refresh_token: 'r', expires_in: 3600,
        token_type: 'Bearer', scope: fixture.scopes.join(' ') });
    }
  });
  assert.equal(calls, 2);
  assert.equal(saved.subject, 'user');
  assert.equal(saved.expires_at, now + 3_600_000);
});

test('protected storage, stable host, serialized refresh and refresh-token rotation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vote-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await prepareHost(dir), await prepareHost(dir));
  const file = join(dir, 'credentials.json');
  await protectedWrite(file, fixture);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await withCredentialLock(file, async () => {
    await assert.rejects(withCredentialLock(file, async () => {}), /in use/);
    const saved = await accessCredentials(file, { now, fetchImpl: async (url, options) => {
      assert.equal(options.body.get('refresh_token'), fixture.refresh_token);
      assert.equal(options.body.has('scope'), false);
      return json({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600 });
    } });
    assert.equal(saved.refresh_token, 'new-refresh');
    assert.deepEqual(await protectedRead(file), saved);
    assert.equal((await accessCredentials(file, { now, fetchImpl: () => assert.fail('fresh tokens must be reused') })).access_token, 'new-access');
  });
  await chmod(file, 0o644);
  await assert.rejects(protectedRead(file), /owner-only/);
});

test('inference uses subscription Responses contract, completes once, and never falls back to API keys', async () => {
  const result = await generateWithSubscription(fixture, { model: 'account-model', instructions: 'summarize', input: { source: 'code' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.headers.Authorization, 'Bearer PRIVATE_ACCESS');
      assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      assert.equal(body.store, false); assert.equal(body.stream, true);
      assert.ok(Array.isArray(body.input));
      return eventStream([complete('summary')]);
    }
  });
  assert.equal(result.text, 'summary');
  let attempts = 0;
  await assert.rejects(generateWithSubscription(fixture, { model: 'm', input: {}, fetchImpl: async () => {
    attempts++; return new Response(JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: fixture.access_token } }), { status: 429 });
  } }), error => error.code === 'subscription_sharing_usage_limit_exceeded' && !error.message.includes(fixture.access_token));
  assert.equal(attempts, 1);
});

test('partial output, malformed SSE, and late usage failures cannot publish a summary', async () => {
  await assert.rejects(readCompletedResponse(eventStream([{ type: 'response.output_text.delta', delta: 'partial' }])), /stream_incomplete/);
  await assert.rejects(readCompletedResponse(eventStream([complete('good'), { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }])), /usage_limit_exceeded/);
  await assert.rejects(readCompletedResponse(eventStream([{ type: 'response.incomplete' }])), /stream_incomplete/);
  await assert.rejects(readCompletedResponse(new Response('data: not-json\n\n')), /invalid_response/);
});

test('subscription streaming can finalize text separately from an empty completed output array', async () => {
  const events = [
    { type: 'response.output_text.delta', delta: 'RE' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'READY' },
    { type: 'response.completed', response: { status: 'completed', output: [] } }
  ];
  assert.equal((await readCompletedResponse(eventStream(events))).text, 'READY');
  await assert.rejects(readCompletedResponse(eventStream(events.slice(0, -1))), /stream_incomplete/);
});
