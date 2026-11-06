// Independent OAuth/Responses transport. Never uses Platform API keys or the
// THORChain acquisition pool. Only this module may handle subscription tokens.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, lstat, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { createLocalJWKSet, jwtVerify } from 'jose';

export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const TOKEN_ROUTE = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
const random = () => randomBytes(32).toString('base64url');

export class SubscriptionError extends Error {
  constructor(code, httpStatus = 0) {
    // Remote messages/bodies can contain credentials. Only an allowlisted code
    // and numeric HTTP status may reach logs or the public reference catalog.
    const safe = /^(subscription_sharing_[a-z_]+|chatpass_v2_[a-z_]+|invalid_grant|access_denied|unauthorized|invalid_response|request_failed|stream_incomplete|usage_disabled|sign_in_required)$/.test(code)
      ? code : 'request_failed';
    super(`ChatGPT subscription: ${safe}${httpStatus ? ` (HTTP ${httpStatus})` : ''}`);
    this.code = safe;
    this.httpStatus = httpStatus;
  }
}

export async function protectedRead(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('Credential storage must be a regular owner-only file');
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function protectedWrite(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    await rename(temp, file);
  } finally {
    await handle.close().catch(() => {});
    await rm(temp, { force: true });
  }
}

export async function withCredentialLock(file, action) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') {
      // A killed oneshot must not leave token refresh permanently blocked.
      // Serialize recovery, and only recover an explicitly dead local owner.
      const recovery = `${lock}.recovery`;
      let recovered = false;
      try {
        await mkdir(recovery, { mode: 0o700 });
        try {
          const owner = await protectedRead(join(lock, 'owner.json')).catch(() => null);
          if (owner?.host === hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); }
            catch (probe) {
              if (probe.code === 'ESRCH') { await rm(lock, { recursive: true, force: true }); recovered = true; }
            }
          }
        } finally { await rm(recovery, { recursive: true, force: true }); }
      } catch { /* An active recovery/owner is never displaced. */ }
      if (recovered) return withCredentialLock(file, action);
      throw new Error('ChatGPT credentials are in use; retry after the other process finishes');
    }
    throw error;
  }
  try {
    await protectedWrite(join(lock, 'owner.json'), { pid: process.pid, host: hostname() });
    return await action();
  }
  finally { await rm(lock, { recursive: true, force: true }); }
}

export async function prepareHost(directory) {
  const file = join(directory, 'host.json');
  return withCredentialLock(file, async () => {
    const existing = await protectedRead(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (existing) return existing.ext_agent_host_id;
    const host = `urn:uuid:${randomUUID()}`;
    await protectedWrite(file, { ext_agent_host_id: host });
    return host;
  });
}

export function createSignIn(hostId, redirectUri, saved = null, now = Date.now()) {
  if (!/^urn:uuid:[0-9a-f-]{36}$/.test(hostId)) throw new Error('Invalid host ID');
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || redirect.pathname !== '/auth/callback') throw new Error('Use the loopback /auth/callback');
  const pending = { state: random(), nonce: random(), verifier: random(), redirectUri,
    hostId, clientId: saved?.client_id || 'dynamic_agent_client', subject: saved?.subject,
    expiresAt: now + 10 * 60_000, consumed: false };
  const params = new URLSearchParams({ client_id: pending.clientId, ext_agent_host_id: hostId,
    response_type: 'code', redirect_uri: redirectUri, scope: CHATGPT_SCOPES,
    resource: CHATGPT_RESOURCE, state: pending.state, nonce: pending.nonce,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(pending.verifier).digest('base64url') });
  if (!saved) params.set('agent_name_hint', 'BooneTools Vote References');
  return { pending, url: `${CHATGPT_ISSUER}/api/accounts/authorize?${params}` };
}

export function consumeCallback(pending, url, now = Date.now()) {
  const params = new URL(url).searchParams;
  if (pending.consumed || pending.expiresAt <= now || params.get('state') !== pending.state) throw new Error('Invalid or expired sign-in state');
  pending.consumed = true;
  if (params.has('error')) throw new SubscriptionError('access_denied');
  const clientId = params.get('client_id') || pending.clientId;
  if (!clientId || clientId === 'dynamic_agent_client' ||
      (pending.clientId !== 'dynamic_agent_client' && clientId !== pending.clientId)) throw new Error('Invalid sign-in client');
  const code = params.get('code');
  if (!code) throw new Error('Missing sign-in code');
  return { clientId, code };
}

async function request(url, options = {}, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: options.signal || AbortSignal.timeout(120_000) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new SubscriptionError(body.error?.code || body.error || 'request_failed', response.status);
    }
    return response;
  } catch (error) {
    if (error instanceof SubscriptionError) throw error;
    throw new SubscriptionError('request_failed');
  }
}

async function readJson(response) {
  try { return await response.json(); }
  catch { throw new SubscriptionError('invalid_response'); }
}

export async function verifyIdentity(idToken, { clientId, nonce, subject, jwks, now = Date.now() }) {
  const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
    issuer: CHATGPT_ISSUER, audience: clientId, algorithms: ['RS256'],
    requiredClaims: ['sub', 'exp', 'iat', 'nonce'], clockTolerance: 5, currentDate: new Date(now)
  });
  if (payload.nonce !== nonce || !payload.sub || (subject && subject !== payload.sub)) throw new Error('Sign-in identity did not match');
  return payload;
}

function credentials(tokens, previous, now = Date.now()) {
  const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/) : previous?.scopes || [];
  if (!scopes.includes('chatgpt.tokens.use.direct') || !scopes.includes('resource.invoke')) throw new SubscriptionError('usage_disabled');
  if (typeof tokens.access_token !== 'string' || !tokens.access_token ||
      !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 ||
      String(tokens.token_type).toLowerCase() !== 'bearer') throw new SubscriptionError('invalid_response');
  const refresh = tokens.refresh_token || previous?.refresh_token;
  if (typeof refresh !== 'string' || !refresh) throw new SubscriptionError('invalid_response');
  return { ...previous, access_token: tokens.access_token, refresh_token: refresh,
    id_token: tokens.id_token || previous?.id_token || null, token_type: 'Bearer', scopes,
    expires_at: now + tokens.expires_in * 1000, saved_at: new Date(now).toISOString() };
}

export async function finishSignIn(pending, callbackUrl, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const { clientId, code } = consumeCallback(pending, callbackUrl, now);
  const response = await request(TOKEN_ROUTE, { method: 'POST', body: new URLSearchParams({
    grant_type: 'authorization_code', client_id: clientId, code,
    code_verifier: pending.verifier, redirect_uri: pending.redirectUri, resource: CHATGPT_RESOURCE
  }) }, fetchImpl);
  const tokens = await readJson(response);
  const jwks = await readJson(await request(`${CHATGPT_ISSUER}/.well-known/jwks.json`, {}, fetchImpl));
  let identity;
  try { identity = await verifyIdentity(tokens.id_token, { clientId, nonce: pending.nonce, subject: pending.subject, jwks, now }); }
  catch { throw new SubscriptionError('unauthorized'); }
  return credentials(tokens, { client_id: clientId, subject: identity.sub, issuer: identity.iss,
    email: identity.email || '', ext_agent_host_id: pending.hostId }, now);
}

// Caller holds the credential lock for refresh + inference. A rotating refresh
// token must have one owner; never run the imported session on both machines.
export async function accessCredentials(file, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const saved = await protectedRead(file);
  if (!saved.scopes?.includes('chatgpt.tokens.use.direct')) throw new SubscriptionError('usage_disabled');
  if (saved.expires_at > now + 60_000) return saved;
  const response = await request(TOKEN_ROUTE, { method: 'POST', body: new URLSearchParams({
    grant_type: 'refresh_token', client_id: saved.client_id,
    refresh_token: saved.refresh_token, resource: CHATGPT_RESOURCE
  }) }, fetchImpl);
  const updated = credentials(await readJson(response), saved, now);
  await protectedWrite(file, updated);
  return updated;
}

export async function listModels(saved, { fetchImpl = globalThis.fetch } = {}) {
  const response = await request(`${CHATGPT_RESOURCE}/models`, { headers: { Authorization: `Bearer ${saved.access_token}` } }, fetchImpl);
  const payload = await readJson(response);
  if (!Array.isArray(payload.models)) throw new SubscriptionError('invalid_response');
  return payload.models.filter(model => model.visibility === 'list' && typeof model.slug === 'string')
    .map(model => ({ slug: model.slug, display_name: model.display_name }));
}

export async function readCompletedResponse(response) {
  let buffer = '', size = 0, completed = null;
  const finishedText = new Map();
  const decoder = new TextDecoder();
  const handle = frame => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let event;
    try { event = JSON.parse(data); } catch { throw new SubscriptionError('invalid_response'); }
    if (event.type === 'response.failed' || event.type === 'error') throw new SubscriptionError(event.response?.error?.code || event.code || 'request_failed');
    if (event.type === 'response.incomplete') throw new SubscriptionError('stream_incomplete');
    if (event.type === 'response.output_text.done' && typeof event.text === 'string') {
      finishedText.set(`${event.output_index || 0}:${event.content_index || 0}`, event.text);
    }
    if (event.type === 'response.completed') completed = event.response;
  };
  try {
    for await (const bytes of response.body) {
      size += bytes.length;
      if (size > 2_000_000) throw new SubscriptionError('invalid_response');
      buffer += decoder.decode(bytes, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) { handle(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handle(buffer);
  } catch (error) { throw error instanceof SubscriptionError ? error : new SubscriptionError('stream_incomplete'); }
  if (!completed || completed.status !== 'completed') throw new SubscriptionError('stream_incomplete');
  const text = (completed.output || []).flatMap(item => item.content || [])
    .filter(item => item.type === 'output_text').map(item => item.text).join('')
    || [...finishedText.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([, value]) => value).join('');
  if (!text || text.length > 32_000) throw new SubscriptionError('invalid_response');
  return { text, usage: completed.usage || null };
}

export async function generateWithSubscription(saved, { model, instructions, input, fetchImpl = globalThis.fetch }) {
  if (!saved.scopes?.includes('chatgpt.tokens.use.direct')) throw new SubscriptionError('usage_disabled');
  if (!model || JSON.stringify(input).length > 160_000) throw new Error('Missing model or oversized source input');
  const response = await request(`${CHATGPT_RESOURCE}/responses`, {
    method: 'POST', headers: { Authorization: `Bearer ${saved.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, instructions, input: [{ role: 'user', content: JSON.stringify(input) }], store: false, stream: true })
  }, fetchImpl);
  return readCompletedResponse(response);
}
