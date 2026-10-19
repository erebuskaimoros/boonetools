# Development and diagnostics

## Isolated worktrees

Use a separate worktree for independent implementation, commits, or releases.
Preserve unrelated changes in the canonical checkout. Resolve shared workspace
paths from the primary checkout reported by `git worktree list --porcelain`,
not by assuming that a linked worktree has the same directory depth.

Older worktrees may predate a referenced guide. Read the primary checkout's
guide for context, but verify its commands against the committed scripts in
the worktree being used; do not import unrelated unpublished changes.

## Dependencies and checks

Install both dependency trees before running the root checks:

```bash
npm ci
npm --prefix backend ci
npm run check
npm test
npm run backend:test
```

Root import-boundary checks load backend modules, so installing only frontend
dependencies is insufficient. Do not reinstall a running development checkout
without preserving any durable observations stored under `node_modules/.cache`;
prefer a fresh worktree for clean-install verification.

Put Node test options before filenames:

```bash
node --test --test-name-pattern 'pendulum' tests/tc-fee-pendulum.test.js
```

Before committing or pushing, run the project-scoped ownership audit from the
canonical workspace:

```bash
/Users/boonewheeler/Desktop/Projects/THORChain/scripts/audit-workspace.sh --project boonetools-website
```

## Provider boundaries

`npm run check:boundaries` also checks outbound acquisition boundaries with a
syntax-tree guard. Backend collectors must use `backend/src/lib/provider-client.js`
or its service/JSON adapters, preserving durable admission, cooldowns and metrics.
`shared/provider-services.js` resolves a service plus a relative route; production
uses `createBackendProviderServices`, while browser/Vite callers use public defaults.
Do not translate a public URL into a private URL inside a job. Financials request
callbacks take `(path, { service = 'midgard', lane, ...options })`; RPC callers must
explicitly select `service: 'rpc'`. Comparison selects Midgard explicitly and retains
an origin allowlist for its other providers.

Public endpoint declarations live in the shared provider catalogs; credentials and
environment resolution stay in backend configuration. Rapid receives backend bases
and client ID by injection, never by reading environment variables in `shared/`.
The Rujira Midgard lists inherit the resolved shared list unless explicitly overridden.

`shared/midgard-policy.js` owns response checks. Its explicit Rapid profile retains
transaction-filter, cursor and height validation without tightening unrelated clients.
Rate-limit aliases delegate to `shared/provider-policy.js`: a size-related 429 is not
a quota failure unless accompanied by Retry-After. TC Fee CMC/DeFiLlama requests use
the backend JSON adapter with a 30-second deadline and existing payload parsers.

The guard covers backend source, shared modules, the Financials/comparison dev
adapters and browser Midgard adapter. Explicit independent L1 transport/catalog
owners remain allowlisted; archived UI and standalone research scripts are outside
this pass. New raw fetch/HTTP imports, hard-coded provider URLs in collectors,
public transport imports from backend jobs, and shared environment reads fail CI.
Tests include deliberately violating fixtures and routing, budget, cancellation,
redaction, validation and external-provider transport contracts.

## Deployment and browser verification

Follow [deployment.md](deployment.md): publish the intended commit to production
main, wait for that exact commit's `verify` check, and pass its SHA to the
guarded deploy command. The deploy scripts package committed Git objects rather
than local edits. Backend changes deploy first; no manual production rsync.

Verify the public release and hashed assets, then explicitly reload the browser
before checking changed UI. A navigation may reuse an older HTML document.
Wait for the actual chart/data controls to finish loading before interacting;
loading-message reflow can move controls during a click.

## SSH and shell diagnostics

Reuse an existing authenticated connection and short per-host control socket.
A master-health check alone does not prove multiplexed sessions are accepted;
check a harmless command before relying on it. Select master mode once (either
`-M` or `-o ControlMaster=yes`, not both). Do not alter host authentication or
security settings to work around a failed session.

Use local `rg` on streamed remote output when the server lacks it. Avoid zsh's
special `path` and `status` variable names, quote `gh api` URLs containing `?`,
and pass file lists as arrays or null-delimited streams.
