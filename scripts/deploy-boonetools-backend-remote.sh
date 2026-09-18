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
MODE=routine
MIGRATE=false
RESTART_UNITS=()
CHECK_ENDPOINTS=()
ACTIVE_UNITS=()
ENABLED_UNITS=()
STARTED_UNITS=()

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
  [[ "$RELEASE_ID" =~ ^[a-f0-9]{40}$ ]] || die "unsafe release identifier"
  [[ "$ARCHIVE" == /var/tmp/* ]] || die "release archive must be staged below /var/tmp"
  [[ "$EXPECTED_SHA256" =~ ^[a-f0-9]{64}$ ]] || die "invalid SHA-256"
  [[ "$KEEP_RELEASES" =~ ^[0-9]+$ && "$KEEP_RELEASES" -ge 2 ]] || die "KEEP_RELEASES must be at least 2"
  command -v flock >/dev/null 2>&1 || die "flock is required"
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

  if [[ -e "$RELEASE_DIR" ]]; then
    # A failed activation can retry its complete artifact without replacing code
    # that another process may still be using.
    [[ -f "$RELEASE_DIR/RELEASE" ]] && grep -qx "archive_sha256=$EXPECTED_SHA256" "$RELEASE_DIR/RELEASE" \
      || die "existing release is incomplete or has a different checksum; refusing to overwrite it"
    log "Reusing the already staged immutable artifact"
    return 0
  fi
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

read_plan() {
  node "$RELEASE_DIR/scripts/backend-deploy-plan.mjs" "$PREVIOUS_TARGET" "$RELEASE_DIR" > "$RELEASE_DIR/DEPLOY_PLAN"
  local kind value
  while read -r kind value; do
    case "$kind" in
      mode) MODE="$value" ;;
      migrate) MIGRATE="$value" ;;
      restart) RESTART_UNITS+=("$value") ;;
      check) CHECK_ENDPOINTS+=("$value") ;;
      *) die "unknown deployment plan entry: $kind" ;;
    esac
  done < "$RELEASE_DIR/DEPLOY_PLAN"
  log "Deployment scope: $MODE; migrations: $MIGRATE"
  log "Persistent restart candidates: ${RESTART_UNITS[*]:-none}"
  log "Endpoint checks: ${CHECK_ENDPOINTS[*]:-status}"
}

installed_units() {
  local unit_file
  for unit_file in /etc/systemd/system/boonetools-*.service /etc/systemd/system/boonetools-*.timer \
    /etc/systemd/system/rapid-swap-listener.service /etc/systemd/system/rapid-swap-listener.timer; do
    [[ -f "$unit_file" ]] && basename "$unit_file"
  done
  return 0
}

snapshot_unit_state() {
  local unit active
  while read -r unit; do
    active="$(systemctl show "$unit" --property=ActiveState --value)"
    case "$active" in active|activating|reloading) ACTIVE_UNITS+=("$unit") ;; esac
    if systemctl is-enabled --quiet "$unit"; then ENABLED_UNITS+=("$unit"); fi
  done < <(installed_units)
}

contains_unit() {
  local wanted="$1" unit
  shift
  for unit in "$@"; do [[ "$unit" == "$wanted" ]] && return 0; done
  return 1
}

stop_managed_units() {
  local unit timers=() services=()
  while read -r unit; do
    case "$unit" in *.timer) timers+=("$unit") ;; *) services+=("$unit") ;; esac
  done < <(installed_units)
  if [[ "${#timers[@]}" -gt 0 ]]; then systemctl stop "${timers[@]}" || return 1; fi
  if [[ "${#services[@]}" -gt 0 ]]; then systemctl stop "${services[@]}" || return 1; fi
}

install_units_from_release() {
  local source_release="$1" unit unit_file
  while read -r unit; do
    if [[ ! -f "$source_release/ops/systemd/$unit" ]]; then
      systemctl disable --now "$unit" || return 1
      rm -f "/etc/systemd/system/$unit" || return 1
    fi
  done < <(installed_units)
  for unit_file in "$source_release"/ops/systemd/*.service "$source_release"/ops/systemd/*.timer; do
    [[ -f "$unit_file" ]] || continue
    install -o root -g root -m 0644 "$unit_file" "/etc/systemd/system/${unit_file##*/}" || return 1
  done
  systemctl daemon-reload
}

start_postgres_and_wait() {
  local container attempt
  container="$(env_value BOONETOOLS_DB_CONTAINER)"
  container="${container:-boonetools-postgres}"
  (cd "$DEST" && docker compose -f "$RELEASE_DIR/ops/docker/boonetools-postgres.compose.yml" --env-file "$ENV_FILE" up -d)
  for attempt in $(seq 1 60); do
    if docker exec "$container" sh -lc 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then return; fi
    sleep 2
  done
  die "Postgres did not become ready within 120 seconds"
}

activate_services() {
  local unit unit_file
  if [[ "$MODE" == coordinated ]]; then
    # Restore existing activity, including interrupted oneshots. Do not wake
    # inactive backfills or re-enable intentionally disabled timers.
    for unit in "${ACTIVE_UNITS[@]}"; do
      [[ -f "$RELEASE_DIR/ops/systemd/$unit" ]] && STARTED_UNITS+=("$unit")
    done
    # Only newly introduced timers and persistent services get enabled.
    for unit_file in "$RELEASE_DIR"/ops/systemd/*.service "$RELEASE_DIR"/ops/systemd/*.timer; do
      [[ -f "$unit_file" ]] || continue
      unit="${unit_file##*/}"
      [[ -n "$PREVIOUS_TARGET" && -f "$PREVIOUS_TARGET/ops/systemd/$unit" ]] && continue
      if [[ "$unit" == *.timer ]] || grep -Eq '^Type=(simple|exec|notify)$' "$unit_file"; then
        systemctl enable "$unit"
        contains_unit "$unit" "${STARTED_UNITS[@]}" || STARTED_UNITS+=("$unit")
      fi
    done
  else
    for unit in "${RESTART_UNITS[@]}"; do
      contains_unit "$unit" "${ACTIVE_UNITS[@]}" && STARTED_UNITS+=("$unit")
    done
  fi

  start_selected_units
}

start_selected_units() {
  local unit
  for unit in "${STARTED_UNITS[@]}"; do
    if [[ "$unit" == *.timer ]]; then
      systemctl start "$unit" || return 1
    elif grep -q '^Type=oneshot$' "$CURRENT_LINK/ops/systemd/$unit"; then
      # Timers resume their normal cadence; provider acquisition is not a gate.
      systemctl start --no-block "$unit" || return 1
    else
      systemctl restart "$unit" || return 1
    fi
  done
}

wait_for_api() {
  local attempt
  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 5 http://127.0.0.1:8787/health >/dev/null; then return 0; fi
    sleep 2
  done
  echo "BooneTools API did not become healthy within 60 seconds" >&2
  return 1
}

verify_release() {
  wait_for_api || return 1
  local endpoint unit
  # Always exercise one DB-backed public route, even for deployment-only changes.
  local endpoints=("${CHECK_ENDPOINTS[@]}")
  [[ "${#endpoints[@]}" -gt 0 ]] || endpoints=(status)
  for endpoint in "${endpoints[@]}"; do
    node "$RELEASE_DIR/scripts/perf-smoke.mjs" \
      --base https://boone.tools/functions/v1 --endpoint "$endpoint" \
      --health-only --allow-stale --require-compression || return 1
  done
  for unit in "${STARTED_UNITS[@]}"; do
    if [[ "$unit" == *.timer ]] || ! grep -q '^Type=oneshot$' "$CURRENT_LINK/ops/systemd/$unit"; then
      systemctl is-active --quiet "$unit" || return 1
    fi
  done
}

restore_previous_release() {
  [[ -n "$PREVIOUS_TARGET" && -d "$PREVIOUS_TARGET" ]] || {
    echo "No previous release is available for rollback." >&2
    return 1
  }
  log "Rolling back to ${PREVIOUS_TARGET##*/}"
  if [[ "$MODE" == coordinated ]]; then
    stop_managed_units || return 1
  fi
  atomic_point_current "$PREVIOUS_TARGET" || return 1
  if [[ "$MODE" == coordinated ]]; then
    install_units_from_release "$PREVIOUS_TARGET" || return 1
    if [[ "${#ENABLED_UNITS[@]}" -gt 0 ]]; then systemctl enable "${ENABLED_UNITS[@]}" || return 1; fi
    STARTED_UNITS=("${ACTIVE_UNITS[@]}")
  fi
  start_selected_units || return 1
  # Rollback checks the same changed endpoints, not unrelated sites/providers.
  verify_release
}

release_in_use() {
  local candidate="$1" process_cwd resolved
  # An untouched listener or in-flight oneshot may still use an older release.
  # Its cwd resolves to the physical directory, not the new current symlink.
  for process_cwd in /proc/[0-9]*/cwd; do
    resolved="$(readlink -f "$process_cwd" 2>/dev/null || true)"
    if [[ "$resolved" == "$candidate" || "$resolved" == "$candidate/"* ]]; then return 0; fi
  done
  return 1
}

cleanup_releases() {
  local active_target entry release_path kept=0
  active_target="$(installed_release_target || true)"
  while IFS= read -r entry; do
    release_path="${entry#* }"
    if [[ "$release_path" == "$active_target" || "$release_path" == "$PREVIOUS_TARGET" || "$kept" -lt "$KEEP_RELEASES" ]] \
      || release_in_use "$release_path"; then
      kept=$((kept + 1))
      continue
    fi
    rm -rf "$release_path"
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr)
}

handle_exit() {
  local exit_code=$?
  trap - EXIT
  rm -f "$ARCHIVE"
  if [[ "$exit_code" -ne 0 && "$ROLLBACK_REQUIRED" == true ]]; then
    echo "Deployment failed; attempting verified rollback." >&2
    if ! restore_previous_release; then
      echo "CRITICAL: automated rollback did not verify successfully." >&2
      exit 70
    fi
    echo "Previous release restored and verified." >&2
  fi
  exit "$exit_code"
}

require_safe_arguments
exec 9>"$LOCK_FILE"
if ! flock -n 9; then die "another BooneTools deployment is already running"; fi
trap handle_exit EXIT

prepare_server_config
bootstrap_legacy_release
validate_archive
stage_release
read_plan

if [[ -n "$PREVIOUS_TARGET" ]]; then
  log "Checking the existing API before activation"
  wait_for_api
fi
snapshot_unit_state
ROLLBACK_REQUIRED=true
if [[ "$MODE" == coordinated ]]; then
  log "Schema, dependency, or unit changes: coordinating existing services"
  stop_managed_units
  start_postgres_and_wait
  if [[ "$MIGRATE" == true ]]; then
    log "Applying backward-compatible database migrations"
    BOONETOOLS_ENV_FILE="$ENV_FILE" bash "$RELEASE_DIR/scripts/boonetools-db-migrate.sh" </dev/null
  fi
  install_units_from_release "$RELEASE_DIR"
fi

log "Atomically activating release $RELEASE_ID"
atomic_point_current "$RELEASE_DIR"
activate_services
log "Checking affected API routes and restarted services"
verify_release
ROLLBACK_REQUIRED=false
cleanup_releases
log "Backend release $RELEASE_ID is active and verified; scheduled jobs continue on their normal cadence"
