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

echo "==> Syncing dist/ to $SERVER:$DEST/ ..."
rsync -avz --delete "$ROOT/dist/" "$SERVER:$DEST/"

if [[ -n "$VERIFY_URL" ]]; then
  echo "==> Verifying $VERIFY_URL ..."
  curl -fsSIL "$VERIFY_URL" >/dev/null
fi

echo "Done."
echo "Frontend deployed from $ROOT to $SERVER:$DEST/"
