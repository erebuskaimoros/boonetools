#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/require-canonical-boonetools-repo.sh" "$@"

ROOT="$BOONETOOLS_CANONICAL_ROOT"
SERVER="${SERVER:-root@boone.tools}"
DEST="${DEST:-/var/www/boone-tools}"
VERIFY_URL="${VERIFY_URL:-https://boone.tools/}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
RELEASE_ID="$BOONETOOLS_DEPLOY_RELEASE_ID"

[[ "$DEST" == /var/www/* ]] || {
  echo "DEST must be an absolute path below /var/www." >&2
  exit 1
}
[[ "$VERIFY_URL" == https://* ]] || {
  echo "VERIFY_URL must use HTTPS." >&2
  exit 1
}
[[ "$KEEP_RELEASES" =~ ^[0-9]+$ && "$KEEP_RELEASES" -ge 2 ]] || {
  echo "KEEP_RELEASES must be at least 2." >&2
  exit 1
}
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/boonetools-build.XXXXXX")"
REMOTE_HELPER="$BUILD_DIR/scripts/deploy-boonetools-frontend-remote.sh"
ARCHIVE="$(mktemp "${TMPDIR:-/tmp}/boonetools-frontend.XXXXXX")"
REMOTE_ARCHIVE="/var/tmp/boonetools-frontend-${RELEASE_ID}-${ARCHIVE##*.}.tar.gz"
ARCHIVE_UPLOADED=false

cleanup() {
  local exit_code=$?
  trap - EXIT
  rm -f "$ARCHIVE"
  rm -rf "$BUILD_DIR"
  if [[ "$ARCHIVE_UPLOADED" == true ]]; then
    ssh "$SERVER" "rm -f '$REMOTE_ARCHIVE'" >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT

echo "==> Building frontend release $RELEASE_ID in an isolated temporary directory ..."
git -C "$ROOT" archive "$BOONETOOLS_DEPLOY_COMMIT" | tar -xf - -C "$BUILD_DIR"
# Export VITE_* settings explicitly when needed. Never copy a dirty local .env.
(cd "$BUILD_DIR" && npm ci && npm run build)
if grep -Eq '(src|href)="\./assets/' "$BUILD_DIR/dist/index.html"; then
  echo "Deploy aborted: dist/index.html contains route-relative asset URLs." >&2
  exit 1
fi
COPYFILE_DISABLE=1 tar -C "$BUILD_DIR/dist" -czf "$ARCHIVE" .
tar -tzf "$ARCHIVE" >/dev/null
ARCHIVE_SHA256="$(sha256sum "$ARCHIVE" | awk '{ print $1 }')"

echo "==> Uploading immutable frontend artifact ..."
scp "$ARCHIVE" "$SERVER:$REMOTE_ARCHIVE"
ARCHIVE_UPLOADED=true

echo "==> Activating the frontend under the server-wide deployment lock ..."
ssh "$SERVER" bash -s -- \
  "$DEST" \
  "$RELEASE_ID" \
  "$REMOTE_ARCHIVE" \
  "$ARCHIVE_SHA256" \
  "$KEEP_RELEASES" \
  "$VERIFY_URL" \
  < "$REMOTE_HELPER"

ARCHIVE_UPLOADED=false
echo "Frontend release $RELEASE_ID deployed successfully."
