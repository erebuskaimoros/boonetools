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

`pwd` should be the BooneTools `website` repo root shown above, and `origin` should be the BooneTools remote. A dirty Thornode or outer THORChain worktree is not a reason to deploy manually from that location. Use a clean BooneTools checkout/worktree, then run the guarded deploy script from `website`.

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

Run the guarded frontend deploy script:

```bash
cd /Users/boonewheeler/Desktop/Projects/THORChain/boonetools/website
npm run boonetools:deploy:frontend
```

That script:

1. Verifies the current repo is the canonical BooneTools checkout
2. Prints the current branch, `HEAD`, `origin`, and any local worktree changes
3. Builds the frontend with `npm run build`
4. Syncs `dist/` to `/var/www/boone-tools/`
5. Verifies the public URL responds after deploy

Optional overrides:

```bash
SERVER=root@boone.tools
DEST=/var/www/boone-tools
VERIFY_URL=https://boone.tools/
```

Example:

```bash
SERVER=root@boone.tools DEST=/var/www/boone-tools VERIFY_URL=https://boone.tools/ npm run boonetools:deploy:frontend
```

## Manual Sync

Manual `rsync` is still possible, but it is no longer the recommended path. Use the guarded script unless you intentionally need a one-off deploy flow and have verified the repo source yourself.

Do not use manual `rsync` as a workaround for being in the wrong repo. If you need to avoid unrelated local changes, create or use a clean BooneTools `website` checkout/worktree, apply only the intended BooneTools patch there, and run the canonical deploy script from that checkout.

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
