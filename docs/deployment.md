# Deployment Guide

RUNE-Tools is deployed as a static site on a Hetzner VPS, served by Caddy.

## Server

| Property | Value |
|----------|-------|
| Provider | Hetzner Cloud |
| Server Type | CPX31 (4 vCPU, 8GB RAM, 160GB SSD) |
| IP | 178.156.211.181 |
| OS | Ubuntu 22.04 LTS |
| URL | https://boonewheeler.com/boonetools/ |
| Also serves | https://themememap.com (separate project) |

## SSH Access

```bash
# Root access
ssh root@178.156.211.181

# Deploy user (limited permissions)
ssh deploy@178.156.211.181
```

## Architecture

```
Internet
  │
  ▼
Caddy (systemd, ports 80/443)
  │  - Auto HTTPS via Let's Encrypt
  │  - Handles boonewheeler.com AND themememap.com
  │
  ├── /boonetools/*  →  static files from /var/www/boonetools/
  │                      (uri strip_prefix, try_files → index.html)
  │
  └── themememap.com →  reverse_proxy localhost:8080
                        (Docker stack: nginx → Clojure API → Postgres)
```

## DNS

Domain `boonewheeler.com` is registered at **Spaceship** using Spaceship nameservers.

| Record | Type | Value |
|--------|------|-------|
| @ | A | 178.156.211.181 |
| www | A | 178.156.211.181 |

Root `/` redirects to `/boonetools/`.

## File Locations on Server

| Path | Contents |
|------|----------|
| `/var/www/boonetools/` | Built static files (dist/) |
| `/etc/caddy/Caddyfile` | Caddy reverse proxy + static file config |

## How to Deploy

### 1. Build with correct base path

The app must be built with `base: '/boonetools/'` so asset URLs resolve correctly under the subpath.

```bash
cd RUNE-Tools
npx vite build --base=/boonetools/
```

### 2. Sync to server

```bash
rsync -avz --delete dist/ root@178.156.211.181:/var/www/boonetools/
```

The `--delete` flag removes old files that are no longer in the build output.

### 3. Done

No server restart needed. Caddy serves static files directly -- new files are picked up immediately.

## Caddy Configuration

The Caddyfile at `/etc/caddy/Caddyfile`:

```
themememap.com {
    reverse_proxy localhost:8080
}

www.themememap.com {
    redir https://themememap.com{uri} permanent
}

boonewheeler.com, www.boonewheeler.com {
    handle /boonetools/* {
        root * /var/www/boonetools
        uri strip_prefix /boonetools
        file_server
        try_files {path} /index.html
    }
    handle /boonetools {
        redir /boonetools/ permanent
    }
    handle {
        redir /boonetools/ permanent
    }
}
```

### Key Caddy directives

- **`uri strip_prefix /boonetools`** -- removes `/boonetools` from the path before looking up files, so `/boonetools/assets/foo.js` maps to `/var/www/boonetools/assets/foo.js`
- **`try_files {path} /index.html`** -- serves `index.html` for any path that doesn't match a real file (required for SPA client-side routing)
- **`file_server`** -- serves static files from the `root` directory

### Modifying Caddy config

```bash
# Edit
ssh root@178.156.211.181
nano /etc/caddy/Caddyfile

# Validate before applying
caddy validate --config /etc/caddy/Caddyfile

# Reload (no downtime)
systemctl reload caddy

# Check status
systemctl status caddy

# View logs
journalctl -u caddy -f
```

## HTTPS / Certificates

Caddy automatically obtains and renews Let's Encrypt certificates. No manual certificate management is needed. Certificates are stored at `/var/lib/caddy/.local/share/caddy/`.

## Troubleshooting

### Site not loading after deploy
```bash
# Check files are on server
ssh root@178.156.211.181 "ls -la /var/www/boonetools/"

# Check Caddy is running
ssh root@178.156.211.181 "systemctl status caddy"

# Check Caddy logs
ssh root@178.156.211.181 "journalctl -u caddy --since '5 min ago'"
```

### Assets returning 404
The Vite build `base` must match the Caddy path. If you change the URL path, update both:
1. `npx vite build --base=/new-path/`
2. The Caddyfile `handle` and `uri strip_prefix` directives

### DNS not resolving
```bash
# Check what Spaceship nameservers return
dig +short boonewheeler.com @launch1.spaceship.net

# Check propagation from your machine
dig +short boonewheeler.com
```
DNS changes propagate within 30 minutes (TTL) but can take longer for cached resolvers.
