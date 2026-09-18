# BooneTools Deployment

Deploy an explicit, CI-passing commit from any checkout or linked worktree of
`https://github.com/erebuskaimoros/boonetools.git`. The local branch can be
detached or dirty: local edits are never packaged, reset, or stashed.

After committing/pushing the intended changes and waiting for that commit's
GitHub Actions `verify` check:

```bash
npm run boonetools:deploy:backend -- <commit-sha>
npm run boonetools:deploy:frontend -- <commit-sha>
```

Run only the component that changed; deploy backend first when both change.
No separate release clone or repeated full local test/build sequence is needed.
CI owns the complete verification suite; use focused local tests during development.
The guard fetches production main, requires the selected commit to belong to its
history, and verifies that commit's latest Actions `verify` result. There is no
dirty-tree or skip-CI bypass. Run from this repo, not the outer THORChain workspace.

## What a deploy does

Both entrypoints package the selected Git object and use the remote activation
helper from that same commit. Both retain checksums, the shared deployment lock,
immutable releases, atomic cutover, and automatic rollback on failed health checks.

The backend compares the current release with the selected artifact:

- Ordinary code changes restart only affected long-running processes, using
  their relative module dependencies in both the old and new source trees.
  Existing scheduled jobs finish normally and load the new release on their
  next scheduled run. There is no blanket warmup or historical backfill.
- Schema, dependency manifests, database scripts, or systemd/Docker manifest
  changes coordinate the services. Existing active work is resumed; inactive
  backfills and intentionally disabled timers remain inactive. Newly added
  timers and persistent services are enabled.
- Only new migrations run. Rewriting/removing historical migrations is rejected.
  Migrations must remain backward compatible: application rollback does not undo SQL.
- Checks cover local API health, affected DB-backed public endpoints, and
  restarted persistent services/timers. Deploy-only changes use Status as the
  DB-backed smoke check. Stale cached data is reported as a warning; normal
  collectors recover freshness independently. Unrelated websites and provider
  backfills are not deployment gates. Full performance/freshness testing remains
  available through `npm run perf:smoke`.
- At least three releases are retained by default, plus the rollback target and
  any older release still used by a running process. A failed activation can
  reuse its fully staged, checksum-matching artifact without overwriting it.

The printed backend plan is also saved as `DEPLOY_PLAN` in the release.
For a local, read-only comparison of two extracted source trees:

```bash
node scripts/backend-deploy-plan.mjs /path/to/previous /path/to/next
```

The frontend runs `npm ci` and its production build in an automatically created
temporary directory containing only the selected commit. It validates asset
paths, switches atomically, and compares a public hashed asset against the
staged file. Local `.env` files are not copied; the default API base is the
same-origin `/functions/v1`. Export any intentional `VITE_*` build overrides
explicitly. Server-owned backend secrets are never uploaded.

## Production layout

| Component | Location |
| --- | --- |
| SSH | `root@boone.tools` |
| Backend | `/opt/boonetools-backend/current` |
| Backend configuration | `/opt/boonetools-backend/config/backend.env` |
| Frontend releases | `/var/www/boone-tools-releases/releases/<commit>` |
| Frontend public directory | `/var/www/boone-tools` |
| Website | [boone.tools](https://boone.tools/) |

Defaults can be overridden with `SERVER`, `DEST`, and `KEEP_RELEASES` (minimum 2).
Frontend also accepts `VERIFY_URL` (HTTPS).
Application deploys do not change or reload host-wide Caddy configuration.
Do not bypass the release lock and rollback with a manual production rsync.

A fresh backend installation still needs server-owned configuration and initial
data acquisition. Routine deployment does not populate a cold database or prove
historical completeness; provision/bootstrap new features deliberately. See
[backend operations](./boonetools-backend-hetzner.md) for feature-specific jobs.

## Troubleshooting

A refused deploy identifies missing CI, an unpublished commit, a wrong origin,
or an already-active/conflicting release. A fully staged release can be retried;
an incomplete staging directory requires inspecting the failure before removing
that exact directory. Never overwrite a release that a running process uses.

For service diagnostics:

```bash
ssh root@boone.tools 'systemctl status boonetools-api'
ssh root@boone.tools 'journalctl -u boonetools-api --since "10 min ago"'
```

After a frontend change, hard refresh to load new hashed assets. If routing itself
is unhealthy, inspect Caddy independently rather than changing it in an app deploy.
