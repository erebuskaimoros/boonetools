# BooneTools Frontend Deployment

The BooneTools frontend is served from [boone.tools](https://boone.tools/). The DB-backed API is deployed separately; see [boonetools-backend-hetzner.md](./boonetools-backend-hetzner.md).

## Canonical Repo

Deploy the frontend only from this repo checkout:

- repo root: `/Users/boonewheeler/Desktop/Projects/THORChain/boonetools/website`
- expected `origin`: `https://github.com/erebuskaimoros/boonetools.git`

Do not deploy BooneTools from the outer THORChain workspace repo. The guarded deploy scripts will now fail if the repo root or `origin` does not match the canonical BooneTools repo.

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
