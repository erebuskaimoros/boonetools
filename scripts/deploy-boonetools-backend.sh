#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/require-canonical-boonetools-repo.sh" "$@"

ROOT="$BOONETOOLS_CANONICAL_ROOT"
SERVER="${SERVER:-root@boone.tools}"
DEST="${DEST:-/opt/boonetools-backend}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
RELEASE_ID="$BOONETOOLS_DEPLOY_RELEASE_ID"

[[ "$DEST" == /opt/* ]] || {
  echo "DEST must be an absolute path below /opt." >&2
  exit 1
}
[[ "$KEEP_RELEASES" =~ ^[0-9]+$ && "$KEEP_RELEASES" -ge 2 ]] || {
  echo "KEEP_RELEASES must be at least 2." >&2
  exit 1
}
ARCHIVE="$(mktemp "${TMPDIR:-/tmp}/boonetools-backend.XXXXXX")"
REMOTE_HELPER="$(mktemp "${TMPDIR:-/tmp}/boonetools-backend-helper.XXXXXX")"
REMOTE_ARCHIVE="/var/tmp/boonetools-backend-${RELEASE_ID}-${ARCHIVE##*.}.tar.gz"
ARCHIVE_UPLOADED=false

cleanup() {
  local exit_code=$?
  trap - EXIT
  rm -f "$ARCHIVE" "$REMOTE_HELPER"
  if [[ "$ARCHIVE_UPLOADED" == true ]]; then
    ssh "$SERVER" "rm -f '$REMOTE_ARCHIVE'" >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT

echo "==> Creating immutable backend artifact from commit $BOONETOOLS_DEPLOY_COMMIT ..."
git -C "$ROOT" archive --format=tar.gz --output="$ARCHIVE" \
  "$BOONETOOLS_DEPLOY_COMMIT" backend shared scripts ops
# The activation helper is pinned to the same reviewed commit, not local edits.
git -C "$ROOT" show "$BOONETOOLS_DEPLOY_COMMIT:scripts/deploy-boonetools-backend-remote.sh" > "$REMOTE_HELPER"

tar -tzf "$ARCHIVE" >/dev/null
ARCHIVE_SHA256="$(sha256sum "$ARCHIVE" | awk '{ print $1 }')"

echo "==> Uploading backend release $RELEASE_ID ..."
scp "$ARCHIVE" "$SERVER:$REMOTE_ARCHIVE"
ARCHIVE_UPLOADED=true

echo "==> Activating release under the server-wide deployment lock ..."
ssh "$SERVER" bash -s -- \
  "$DEST" \
  "$RELEASE_ID" \
  "$REMOTE_ARCHIVE" \
  "$ARCHIVE_SHA256" \
  "$KEEP_RELEASES" \
  < "$REMOTE_HELPER"

ARCHIVE_UPLOADED=false
echo "Backend release $RELEASE_ID deployed successfully."
