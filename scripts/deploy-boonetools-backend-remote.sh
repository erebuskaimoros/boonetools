#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 5 ]]; then
  echo "Usage: deploy-boonetools-backend-remote.sh DEST RELEASE_ID ARCHIVE SHA256 KEEP_RELEASES" >&2
  exit 2
fi

DEST="$1"
RELEASE_ID="$2"
ARCHIVE="$3"
EXPECTED_SHA256="$4"
KEEP_RELEASES="$5"

RELEASES_DIR="$DEST/releases"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
CURRENT_LINK="$DEST/current"
CONFIG_DIR="$DEST/config"
ENV_FILE="$CONFIG_DIR/backend.env"
LOCK_FILE=/var/lock/boonetools-deploy.lock

PREVIOUS_TARGET=
ROLLBACK_REQUIRED=false
QUIESCED=false

log() {
  printf '==> %s\n' "$*"
}

die() {
  echo "Deploy aborted: $*" >&2
  exit 1
}

require_safe_arguments() {
  [[ "$EUID" -eq 0 ]] || die "remote release activation must run as root"
  [[ "$DEST" == /opt/* ]] || die "DEST must be an absolute path below /opt"
  [[ "$RELEASE_ID" =~ ^[A-Za-z0-9._-]+$ ]] || die "unsafe release identifier"
  [[ "$ARCHIVE" == /var/tmp/* ]] || die "release archive must be staged below /var/tmp"
  [[ "$EXPECTED_SHA256" =~ ^[a-f0-9]{64}$ ]] || die "invalid SHA-256"
  [[ "$KEEP_RELEASES" =~ ^[0-9]+$ && "$KEEP_RELEASES" -ge 2 ]] || die "KEEP_RELEASES must be at least 2"
  command -v flock >/dev/null 2>&1 || die "flock is required"
  command -v rsync >/dev/null 2>&1 || die "rsync is required"
  command -v systemctl >/dev/null 2>&1 || die "systemd is required"
  command -v runuser >/dev/null 2>&1 || die "runuser is required"
  id deploy >/dev/null 2>&1 || die "the deploy user does not exist"
}

env_value() {
  local key="$1"
  awk -F= -v wanted="$key" '
    $1 == wanted {
      sub(/^[^=]*=/, "")
      print
      exit
    }
  ' "$ENV_FILE"
}

atomic_point_current() {
  local target="$1"
  local relative_target
  [[ "$target" == "$RELEASES_DIR/"* ]] || die "refusing to activate a path outside $RELEASES_DIR"
  relative_target="releases/${target##*/}"
  rm -f "$CURRENT_LINK.next"
  ln -s "$relative_target" "$CURRENT_LINK.next"
  mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"
}

installed_release_target() {
  if [[ -L "$CURRENT_LINK" ]]; then
    readlink -f "$CURRENT_LINK"
  fi
}

prepare_server_config() {
  install -d -o root -g root -m 0755 "$DEST" "$RELEASES_DIR"
  install -d -o root -g deploy -m 0750 "$CONFIG_DIR"

  if [[ ! -f "$ENV_FILE" ]]; then
    if [[ -f "$DEST/backend/.env" ]]; then
      log "Migrating the legacy backend environment into protected server configuration"
      install -o root -g deploy -m 0640 "$DEST/backend/.env" "$ENV_FILE"
    else
      die "missing $ENV_FILE; provision server-side secrets before the first deployment"
    fi
  fi

  chown root:deploy "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
}

bootstrap_legacy_release() {
  PREVIOUS_TARGET="$(installed_release_target || true)"
  if [[ -n "$PREVIOUS_TARGET" ]]; then
    [[ -d "$PREVIOUS_TARGET" ]] || die "current release target does not exist: $PREVIOUS_TARGET"
    return
  fi

  if [[ ! -d "$DEST/backend" ]]; then
    return
  fi

  local legacy_id legacy_dir
  legacy_id="legacy-$(date -u +%Y%m%dT%H%M%SZ)"
  legacy_dir="$RELEASES_DIR/$legacy_id"
  log "Capturing the in-place installation as immutable rollback release $legacy_id"
  install -d -o root -g root -m 0755 "$legacy_dir"

  for component in backend shared scripts ops; do
    if [[ -e "$DEST/$component" ]]; then
      cp -a --reflink=auto "$DEST/$component" "$legacy_dir/$component"
    fi
  done
  rm -f "$legacy_dir/backend/.env"

  install -d -o root -g root -m 0755 "$legacy_dir/ops/systemd"
  rm -f "$legacy_dir"/ops/systemd/*
  shopt -s nullglob
  local installed_units=(
    /etc/systemd/system/boonetools-*.service
    /etc/systemd/system/boonetools-*.timer
  )
  [[ -e /etc/systemd/system/rapid-swap-listener.service ]] \
    && installed_units+=(/etc/systemd/system/rapid-swap-listener.service)
  [[ -e /etc/systemd/system/rapid-swap-listener.timer ]] \
    && installed_units+=(/etc/systemd/system/rapid-swap-listener.timer)
  if [[ "${#installed_units[@]}" -gt 0 ]]; then
    cp -a -- "${installed_units[@]}" "$legacy_dir/ops/systemd/"
  fi
  shopt -u nullglob

  atomic_point_current "$legacy_dir"
  PREVIOUS_TARGET="$legacy_dir"
}

validate_archive() {
  [[ -f "$ARCHIVE" ]] || die "release archive does not exist: $ARCHIVE"
  local actual_sha256
  actual_sha256="$(sha256sum "$ARCHIVE" | awk '{ print $1 }')"
  [[ "$actual_sha256" == "$EXPECTED_SHA256" ]] || die "release archive checksum mismatch"
  if tar -tzf "$ARCHIVE" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
    die "release archive contains an unsafe path"
  fi
}

stage_release() {
  local active_target
  active_target="$(installed_release_target || true)"
  if [[ "$active_target" == "$RELEASE_DIR" ]]; then
    die "release $RELEASE_ID is already active"
  fi

  rm -rf "$RELEASE_DIR"
  install -d -o deploy -g deploy -m 0755 "$RELEASE_DIR"
  tar -xzf "$ARCHIVE" --no-same-owner -C "$RELEASE_DIR"
  chown -R deploy:deploy "$RELEASE_DIR"

  [[ -f "$RELEASE_DIR/backend/package-lock.json" ]] || die "release is missing backend/package-lock.json"
  [[ -f "$RELEASE_DIR/shared/package.json" ]] || die "release is missing shared/package.json"
  [[ -d "$RELEASE_DIR/ops/systemd" ]] || die "release is missing systemd units"
  [[ -x "$RELEASE_DIR/scripts/boonetools-db-migrate.sh" ]] || chmod 0755 "$RELEASE_DIR/scripts/boonetools-db-migrate.sh"
  chmod 0755 "$RELEASE_DIR"/scripts/*.sh 2>/dev/null || true

  log "Installing release dependencies"
  runuser -u deploy -- bash -lc "cd '$RELEASE_DIR/backend' && npm ci --omit=dev"
  runuser -u deploy -- node --check "$RELEASE_DIR/backend/src/server.js"

  {
    printf 'release_id=%s\n' "$RELEASE_ID"
    printf 'archive_sha256=%s\n' "$EXPECTED_SHA256"
    printf 'staged_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$RELEASE_DIR/RELEASE"
  chown root:root "$RELEASE_DIR/RELEASE"
  chmod 0644 "$RELEASE_DIR/RELEASE"
}

check_url() {
  local url="$1"
  local expected="$2"
  local code
  code="$(curl -sS -L --max-redirs 8 --connect-timeout 8 --max-time 30 -o /dev/null -w '%{http_code}' "$url")"
  [[ "$code" == "$expected" ]] || {
    echo "Health check failed: $url returned $code, expected $expected" >&2
    return 1
  }
}

verify_host_routes() {
  check_url https://theaiguys.ai/ 200
  check_url https://theaiguys.ai/traffic/ 401
  check_url https://themememap.com/health 200
  check_url https://boone.tools/ 200
  check_url https://boonewheeler.com/landlord 200
  check_url https://mail.theaiguys.ai/ 200
  check_url https://mail.themememap.com/ 200
}

start_postgres_and_wait() {
  local container
  container="$(env_value BOONETOOLS_DB_CONTAINER)"
  container="${container:-boonetools-postgres}"

  log "Ensuring Postgres is running"
  (
    cd "$DEST"
    docker compose \
      -f "$RELEASE_DIR/ops/docker/boonetools-postgres.compose.yml" \
      --env-file "$ENV_FILE" \
      up -d
  )

  local attempt
  for attempt in $(seq 1 60); do
    if docker exec "$container" sh -lc 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
      return
    fi
    sleep 2
  done
  die "Postgres did not become ready within 120 seconds"
}

stop_writers() {
  log "Quiescing BooneTools timers and background services"
  shopt -s nullglob
  local timer_paths=(/etc/systemd/system/boonetools-*.timer)
  local service_paths=(
    /etc/systemd/system/boonetools-*.service
  )
  [[ -e /etc/systemd/system/rapid-swap-listener.service ]] \
    && service_paths+=(/etc/systemd/system/rapid-swap-listener.service)
  local units=()
  local path unit

  for path in "${timer_paths[@]}"; do
    units+=("$(basename "$path")")
  done
  for path in "${service_paths[@]}"; do
    unit="$(basename "$path")"
    [[ "$unit" == boonetools-api.service ]] && continue
    units+=("$unit")
  done
  shopt -u nullglob

  if [[ "${#units[@]}" -gt 0 ]]; then
    systemctl stop "${units[@]}"
  fi
  QUIESCED=true
  ROLLBACK_REQUIRED=true
}

install_units_from_release() {
  local source_release="$1"
  local unit_dir="$source_release/ops/systemd"
  [[ -d "$unit_dir" ]] || die "release has no systemd directory: $source_release"

  shopt -s nullglob
  local desired_paths=("$unit_dir"/*.service "$unit_dir"/*.timer)
  local current_paths=(
    /etc/systemd/system/boonetools-*.service
    /etc/systemd/system/boonetools-*.timer
  )
  [[ -e /etc/systemd/system/rapid-swap-listener.service ]] \
    && current_paths+=(/etc/systemd/system/rapid-swap-listener.service)
  [[ -e /etc/systemd/system/rapid-swap-listener.timer ]] \
    && current_paths+=(/etc/systemd/system/rapid-swap-listener.timer)
  local desired_names=" "
  local path name

  for path in "${desired_paths[@]}"; do
    desired_names+="$(basename "$path") "
  done
  for path in "${current_paths[@]}"; do
    name="$(basename "$path")"
    if [[ "$desired_names" != *" $name "* ]]; then
      systemctl disable --now "$name" >/dev/null 2>&1 || true
      rm -f "$path"
    fi
  done
  for path in "${desired_paths[@]}"; do
    install -o root -g root -m 0644 "$path" "/etc/systemd/system/$(basename "$path")"
  done
  shopt -u nullglob

  systemctl daemon-reload
}

start_unit_with_retry() {
  local unit="$1"
  local attempt
  for attempt in 1 2 3; do
    if systemctl start "$unit"; then
      return
    fi
    if [[ "$attempt" -lt 3 ]]; then
      echo "Prime attempt $attempt for $unit failed; retrying in 5 seconds..." >&2
      sleep 5
    fi
  done
  return 1
}

start_persistent_services() {
  local persistent=(
    boonetools-api.service
    boonetools-rujira-reserve-listener.service
    boonetools-rujira-base-fees-listener.service
  )
  systemctl enable "${persistent[@]}" >/dev/null
  systemctl restart "${persistent[@]}"

  local rapid_enabled node_votes_enabled
  rapid_enabled="$(env_value RAPID_SWAPS_WS_INGESTION_ENABLED)"
  node_votes_enabled="$(env_value NODE_VOTES_WS_INGESTION_ENABLED)"
  rapid_enabled="${rapid_enabled:-false}"
  node_votes_enabled="${node_votes_enabled:-true}"
  if [[ "$rapid_enabled" == true || "$node_votes_enabled" == true ]]; then
    systemctl enable rapid-swap-listener.service >/dev/null
    systemctl restart rapid-swap-listener.service
  else
    systemctl disable --now rapid-swap-listener.service >/dev/null 2>&1 || true
  fi
}

prime_read_models() {
  local prime_units=(
    boonetools-thornode-core-snapshot.service
    boonetools-app-layer-live-state.service
    boonetools-rujira-base-fees.service
    boonetools-rujira-reserve-payments.service
    boonetools-analytics-read-models.service
    boonetools-node-votes-summary.service
    boonetools-rapid-swaps-market-history.service
    boonetools-treasury-snapshot.service
    boonetools-status-live.service
    boonetools-status-dashboard.service
    boonetools-pool-dislocation-repair.service
    boonetools-pool-dislocation.service
    boonetools-wasm-arb-economics.service
    # Publish the newly ingested Wasm rows before the public API gate.
    boonetools-analytics-read-models.service
  )
  local unit
  for unit in "${prime_units[@]}"; do
    start_unit_with_retry "$unit"
  done
}

start_and_verify_timers() {
  shopt -s nullglob
  local timer_paths=("$CURRENT_LINK"/ops/systemd/*.timer)
  local timers=()
  local path timer timer_row attempt
  for path in "${timer_paths[@]}"; do
    timers+=("$(basename "$path")")
  done
  shopt -u nullglob
  [[ "${#timers[@]}" -gt 0 ]] || die "release contains no timers"

  systemctl enable "${timers[@]}" >/dev/null
  systemctl restart "${timers[@]}"

  for timer in "${timers[@]}"; do
    systemctl is-enabled --quiet "$timer" || die "$timer is not enabled"
    systemctl is-active --quiet "$timer" || die "$timer is not active"
    timer_row=
    for attempt in $(seq 1 10); do
      timer_row="$(systemctl list-timers --all --no-legend "$timer")"
      if [[ -n "$timer_row" ]] \
        && ! grep -Eq '^[[:space:]]*n/a[[:space:]]' <<<"$timer_row"; then
        break
      fi
      sleep 1
    done
    [[ -n "$timer_row" ]] || die "$timer has no timer state"
    if grep -Eq '^[[:space:]]*n/a[[:space:]]' <<<"$timer_row"; then
      die "$timer has no future trigger after waiting 10 seconds"
    fi
  done
}

wait_for_api() {
  local attempt
  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 5 http://127.0.0.1:8787/health >/dev/null; then
      return
    fi
    sleep 2
  done
  die "BooneTools API did not become healthy within 60 seconds"
}

verify_release() {
  wait_for_api
  node "$CURRENT_LINK/scripts/perf-smoke.mjs" \
    --base https://boone.tools/functions/v1 \
    --require-compression
  node "$CURRENT_LINK/scripts/perf-smoke.mjs" \
    --base https://boone.tools/functions/v1 \
    --endpoint status \
    --requests 50 \
    --concurrency 50 \
    --require-compression
  verify_host_routes
  if systemctl --failed --no-legend \
    | awk '{ print $1 }' \
    | grep -Eq '^(boonetools-|rapid-swap-listener)'; then
    die "a BooneTools systemd unit is failed"
  fi
}

restore_previous_release() {
  [[ -n "$PREVIOUS_TARGET" && -d "$PREVIOUS_TARGET" ]] || {
    echo "No previous release is available for rollback." >&2
    return 1
  }

  log "Rolling back to ${PREVIOUS_TARGET##*/}"
  atomic_point_current "$PREVIOUS_TARGET"
  install_units_from_release "$PREVIOUS_TARGET"
  start_persistent_services

  shopt -s nullglob
  local timer_paths=("$PREVIOUS_TARGET"/ops/systemd/*.timer)
  local timers=()
  local path
  for path in "${timer_paths[@]}"; do
    timers+=("$(basename "$path")")
  done
  shopt -u nullglob
  if [[ "${#timers[@]}" -gt 0 ]]; then
    systemctl enable "${timers[@]}" >/dev/null
    systemctl restart "${timers[@]}"
  fi

  wait_for_api
  verify_host_routes
}

cleanup_releases() {
  local active_target previous
  active_target="$(installed_release_target || true)"
  previous="$PREVIOUS_TARGET"
  local kept=0
  local entry path
  while IFS= read -r entry; do
    path="${entry#* }"
    if [[ "$path" == "$active_target" || "$path" == "$previous" || "$kept" -lt "$KEEP_RELEASES" ]]; then
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

  if [[ "$status" -ne 0 && "$ROLLBACK_REQUIRED" == true ]]; then
    echo "Deployment failed; attempting verified rollback." >&2
    if ! restore_previous_release; then
      echo "CRITICAL: automated rollback did not verify successfully." >&2
      exit 70
    fi
    echo "Previous release restored and verified." >&2
  elif [[ "$status" -ne 0 && "$QUIESCED" == true ]]; then
    echo "Deployment failed after writers were stopped and no rollback target was available." >&2
  fi
  exit "$status"
}

require_safe_arguments
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  die "another BooneTools deployment is already running"
fi
trap handle_exit EXIT

prepare_server_config
bootstrap_legacy_release
validate_archive
stage_release

if [[ -n "$PREVIOUS_TARGET" ]]; then
  log "Confirming the existing public baseline before production mutation"
  verify_host_routes
fi

start_postgres_and_wait
stop_writers

log "Applying backward-compatible database migrations"
BOONETOOLS_ENV_FILE="$ENV_FILE" bash "$RELEASE_DIR/scripts/boonetools-db-migrate.sh" </dev/null

log "Installing the release unit manifest"
install_units_from_release "$RELEASE_DIR"

log "Atomically activating release $RELEASE_ID"
atomic_point_current "$RELEASE_DIR"
ROLLBACK_REQUIRED=true

start_persistent_services
prime_read_models
start_and_verify_timers

log "Running post-deployment health and performance gates"
verify_release

ROLLBACK_REQUIRED=false
QUIESCED=false
cleanup_releases
log "Backend release $RELEASE_ID is active and verified"
