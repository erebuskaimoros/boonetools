#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/require-canonical-boonetools-repo.sh"

ROOT="$BOONETOOLS_CANONICAL_ROOT"
SERVER="${SERVER:-root@boone.tools}"
DEST="${DEST:-/var/www/boone-tools}"
VERIFY_URL="${VERIFY_URL:-https://boone.tools/}"
ASSET_RETENTION_DAYS="${ASSET_RETENTION_DAYS:-30}"

if [[ ! "$ASSET_RETENTION_DAYS" =~ ^[0-9]+$ ]] || [[ "$ASSET_RETENTION_DAYS" -lt 1 ]]; then
  echo "ASSET_RETENTION_DAYS must be a positive integer" >&2
  exit 1
fi

echo "==> Building BooneTools frontend..."
(cd "$ROOT" && npm run build)

if grep -Eq '(src|href)="\./assets/' "$ROOT/dist/index.html"; then
  echo "Deploy aborted: dist/index.html contains route-relative asset URLs that break direct nested SPA routes." >&2
  exit 1
fi

echo "==> Syncing application shell to $SERVER:$DEST/ ..."
# Replace non-asset files exactly, but protect the asset directory from the
# delete pass. Browsers with an older app shell can still request its hashed
# lazy chunks after a deploy instead of receiving a 404.
rsync -avz --delete --exclude '/assets/' "$ROOT/dist/" "$SERVER:$DEST/"

echo "==> Syncing current assets and retaining prior chunks for ${ASSET_RETENTION_DAYS} days..."
rsync -avz "$ROOT/dist/assets/" "$SERVER:$DEST/assets/"
ssh "$SERVER" "find '$DEST/assets' -type f -mtime +$ASSET_RETENTION_DAYS -delete && find '$DEST/assets' -mindepth 1 -type d -empty -delete"

if [[ -n "$VERIFY_URL" ]]; then
  echo "==> Verifying $VERIFY_URL ..."
  curl -fsSIL "$VERIFY_URL" >/dev/null
fi

echo "Done."
echo "Frontend deployed from $ROOT to $SERVER:$DEST/"
