import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { protectedRead, protectedWrite, prepareHost, createSignIn, finishSignIn,
  withCredentialLock, accessCredentials, listModels, generateWithSubscription } from '../src/lib/chatgpt-subscription.js';

const command = process.argv[2] || 'status';
const directory = resolve(process.env.VOTE_REFERENCE_AUTH_DIR || join(homedir(), '.config/boonetools/vote-references'));
const file = join(directory, 'credentials.json');

async function login() {
  const hostId = await prepareHost(directory);
  await withCredentialLock(file, async () => {
    const saved = await protectedRead(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    let flow;
    let handling = false;
    let done;
    const result = new Promise(resolveResult => { done = resolveResult; });
    const server = createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      if (req.method !== 'GET' || !req.url.startsWith('/auth/callback?') || handling) {
        res.writeHead(404); res.end('Not found'); return;
      }
      // Ignore unrelated callbacks; they must not consume the valid attempt.
      if (new URL(req.url, flow.pending.redirectUri).searchParams.get('state') !== flow.pending.state) {
        res.writeHead(400); res.end('Invalid sign-in state'); return;
      }
      handling = true;
      try {
        const record = await finishSignIn(flow.pending, new URL(req.url, flow.pending.redirectUri));
        await protectedWrite(file, record);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><title>BooneTools subscription connected</title><script>history.replaceState(null,"","/connected")</script><p>BooneTools subscription connected. You can close this tab.</p>');
        done({ ok: true });
      } catch (error) {
        res.writeHead(400); res.end('BooneTools sign-in failed. Return to the terminal for the status.');
        done({ error });
      }
    });
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
    const redirect = `http://127.0.0.1:${server.address().port}/auth/callback`;
    flow = createSignIn(hostId, redirect, saved);
    // Initial URLs contain only fresh authorization state, never tokens/hints.
    console.log(`Continue with ChatGPT: ${flow.url}`);
    if (process.argv.includes('--open')) {
      const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [flow.url], { stdio: 'ignore' });
      child.on('error', () => console.log('Open the sign-in link above in your browser.'));
    }
    const timer = setTimeout(() => done({ error: new Error('Sign-in timed out; run login again') }), 10 * 60_000);
    const finished = await result;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    if (finished.error) throw finished.error;
    console.log('Connected. Protected credentials saved; no inference requests made yet.');
  });
}

try {
  if (command === 'login') await login();
  else if (command === 'status') {
    const saved = await protectedRead(file);
    console.log(JSON.stringify({ connected: true, subscription_scope: saved.scopes?.includes('chatgpt.tokens.use.direct'),
      expires_at: new Date(saved.expires_at).toISOString() }));
  } else if (command === 'init-host') {
    await prepareHost(directory); console.log('Host identity prepared.');
  } else if (command === 'models' || command === 'check') {
    await withCredentialLock(file, async () => {
      const saved = await accessCredentials(file);
      const models = await listModels(saved);
      if (command === 'models') console.log(JSON.stringify(models, null, 2));
      else {
        const model = process.env.VOTE_REFERENCE_MODEL;
        if (!model || !models.some(item => item.slug === model)) throw new Error('Set VOTE_REFERENCE_MODEL to a slug returned by the models command');
        const answer = await generateWithSubscription(saved, { model, instructions: 'Reply exactly READY.', input: 'Check subscription access.' });
        if (answer.text.trim() !== 'READY') throw new Error('Unexpected inference check response');
        console.log('Subscription inference completed successfully.');
      }
    });
  } else throw new Error('Commands: login [--open], status, init-host, models, check');
} catch (error) {
  // Do not dump provider bodies, credentials, request objects, or stack traces.
  console.error(error.code === 'ENOENT' ? 'Not connected. Run login first.' : error.message);
  process.exitCode = 1;
}
