# Security maintenance

## October 22, 2026 baseline

The shared production host now uses Node 22.23.4. After a host runtime patch,
restart the affected persistent Node services gracefully and verify each live
process's executable version; replacing `/usr/bin/node` alone does not patch
already-running processes. Let scheduled jobs finish and use the new runtime
on their next activation. Application deploys do not update the host runtime.

BooneTools' frontend baseline is Svelte 5.57.2 and Vite 7.3.7. The development
server binds to `127.0.0.1` by default; explicitly opt in with `--host` only
when LAN exposure is intentional. The production site serves static assets,
not the Vite development server or a Svelte server renderer.

Wallet SDK packages remain on their existing 4.x lines. Compatible dependency
patches are kept in the lockfile and scoped overrides:

- Axios and protobufjs receive patched versions, including nested copies.
- BN.js 5, AJV 8, validator, and WebSocket 7/8 stay on their existing major lines.
- Legacy NEAR consumers use bs58 4.0.1, retaining the v4 API while moving its
  underlying Base58 decoder onto a patched line. Regression tests cover leading
  zeros, round trips, and rejection of non-Base58 Unicode input.
- `@cardano-sdk/crypto` carries an unused npm tooling dependency. Its scoped
  npm 11 override removes vulnerable bundled tooling without changing Cardano
  cryptography interfaces. That tooling requires a patched, recent Node 22.

Do not remove overrides just because a top-level version is patched. Check
nested lockfile copies, installed resolution, and wallet behavior. The security
baseline tests run in the ordinary frontend test suite.

## Remaining risk

As of this update, npm audit reports 95 affected package entries (27 high,
33 moderate, 35 low), down from 186 (including two critical). There are 12
underlying advisory-bearing packages; the other entries inherit reports from
dependencies. There are no critical findings, but the frontend tree is
**not audit-clean**. Remaining reports include wallet SDK transitive
dependencies, cryptography/validation libraries, Node-oriented transports, and
build tooling. An affected parent package is not a separate vulnerability:
count underlying advisories separately from inherited package reports.

In particular, SDK bigint-buffer/elliptic, Radix/Sui valibot,
older Undici, and dev-tool braces still need upstream changes or separately
tested migrations. Browser-only deployment limits some Node-only attack paths,
but does not justify dismissing the entire SDK dependency tree. Do not force
major crypto, encoding, validation, or transport changes solely to reduce audit
counts. Review package APIs and exercise the relevant wallet integrations first.

The reviewed residual paths are:

| Dependency | Why it was not forced in this patch |
| --- | --- |
| busboy 2 / Undici 5 | ConnectRPC's transport still pins Undici 5; patched lines require parent compatibility work. |
| ip-address 9 | Cardano pins 9; the patched line is 10.7.1+. |
| toml 3 | Stellar pins 3; the patched line is 4.2+. |
| decode-uri-component 0.2 | source-map-resolve requires 0.2; the patched line is 0.5. |
| bigint-buffer, braces, sprintf-js, elliptic | Latest published versions still have advisories; no patched release was available. |
| stream-json 1 | The patched 3.6 line needs Jayson integration testing. |
| uuid 8/9/10 | Patched 11.1.1+ needs Ledger/Radix/Jayson compatibility review. |
| valibot 0.36/0.42 | Patched 1.5+ needs Sui/Radix validation migration. |

An npm `fixAvailable` result can refer to replacing or downgrading a parent;
it does not establish that a compatible patched transitive version exists.

The neighboring Landlord app was patched separately to Next 16.4.1, React
19.2.9, and sharp 0.35.5 with application/schema source unchanged. Its production
dependency audit is clean; one dev-only braces/ESLint chain remains. New ESLint
rules also flag three existing effect patterns, which were not suppressed.

## Verification and release

Use Node 22.23.4 or a later supported patched version. Run the security guards,
ordinary frontend/backend tests, diagnostics, and production build. Preserve
durable caches when reinstalling a development checkout. CI must pass for the
exact production-main commit before the guarded frontend deploy.

After deployment, verify the public hashed asset and explicitly reload the
browser. Check Financials and Pool Analysis rendering, Thorfolio, and the
wallet-selection UI without connecting accounts or signing transactions.
Dependency tests and npm audit are not a penetration test or proof of wallet
signing behavior across every provider.

Host runtime updates require a known backup and rollback package. The Landlord
cutover additionally uses a closed, paired SQLite/uploads backup verified
off-host and retains the previous application. No database migration, provider
budget change, cache reset, Caddy upgrade, or host reboot is part of this patch.

References: [Node 22.23.4](https://nodejs.org/en/blog/release/v22.23.4),
[Next.js October security update](https://nextjs.org/blog/nextjs-security-update-october-14-2026),
[Svelte advisory](https://github.com/sveltejs/svelte/security/advisories/GHSA-rcqx-6q8c-2c42).
