#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 6 ]]; then
  echo "Usage: deploy-boonetools-frontend-remote.sh DEST RELEASE_ID ARCHIVE SHA256 KEEP_RELEASES VERIFY_URL" >&2
  exit 2
fi

DEST="$1"
RELEASE_ID="$2"
ARCHIVE="$3"
EXPECTED_SHA256="$4"
KEEP_RELEASES="$5"
VERIFY_URL="$6"

BASE="${DEST}-releases"
RELEASES_DIR="$BASE/releases"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
CURRENT_LINK="$BASE/current"
LOCK_FILE=/var/lock/boonetools-deploy.lock

PREVIOUS_TARGET=
SWITCHED=false

log() {
  printf '==> %s\n' "$*"
}

die() {
  echo "Deploy aborted: $*" >&2
  exit 1
}

require_safe_arguments() {
  [[ "$EUID" -eq 0 ]] || die "frontend release activation must run as root"
  [[ "$DEST" == /var/www/* ]] || die "DEST must be an absolute path below /var/www"
  [[ "$RELEASE_ID" =~ ^[A-Za-z0-9._-]+$ ]] || die "unsafe release identifier"
  [[ "$ARCHIVE" == /var/tmp/* ]] || die "release archive must be staged below /var/tmp"
  [[ "$EXPECTED_SHA256" =~ ^[a-f0-9]{64}$ ]] || die "invalid SHA-256"
  [[ "$KEEP_RELEASES" =~ ^[0-9]+$ && "$KEEP_RELEASES" -ge 2 ]] || die "KEEP_RELEASES must be at least 2"
  [[ "$VERIFY_URL" == https://* ]] || die "VERIFY_URL must use HTTPS"
  command -v flock >/dev/null 2>&1 || die "flock is required"
}

active_target() {
  if [[ -L "$CURRENT_LINK" ]]; then
    readlink -f "$CURRENT_LINK"
  fi
}

atomic_point_current() {
  local target="$1"
  [[ "$target" == "$RELEASES_DIR/"* ]] || die "refusing to activate a path outside $RELEASES_DIR"
  rm -f "$CURRENT_LINK.next"
  ln -s "releases/${target##*/}" "$CURRENT_LINK.next"
  mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"
}

bootstrap_legacy_frontend() {
  install -d -o root -g root -m 0755 "$BASE" "$RELEASES_DIR"
  PREVIOUS_TARGET="$(active_target || true)"
  if [[ -n "$PREVIOUS_TARGET" ]]; then
    [[ -d "$PREVIOUS_TARGET" ]] || die "current frontend target does not exist: $PREVIOUS_TARGET"
  elif [[ -d "$DEST" && ! -L "$DEST" ]]; then
    local legacy_id legacy_dir in_place_backup
    legacy_id="legacy-$(date -u +%Y%m%dT%H%M%SZ)"
    legacy_dir="$RELEASES_DIR/$legacy_id"
    log "Capturing the in-place frontend as rollback release $legacy_id"
    cp -a "$DEST" "$legacy_dir"
    atomic_point_current "$legacy_dir"
    PREVIOUS_TARGET="$legacy_dir"

    in_place_backup="${DEST}.bootstrap-$$"
    mv "$DEST" "$in_place_backup"
    if ln -s "$CURRENT_LINK" "$DEST"; then
      rm -rf "$in_place_backup"
    else
      mv "$in_place_backup" "$DEST"
      die "could not convert $DEST to an atomic release symlink"
    fi
  elif [[ -L "$DEST" && "$(readlink "$DEST")" != "$CURRENT_LINK" ]]; then
    die "$DEST is a symlink not managed by the BooneTools release directory"
  fi

  if [[ ! -L "$DEST" ]]; then
    [[ ! -e "$DEST" ]] || die "$DEST must be absent or a symlink after bootstrap"
    ln -s "$CURRENT_LINK" "$DEST"
  fi
}

validate_archive() {
  [[ -f "$ARCHIVE" ]] || die "release archive does not exist: $ARCHIVE"
  local actual_sha256
  actual_sha256="$(sha256sum "$ARCHIVE" | awk '{ print $1 }')"
  [[ "$actual_sha256" == "$EXPECTED_SHA256" ]] || die "frontend archive checksum mismatch"
  if tar -tzf "$ARCHIVE" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
    die "frontend archive contains an unsafe path"
  fi
}

validate_staged_frontend() {
  [[ -f "$RELEASE_DIR/index.html" ]] || die "frontend release is missing index.html"
  if grep -Eq '(src|href)="\./assets/' "$RELEASE_DIR/index.html"; then
    die "index.html contains route-relative asset URLs"
  fi

  local reference relative
  while IFS= read -r reference; do
    relative="${reference#/}"
    [[ -f "$RELEASE_DIR/$relative" ]] || die "index.html references missing asset /$relative"
  done < <(
    grep -oE '(src|href)="/assets/[^"]+' "$RELEASE_DIR/index.html" \
      | sed -E 's/^(src|href)="//' \
      | sort -u
  )
}

stage_release() {
  local current
  current="$(active_target || true)"
  [[ "$current" != "$RELEASE_DIR" ]] || die "release $RELEASE_ID is already active"

  rm -rf "$RELEASE_DIR"
  install -d -o root -g root -m 0755 "$RELEASE_DIR"
  tar -xzf "$ARCHIVE" --no-same-owner -C "$RELEASE_DIR"
  chown -R root:root "$RELEASE_DIR"
  find "$RELEASE_DIR" -type d -exec chmod 0755 {} +
  find "$RELEASE_DIR" -type f -exec chmod 0644 {} +
  validate_staged_frontend

  {
    printf 'release_id=%s\n' "$RELEASE_ID"
    printf 'archive_sha256=%s\n' "$EXPECTED_SHA256"
    printf 'staged_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$RELEASE_DIR/RELEASE"
}

verify_public_frontend() {
  curl -fsSIL --connect-timeout 8 --max-time 30 "$VERIFY_URL" >/dev/null
  curl -fsSIL --connect-timeout 8 --max-time 30 "${VERIFY_URL%/}/status" >/dev/null

  local asset_path staged_asset downloaded
  asset_path="$(
    grep -oE '(src|href)="/assets/[^"]+' "$RELEASE_DIR/index.html" \
      | sed -E 's/^(src|href)="//' \
      | head -n 1
  )"
  if [[ -n "$asset_path" ]]; then
    staged_asset="$RELEASE_DIR/${asset_path#/}"
    downloaded="$(mktemp)"
    curl -fsS --compressed --connect-timeout 8 --max-time 30 \
      "${VERIFY_URL%/}$asset_path" \
      -o "$downloaded"
    if ! cmp -s "$staged_asset" "$downloaded"; then
      rm -f "$downloaded"
      die "public asset does not match the activated release: $asset_path"
    fi
    rm -f "$downloaded"
  fi
}

cleanup_releases() {
  local current previous entry path kept=0
  current="$(active_target || true)"
  previous="$PREVIOUS_TARGET"
  while IFS= read -r entry; do
    path="${entry#* }"
    if [[ "$path" == "$current" || "$path" == "$previous" || "$kept" -lt "$KEEP_RELEASES" ]]; then
      kept=$((kept + 1))
      continue
    fi
    rm -rf "$path"
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr)
}

handle_exit() {
  local status=$?
  trap - EXIT
  rm -f "$ARCHIVE"

  if [[ "$status" -ne 0 && "$SWITCHED" == true ]]; then
    if [[ -n "$PREVIOUS_TARGET" && -d "$PREVIOUS_TARGET" ]]; then
      echo "Frontend verification failed; restoring ${PREVIOUS_TARGET##*/}." >&2
      atomic_point_current "$PREVIOUS_TARGET"
      RELEASE_DIR="$PREVIOUS_TARGET"
      if ! verify_public_frontend; then
        echo "CRITICAL: frontend rollback did not verify successfully." >&2
        exit 70
      fi
      echo "Previous frontend release restored and verified." >&2
    else
      echo "CRITICAL: frontend verification failed and no previous release exists." >&2
      exit 70
    fi
  fi
  exit "$status"
}

require_safe_arguments
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  die "another BooneTools deployment is already running"
fi
trap handle_exit EXIT

install -d -o root -g root -m 0755 "$BASE" "$RELEASES_DIR"
validate_archive
stage_release
bootstrap_legacy_frontend

log "Atomically activating frontend release $RELEASE_ID"
atomic_point_current "$RELEASE_DIR"
SWITCHED=true

verify_public_frontend
SWITCHED=false
cleanup_releases
log "Frontend release $RELEASE_ID is active and verified"
