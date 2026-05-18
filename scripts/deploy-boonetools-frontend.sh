#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/require-canonical-boonetools-repo.sh"

ROOT="$BOONETOOLS_CANONICAL_ROOT"
SERVER="${SERVER:-root@boone.tools}"
DEST="${DEST:-/var/www/boone-tools}"
VERIFY_URL="${VERIFY_URL:-https://boone.tools/}"

echo "==> Building BooneTools frontend..."
(cd "$ROOT" && npm run build)

echo "==> Preserving App Layer dashboard compatibility assets..."
DASHBOARD_CSS="$(find "$ROOT/dist/assets" -maxdepth 1 -name 'AppLayerBaseLayerDashboard-*.css' | sort | tail -n 1)"
DASHBOARD_JS="$(find "$ROOT/dist/assets" -maxdepth 1 -name 'AppLayerBaseLayerDashboard-*.js' | sort | tail -n 1)"

if [[ -z "$DASHBOARD_CSS" || -z "$DASHBOARD_JS" ]]; then
  echo "Missing App Layer dashboard chunks after build" >&2
  exit 1
fi

# Keep the last deployed dashboard chunk names available so a browser with a
# stale cached index/module graph does not receive index.html for CSS or JS.
cp "$DASHBOARD_CSS" "$ROOT/dist/assets/AppLayerBaseLayerDashboard-3pz7TDqh.css"
cp "$DASHBOARD_JS" "$ROOT/dist/assets/AppLayerBaseLayerDashboard-DolkGllj.js"

echo "==> Syncing dist/ to $SERVER:$DEST/ ..."
rsync -avz --delete "$ROOT/dist/" "$SERVER:$DEST/"

if [[ -n "$VERIFY_URL" ]]; then
  echo "==> Verifying $VERIFY_URL ..."
  curl -fsSIL "$VERIFY_URL" >/dev/null
fi

echo "Done."
echo "Frontend deployed from $ROOT to $SERVER:$DEST/"
