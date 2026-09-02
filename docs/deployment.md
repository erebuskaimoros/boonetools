# BooneTools Frontend Deployment

The BooneTools frontend is served from [boone.tools](https://boone.tools/). The DB-backed API is deployed separately; see [boonetools-backend-hetzner.md](./boonetools-backend-hetzner.md).

## Canonical Repo

Deploy the frontend only from the BooneTools website checkout:

- repo root: `/Users/boonewheeler/Desktop/Projects/THORChain/boonetools/website`
- expected `origin`: `https://github.com/erebuskaimoros/boonetools.git`

Do not do BooneTools deploy work from the outer THORChain workspace, the Thornode repo, or any other sibling checkout. If the current shell is in `/Users/boonewheeler/Desktop/Projects/THORChain`, `/Users/boonewheeler/Desktop/Projects/THORChain/ThorNode`, or a similarly broad workspace, stop and switch to the BooneTools website checkout before building or deploying.

Before a deploy, verify the context:

```bash
pwd
git remote get-url origin
git status --short
```

`pwd` should be the BooneTools `website` repo root shown above, and `origin` should be the BooneTools remote. The deploy guard requires clean `main`, exact parity with `origin/main`, and a successful GitHub Actions `verify` check. A dirty Thornode or outer THORChain worktree is not a reason to deploy manually from that location. For unrelated local changes, use the clean release checkout below. An ordinary detached worktree fails the guard's `main` branch requirement.

## Clean Release Checkout

Commit and push the intended patch first. A local clone copies committed `main`
without touching unrelated working files or downloading another copy of the
repository's history. Create a fresh checkout if a previous temporary one has
expired. This macOS example uses the physical `/private/tmp` path consistently:

```bash
boonetools_source_dir="$(git rev-parse --show-toplevel)"
boonetools_release_dir="$(mktemp -d /private/tmp/boonetools-release.XXXXXX)"
git clone --local --no-hardlinks --branch main "$boonetools_source_dir" "$boonetools_release_dir"
cd "$boonetools_release_dir"
git remote set-url origin https://github.com/erebuskaimoros/boonetools.git
git fetch origin main
git merge --ff-only origin/main
if test -f "$boonetools_source_dir/.env"; then
  cp "$boonetools_source_dir/.env" .env
fi
npm ci
npm --prefix backend ci
npm run check
npm test
npm run backend:test
git status --short
```

Install both dependency trees before running the complete checks. The frontend
test command is `npm test`. The `node_modules/` ignore rules cover directories;
a symlink named `node_modules` appears as untracked and fails the clean-source
guard. `npm ci` creates the expected directory from the lockfile.

Use the full commit SHA when locating its CI run; an abbreviated SHA can return
no results:

```bash
boonetools_release_commit="$(git rev-parse HEAD)"
gh run list --repo erebuskaimoros/boonetools --workflow ci.yml --commit "$boonetools_release_commit" --limit 1
```

After the matching `verify` check succeeds, run the guarded deploy command from
this clean checkout. It independently checks branch, source cleanliness, remote
parity, and CI before building.

```bash
npm run boonetools:deploy:frontend
```

Once deployment and all artifact comparisons have finished, return to the source
checkout and move the temporary checkout to Trash for recoverable cleanup:

```bash
cd "$boonetools_source_dir"
boonetools_trash_dir="$HOME/.Trash/${boonetools_release_dir##*/}"
test ! -e "$boonetools_trash_dir" && mv "$boonetools_release_dir" "$boonetools_trash_dir"
```

## Server

| Property | Value |
|----------|-------|
| Provider | Hetzner Cloud |
| Host | `boone.tools` |
| SSH | `root@boone.tools` |
| Static dir | `/var/www/boone-tools/` |
| Public URL | [https://boone.tools/](https://boone.tools/) |
| Legacy redirect | `https://boonewheeler.com/boonetools/*` forwards to the equivalent `https://boone.tools/*` path |

## Deploy

For an already clean canonical checkout, run the guarded frontend deploy script:

```bash
cd /Users/boonewheeler/Desktop/Projects/THORChain/boonetools/website
npm run boonetools:deploy:frontend
```

That script:

1. Verifies clean, CI-green `main` from the canonical BooneTools checkout
2. Builds and checksums an immutable frontend artifact
3. Acquires the shared BooneTools deployment lock
4. Stages the release under `/var/www/boone-tools-releases/releases/<commit>`
5. Verifies every `index.html` asset before atomically switching `current`
6. Compares a public hashed asset with the staged file and rolls back automatically on failure

Optional overrides:

```bash
SERVER=root@boone.tools
DEST=/var/www/boone-tools
VERIFY_URL=https://boone.tools/
KEEP_RELEASES=3
```

Example:

```bash
SERVER=root@boone.tools DEST=/var/www/boone-tools VERIFY_URL=https://boone.tools/ npm run boonetools:deploy:frontend
```

## Manual Sync

Do not deploy the production frontend with manual `rsync`; it bypasses the release lock, atomic cutover, artifact verification, and automatic rollback.

Do not use manual `rsync` as a workaround for being in the wrong repo. Use the
clean release checkout above to deploy committed changes while preserving
unrelated local work.

## Troubleshooting

If the deploy script refuses to run:

- make sure you are inside the BooneTools repo, not the outer THORChain workspace repo
- check `git remote get-url origin`
- check `git rev-parse --show-toplevel`

If the site looks stale after deploy:

- hard refresh the browser so it picks up the latest hashed assets
- verify the current asset list on the server:

```bash
ssh root@boone.tools 'ls -la /var/www/boone-tools/assets | tail -n 20'
```

If Caddy appears unhealthy:

```bash
ssh root@boone.tools 'systemctl status caddy'
ssh root@boone.tools 'journalctl -u caddy --since "10 min ago"'
```
