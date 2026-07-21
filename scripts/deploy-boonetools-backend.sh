#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/require-canonical-boonetools-repo.sh"

ROOT="$BOONETOOLS_CANONICAL_ROOT"
SERVER="${SERVER:-root@178.156.211.181}"
DEST="${DEST:-/opt/boonetools-backend}"
BACKEND_DEST="$DEST/backend"
ROLLBACK_DEST="$DEST/.deploy-rollback"
WRITERS_QUIESCED=false

start_remote_unit_with_retry() {
  local unit="$1"
  local attempt
  for attempt in 1 2 3; do
    if ssh "$SERVER" "systemctl start $unit"; then
      return 0
    fi
    if [[ "$attempt" -lt 3 ]]; then
      echo "Prime attempt $attempt for $unit failed; retrying in 5 seconds..." >&2
      sleep 5
    fi
  done
  return 1
}

rollback_failed_deploy() {
  local exit_status=$?
  trap - EXIT
  if [[ "$exit_status" -ne 0 && "$WRITERS_QUIESCED" == "true" ]]; then
    echo "Deploy failed; restoring the previous backend, unit state, and Caddy config..." >&2
    ssh "$SERVER" "DEST='$DEST' BACKEND_DEST='$BACKEND_DEST' ROLLBACK_DEST='$ROLLBACK_DEST' bash -s" <<'REMOTE' || true
set -u
shopt -s nullglob

current_unit_paths=(
  /etc/systemd/system/boonetools-*.service
  /etc/systemd/system/boonetools-*.timer
  /etc/systemd/system/rapid-swap-listener.service
  /etc/systemd/system/rapid-swap-listener.timer
)
current_units=()
for unit_path in "${current_unit_paths[@]}"; do
  current_units+=("$(basename "$unit_path")")
done
if [[ "${#current_units[@]}" -gt 0 ]]; then
  systemctl disable --now "${current_units[@]}" 2>/dev/null || true
fi

if [[ -d "$ROLLBACK_DEST/backend" ]]; then
  rsync -a --delete --exclude '.env' --exclude 'node_modules' "$ROLLBACK_DEST/backend/" "$BACKEND_DEST/"
fi
if [[ -d "$ROLLBACK_DEST/shared" ]]; then
  rsync -a --delete "$ROLLBACK_DEST/shared/" "$DEST/shared/"
fi

if [[ "${#current_unit_paths[@]}" -gt 0 ]]; then
  rm -f -- "${current_unit_paths[@]}"
fi
if [[ -d "$ROLLBACK_DEST/systemd" ]]; then
  previous_unit_paths=("$ROLLBACK_DEST"/systemd/*)
  if [[ "${#previous_unit_paths[@]}" -gt 0 ]]; then
    cp -a -- "${previous_unit_paths[@]}" /etc/systemd/system/
  fi
fi
systemctl daemon-reload || true

if [[ -s "$ROLLBACK_DEST/systemd-enabled.list" ]]; then
  mapfile -t enabled_units < "$ROLLBACK_DEST/systemd-enabled.list"
  systemctl enable "${enabled_units[@]}" 2>/dev/null || true
fi
if [[ -s "$ROLLBACK_DEST/systemd-active.list" ]]; then
  mapfile -t active_units < "$ROLLBACK_DEST/systemd-active.list"
  systemctl start "${active_units[@]}" 2>/dev/null || true
fi
if [[ -f /etc/systemd/system/boonetools-api.service ]]; then
  systemctl restart boonetools-api.service 2>/dev/null || true
fi

if [[ -f "$ROLLBACK_DEST/Caddyfile" ]]; then
  install -m 0644 "$ROLLBACK_DEST/Caddyfile" /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 && systemctl reload caddy || true
fi
REMOTE
  fi
  exit "$exit_status"
}

trap rollback_failed_deploy EXIT

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ROOT/.env"
  set +a
fi

PUBLIC_API_KEY_VALUE="${PUBLIC_API_KEY:-${VITE_NODEOP_API_KEY:-${VITE_RAPID_SWAPS_API_KEY:-}}}"
THORNODE_PRIMARY_VALUE="${THORNODE_PRIMARY_URL:-https://gateway.liquify.com/chain/thorchain_api}"
THORNODE_ARCHIVE_VALUE="${THORNODE_ARCHIVE_URL:-https://thornode-archive.ninerealms.com}"
THORNODE_FALLBACK_VALUE="${THORNODE_FALLBACK_URL:-https://thornode.thorchain.network}"
MIDGARD_URL_VALUE="${MIDGARD_URL:-https://gateway.liquify.com/chain/thorchain_midgard/v2}"
MIDGARD_FALLBACK_VALUE="${MIDGARD_FALLBACK_URL:-https://midgard.thorchain.network/v2}"
RPC_REST_URL_VALUE="${RPC_REST_URL:-https://gateway.liquify.com/chain/thorchain_rpc}"
RPC_FALLBACK_REST_URL_VALUE="${RPC_FALLBACK_REST_URL:-https://rpc.thorchain.network}"
RPC_WS_URL_VALUE="${RPC_WS_URL:-wss://gateway.liquify.com/chain/thorchain_rpc/websocket}"
CMC_API_KEY_VALUE="${CMC_API_KEY:-${CMC_PRO_API_KEY:-}}"
CMC_GLOBAL_METRICS_HISTORICAL_URL_VALUE="${CMC_GLOBAL_METRICS_HISTORICAL_URL:-https://api.coinmarketcap.com/data-api/v3/global-metrics/quotes/historical}"
CMC_GLOBAL_METRICS_INTERVAL_VALUE="${CMC_GLOBAL_METRICS_INTERVAL:-1d}"
DUNE_API_KEY_VALUE="${DUNE_API_KEY_VALUE:-${DUNE_API_KEY:-}}"
TC_FEE_DASH_HEAD_LAG_DAYS_DEPLOY_VALUE="${TC_FEE_DASH_HEAD_LAG_DAYS:-1}"

echo "==> Preparing remote directories..."
ssh "$SERVER" "mkdir -p $BACKEND_DEST $DEST/scripts $DEST/shared $DEST/ops/caddy $DEST/ops/docker $DEST/ops/systemd $ROLLBACK_DEST/backend $ROLLBACK_DEST/shared $ROLLBACK_DEST/systemd"

echo "==> Snapshotting the current backend, systemd state, and Caddy config for rollback..."
ssh "$SERVER" "DEST='$DEST' BACKEND_DEST='$BACKEND_DEST' ROLLBACK_DEST='$ROLLBACK_DEST' bash -s" <<'REMOTE'
set -euo pipefail
shopt -s nullglob
rsync -a --delete --exclude '.env' --exclude 'node_modules' "$BACKEND_DEST/" "$ROLLBACK_DEST/backend/"
rsync -a --delete "$DEST/shared/" "$ROLLBACK_DEST/shared/"
rm -rf "$ROLLBACK_DEST/systemd"
mkdir -p "$ROLLBACK_DEST/systemd"
: > "$ROLLBACK_DEST/systemd-enabled.list"
: > "$ROLLBACK_DEST/systemd-active.list"
unit_paths=(
  /etc/systemd/system/boonetools-*.service
  /etc/systemd/system/boonetools-*.timer
  /etc/systemd/system/rapid-swap-listener.service
  /etc/systemd/system/rapid-swap-listener.timer
)
for unit_path in "${unit_paths[@]}"; do
  [[ -f "$unit_path" ]] || continue
  unit="$(basename "$unit_path")"
  cp -a "$unit_path" "$ROLLBACK_DEST/systemd/$unit"
  systemctl is-enabled --quiet "$unit" && echo "$unit" >> "$ROLLBACK_DEST/systemd-enabled.list" || true
  systemctl is-active --quiet "$unit" && echo "$unit" >> "$ROLLBACK_DEST/systemd-active.list" || true
done
if [[ -f /etc/caddy/Caddyfile ]]; then
  cp -a /etc/caddy/Caddyfile "$ROLLBACK_DEST/Caddyfile"
else
  rm -f "$ROLLBACK_DEST/Caddyfile"
fi
REMOTE

echo "==> Quiescing backend writers before release sync..."
ssh "$SERVER" bash -s <<'REMOTE'
set -euo pipefail
candidates=(
  boonetools-analytics-read-models.timer boonetools-analytics-read-models.service
  boonetools-node-votes-summary.timer boonetools-node-votes-summary.service
  boonetools-rapid-swaps-market-history.timer boonetools-rapid-swaps-market-history.service
  boonetools-status-dashboard.timer boonetools-status-dashboard.service
  boonetools-treasury-snapshot.timer boonetools-treasury-snapshot.service
  boonetools-nodeop-scheduler.timer boonetools-nodeop-scheduler.service
  boonetools-rapid-swaps-scheduler.timer boonetools-rapid-swaps-scheduler.service
  boonetools-app-layer-live-state.timer boonetools-app-layer-live-state.service
  boonetools-rujira-base-fees.timer boonetools-rujira-base-fees.service
  boonetools-rujira-reserve-payments.timer boonetools-rujira-reserve-payments.service
  boonetools-node-votes-backfill.timer boonetools-node-votes-backfill.service
  boonetools-bond-history-refresh.timer boonetools-bond-history-refresh.service
  boonetools-tc-fee-dash-backfill.timer boonetools-tc-fee-dash-backfill.service
  boonetools-rujira-reserve-listener.service boonetools-rujira-base-fees-listener.service
  rapid-swap-listener.service
)
installed=()
active_before=()
for unit in "${candidates[@]}"; do
  if systemctl cat "$unit" >/dev/null 2>&1; then
    installed+=("$unit")
    systemctl is-active --quiet "$unit" && active_before+=("$unit") || true
  fi
done
restore_partial_quiesce() {
  local exit_status=$?
  trap - EXIT
  if [[ "$exit_status" -ne 0 && "${#active_before[@]}" -gt 0 ]]; then
    systemctl start "${active_before[@]}" 2>/dev/null || true
  fi
  exit "$exit_status"
}
trap restore_partial_quiesce EXIT
if [[ "${#installed[@]}" -gt 0 ]]; then
  systemctl stop "${installed[@]}"
fi
for unit in "${installed[@]}"; do
  if systemctl is-active --quiet "$unit"; then
    echo "Writer unit remained active after stop: $unit" >&2
    exit 1
  fi
done
trap - EXIT
REMOTE
WRITERS_QUIESCED=true

echo "==> Syncing backend, shared modules, and ops assets..."
rsync -avz --delete --exclude '.env' --exclude 'node_modules' "$ROOT/backend/" "$SERVER:$BACKEND_DEST/"
rsync -avz "$ROOT/scripts/boonetools-db-migrate.sh" "$SERVER:$DEST/scripts/"
rsync -avz "$ROOT/scripts/boonetools-db-backup.sh" "$SERVER:$DEST/scripts/"
rsync -avz "$ROOT/scripts/boonetools-db-restore.sh" "$SERVER:$DEST/scripts/"
rsync -avz "$ROOT/scripts/perf-smoke.mjs" "$SERVER:$DEST/scripts/"
rsync -avz "$ROOT/scripts/catchup-rapid-swaps.mjs" "$SERVER:$DEST/scripts/"
rsync -avz "$ROOT/scripts/repair-bond-history.mjs" "$SERVER:$DEST/scripts/"
rsync -avz "$ROOT/scripts/rapid-swap-listener.mjs" "$SERVER:$DEST/scripts/"
rsync -avz --delete "$ROOT/shared/" "$SERVER:$DEST/shared/"
rsync -avz "$ROOT/ops/caddy/" "$SERVER:$DEST/ops/caddy/"
rsync -avz "$ROOT/ops/docker/" "$SERVER:$DEST/ops/docker/"
rsync -avz "$ROOT/ops/systemd/" "$SERVER:$DEST/ops/systemd/"

echo "==> Ensuring backend env file exists..."
ssh "$SERVER" "PUBLIC_API_KEY_VALUE='$PUBLIC_API_KEY_VALUE' THORNODE_PRIMARY_VALUE='$THORNODE_PRIMARY_VALUE' THORNODE_ARCHIVE_VALUE='$THORNODE_ARCHIVE_VALUE' THORNODE_FALLBACK_VALUE='$THORNODE_FALLBACK_VALUE' MIDGARD_URL_VALUE='$MIDGARD_URL_VALUE' MIDGARD_FALLBACK_VALUE='$MIDGARD_FALLBACK_VALUE' RPC_REST_URL_VALUE='$RPC_REST_URL_VALUE' RPC_FALLBACK_REST_URL_VALUE='$RPC_FALLBACK_REST_URL_VALUE' RPC_WS_URL_VALUE='$RPC_WS_URL_VALUE' CMC_API_KEY_VALUE='$CMC_API_KEY_VALUE' CMC_GLOBAL_METRICS_HISTORICAL_URL_VALUE='$CMC_GLOBAL_METRICS_HISTORICAL_URL_VALUE' CMC_GLOBAL_METRICS_INTERVAL_VALUE='$CMC_GLOBAL_METRICS_INTERVAL_VALUE' DUNE_API_KEY_VALUE='$DUNE_API_KEY_VALUE' TC_FEE_DASH_HEAD_LAG_DAYS_DEPLOY_VALUE='$TC_FEE_DASH_HEAD_LAG_DAYS_DEPLOY_VALUE' bash -s" <<'REMOTE'
set -euo pipefail
DEST="${DEST:-/opt/boonetools-backend}"
BACKEND_DEST="$DEST/backend"
ENV_FILE="$BACKEND_DEST/.env"

normalize_timestamp_value() {
  local value="$1"
  if [[ "$value" == *" "* ]]; then
    value="${value/ /T}"
    if [[ "$value" != *Z ]]; then
      value="${value}Z"
    fi
  fi
  printf '%s' "$value"
}

if [[ -f "$ENV_FILE" ]]; then
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    export "$key=$value"
  done < "$ENV_FILE"
fi

PORT_VALUE="${PORT:-8787}"
DB_CONTAINER_VALUE="${BOONETOOLS_DB_CONTAINER:-boonetools-postgres}"
DB_NAME_VALUE="${BOONETOOLS_DB_NAME:-boonetools}"
DB_USER_VALUE="${BOONETOOLS_DB_USER:-boonetools}"
DB_PASSWORD_VALUE="${BOONETOOLS_DB_PASSWORD:-$(openssl rand -hex 24)}"
API_KEY_VALUE="${PUBLIC_API_KEY_VALUE:-${PUBLIC_API_KEY:-}}"
DATABASE_URL_VALUE="${DATABASE_URL:-postgresql://$DB_USER_VALUE:$DB_PASSWORD_VALUE@127.0.0.1:5433/$DB_NAME_VALUE}"
THORNODE_PRIMARY_URL_VALUE="${THORNODE_PRIMARY_VALUE:-${THORNODE_PRIMARY_URL:-https://gateway.liquify.com/chain/thorchain_api}}"
THORNODE_ARCHIVE_URL_VALUE="${THORNODE_ARCHIVE_VALUE:-${THORNODE_ARCHIVE_URL:-https://thornode-archive.ninerealms.com}}"
THORNODE_FALLBACK_URL_VALUE="${THORNODE_FALLBACK_VALUE:-${THORNODE_FALLBACK_URL:-https://thornode.thorchain.network}}"
MIDGARD_URL_FINAL="${MIDGARD_URL_VALUE:-${MIDGARD_URL:-https://gateway.liquify.com/chain/thorchain_midgard/v2}}"
MIDGARD_FALLBACK_URL_FINAL="${MIDGARD_FALLBACK_VALUE:-${MIDGARD_FALLBACK_URL:-https://midgard.thorchain.network/v2}}"
RPC_REST_URL_FINAL="${RPC_REST_URL_VALUE:-${RPC_REST_URL:-https://gateway.liquify.com/chain/thorchain_rpc}}"
RPC_FALLBACK_REST_URL_FINAL="${RPC_FALLBACK_REST_URL_VALUE:-${RPC_FALLBACK_REST_URL:-https://rpc.thorchain.network}}"
RPC_WS_URL_FINAL="${RPC_WS_URL_VALUE:-${RPC_WS_URL:-wss://gateway.liquify.com/chain/thorchain_rpc/websocket}}"
MIDGARD_DELAY_MS_VALUE="${MIDGARD_DELAY_MS:-5000}"
RAPID_SWAPS_MAX_PAGES_VALUE="${RAPID_SWAPS_MAX_PAGES:-200}"
RAPID_SWAPS_CATCHUP_MAX_PAGES_VALUE="${RAPID_SWAPS_CATCHUP_MAX_PAGES:-200}"
RAPID_SWAPS_CANONICAL_SCAN_INTERVAL_SECONDS_VALUE="${RAPID_SWAPS_CANONICAL_SCAN_INTERVAL_SECONDS:-900}"
RAPID_SWAPS_NORMAL_HEAD_PAGES_VALUE="${RAPID_SWAPS_NORMAL_HEAD_PAGES:-4}"
RAPID_SWAPS_LAGGING_HEAD_PAGES_VALUE="${RAPID_SWAPS_LAGGING_HEAD_PAGES:-2}"
RAPID_SWAPS_CATCHUP_PAGES_VALUE="${RAPID_SWAPS_CATCHUP_PAGES:-2}"
RAPID_SWAPS_RATE_LIMIT_COOLDOWN_SECONDS_VALUE="${RAPID_SWAPS_RATE_LIMIT_COOLDOWN_SECONDS:-3600}"
RAPID_SWAPS_SOURCE_IDLE_COOLDOWN_SECONDS_VALUE="${RAPID_SWAPS_SOURCE_IDLE_COOLDOWN_SECONDS:-900}"
RAPID_SWAPS_HEIGHT_OVERLAP_BLOCKS_VALUE="${RAPID_SWAPS_HEIGHT_OVERLAP_BLOCKS:-1800}"
RAPID_SWAPS_MAX_CANDIDATE_ATTEMPTS_VALUE="${RAPID_SWAPS_MAX_CANDIDATE_ATTEMPTS:-12}"
RAPID_SWAPS_PENDING_CANDIDATE_BATCH_VALUE="${RAPID_SWAPS_PENDING_CANDIDATE_BATCH:-100}"
RAPID_SWAPS_DUNE_QUERY_ID_VALUE="${RAPID_SWAPS_DUNE_QUERY_ID:-7619996}"
RAPID_SWAPS_DUNE_START_TIME_VALUE="${RAPID_SWAPS_DUNE_START_TIME:-2026-04-01T00:00:00Z}"
RAPID_SWAPS_DUNE_START_TIME_VALUE="$(normalize_timestamp_value "$RAPID_SWAPS_DUNE_START_TIME_VALUE")"
RAPID_SWAPS_DUNE_DAYS_PER_RUN_VALUE="${RAPID_SWAPS_DUNE_DAYS_PER_RUN:-3}"
RAPID_SWAPS_DUNE_HEAD_LAG_HOURS_VALUE="${RAPID_SWAPS_DUNE_HEAD_LAG_HOURS:-6}"
RAPID_SWAPS_DUNE_LIMIT_VALUE="${RAPID_SWAPS_DUNE_LIMIT:-5000}"
RAPID_SWAPS_DUNE_SCAN_INTERVAL_SECONDS_VALUE="${RAPID_SWAPS_DUNE_SCAN_INTERVAL_SECONDS:-21600}"
RAPID_SWAPS_LIVE_TAIL_INTERVAL_SECONDS_VALUE="${RAPID_SWAPS_LIVE_TAIL_INTERVAL_SECONDS:-300}"
RAPID_SWAPS_LIVE_TAIL_PAGES_VALUE="${RAPID_SWAPS_LIVE_TAIL_PAGES:-2}"
RAPID_SWAPS_MARKET_HISTORY_DUNE_QUERY_ID_VALUE="${RAPID_SWAPS_MARKET_HISTORY_DUNE_QUERY_ID:-7620035}"
RAPID_SWAPS_WS_INGESTION_ENABLED_VALUE="${RAPID_SWAPS_WS_INGESTION_ENABLED:-false}"
APP_LAYER_LIVE_STATE_TTL_SECONDS_VALUE="${APP_LAYER_LIVE_STATE_TTL_SECONDS:-120}"
RUJIRA_BASE_FEES_MIDGARD_URLS_VALUE="${RUJIRA_BASE_FEES_MIDGARD_URLS:-$MIDGARD_URL_FINAL,$MIDGARD_FALLBACK_URL_FINAL}"
RUJIRA_BASE_FEES_RPC_URLS_VALUE="${RUJIRA_BASE_FEES_RPC_URLS:-$RPC_REST_URL_FINAL,$RPC_FALLBACK_REST_URL_FINAL}"
RUJIRA_BASE_FEES_MIDGARD_MAX_PAGES_VALUE="${RUJIRA_BASE_FEES_MIDGARD_MAX_PAGES:-10}"
RUJIRA_BASE_FEES_BLOCK_MAX_HEIGHTS_VALUE="${RUJIRA_BASE_FEES_BLOCK_MAX_HEIGHTS:-75}"
RUJIRA_BASE_FEES_REQUEST_DELAY_MS_VALUE="${RUJIRA_BASE_FEES_REQUEST_DELAY_MS:-250}"
RUJIRA_BASE_FEES_RATE_LIMIT_COOLDOWN_SECONDS_VALUE="${RUJIRA_BASE_FEES_RATE_LIMIT_COOLDOWN_SECONDS:-3600}"
RUJIRA_BASE_FEES_DUNE_QUERY_ID_VALUE="${RUJIRA_BASE_FEES_DUNE_QUERY_ID:-7620091}"
RUJIRA_BASE_FEES_DUNE_START_TIME_VALUE="${RUJIRA_BASE_FEES_DUNE_START_TIME:-2026-04-30T00:00:00Z}"
RUJIRA_BASE_FEES_DUNE_START_TIME_VALUE="$(normalize_timestamp_value "$RUJIRA_BASE_FEES_DUNE_START_TIME_VALUE")"
RUJIRA_BASE_FEES_DUNE_DAYS_PER_RUN_VALUE="${RUJIRA_BASE_FEES_DUNE_DAYS_PER_RUN:-3}"
RUJIRA_BASE_FEES_DUNE_HEAD_LAG_HOURS_VALUE="${RUJIRA_BASE_FEES_DUNE_HEAD_LAG_HOURS:-6}"
RUJIRA_BASE_FEES_DUNE_LIMIT_VALUE="${RUJIRA_BASE_FEES_DUNE_LIMIT:-5000}"
RUJIRA_RESERVE_PAYMENTS_MIDGARD_URLS_VALUE="${RUJIRA_RESERVE_PAYMENTS_MIDGARD_URLS:-$MIDGARD_URL_FINAL,$MIDGARD_FALLBACK_URL_FINAL}"
RUJIRA_RESERVE_PAYMENTS_RPC_URLS_VALUE="${RUJIRA_RESERVE_PAYMENTS_RPC_URLS:-$RPC_REST_URL_FINAL,$RPC_FALLBACK_REST_URL_FINAL}"
RUJIRA_RESERVE_PAYMENTS_START_HEIGHT_VALUE="${RUJIRA_RESERVE_PAYMENTS_START_HEIGHT:-25982820}"
RUJIRA_RESERVE_PAYMENTS_SCHEDULE_BLOCKS_VALUE="${RUJIRA_RESERVE_PAYMENTS_SCHEDULE_BLOCKS:-101}"
RUJIRA_RESERVE_PAYMENTS_HEAD_LAG_BLOCKS_VALUE="${RUJIRA_RESERVE_PAYMENTS_HEAD_LAG_BLOCKS:-2}"
RUJIRA_RESERVE_PAYMENTS_MIDGARD_MAX_PAGES_VALUE="${RUJIRA_RESERVE_PAYMENTS_MIDGARD_MAX_PAGES:-4}"
RUJIRA_RESERVE_PAYMENTS_CANDIDATE_MAX_HEIGHTS_VALUE="${RUJIRA_RESERVE_PAYMENTS_CANDIDATE_MAX_HEIGHTS:-300}"
RUJIRA_RESERVE_PAYMENTS_BLOCK_MAX_HEIGHTS_VALUE="${RUJIRA_RESERVE_PAYMENTS_BLOCK_MAX_HEIGHTS:-150}"
RUJIRA_RESERVE_PAYMENTS_REQUEST_DELAY_MS_VALUE="${RUJIRA_RESERVE_PAYMENTS_REQUEST_DELAY_MS:-100}"
RUJIRA_RESERVE_PAYMENTS_RATE_LIMIT_COOLDOWN_SECONDS_VALUE="${RUJIRA_RESERVE_PAYMENTS_RATE_LIMIT_COOLDOWN_SECONDS:-3600}"
RUJIRA_RESERVE_PAYMENTS_DUNE_QUERY_ID_VALUE="${RUJIRA_RESERVE_PAYMENTS_DUNE_QUERY_ID:-7620011}"
RUJIRA_RESERVE_PAYMENTS_DUNE_START_TIME_VALUE="${RUJIRA_RESERVE_PAYMENTS_DUNE_START_TIME:-2026-04-30T00:00:00Z}"
RUJIRA_RESERVE_PAYMENTS_DUNE_START_TIME_VALUE="$(normalize_timestamp_value "$RUJIRA_RESERVE_PAYMENTS_DUNE_START_TIME_VALUE")"
RUJIRA_RESERVE_PAYMENTS_DUNE_HEAD_LAG_HOURS_VALUE="${RUJIRA_RESERVE_PAYMENTS_DUNE_HEAD_LAG_HOURS:-6}"
BOND_TX_EVENTS_DUNE_QUERY_ID_VALUE="${BOND_TX_EVENTS_DUNE_QUERY_ID:-7620042}"
BOND_TX_EVENTS_DUNE_START_TIME_VALUE="${BOND_TX_EVENTS_DUNE_START_TIME:-2022-01-01T00:00:00Z}"
BOND_TX_EVENTS_DUNE_START_TIME_VALUE="$(normalize_timestamp_value "$BOND_TX_EVENTS_DUNE_START_TIME_VALUE")"
BOND_TX_EVENTS_DUNE_LIMIT_VALUE="${BOND_TX_EVENTS_DUNE_LIMIT:-1000}"
DUNE_API_KEY_VALUE="${DUNE_API_KEY_VALUE:-${DUNE_API_KEY:-}}"
DUNE_API_BASE_URL_VALUE="${DUNE_API_BASE_URL:-https://api.dune.com}"
DUNE_PERFORMANCE_VALUE="${DUNE_PERFORMANCE:-small}"
DUNE_EXECUTION_POLL_MS_VALUE="${DUNE_EXECUTION_POLL_MS:-5000}"
DUNE_EXECUTION_TIMEOUT_MS_VALUE="${DUNE_EXECUTION_TIMEOUT_MS:-600000}"
CMC_API_KEY_FINAL="${CMC_API_KEY_VALUE:-${CMC_API_KEY:-${CMC_PRO_API_KEY:-}}}"
CMC_GLOBAL_METRICS_HISTORICAL_URL_FINAL="${CMC_GLOBAL_METRICS_HISTORICAL_URL_VALUE:-${CMC_GLOBAL_METRICS_HISTORICAL_URL:-https://api.coinmarketcap.com/data-api/v3/global-metrics/quotes/historical}}"
CMC_GLOBAL_METRICS_INTERVAL_FINAL="${CMC_GLOBAL_METRICS_INTERVAL_VALUE:-${CMC_GLOBAL_METRICS_INTERVAL:-1d}}"
TC_FEE_DASH_DUNE_QUERY_ID_VALUE="${TC_FEE_DASH_DUNE_QUERY_ID:-7619850}"
NODE_VOTES_DUNE_QUERY_ID_VALUE="${NODE_VOTES_DUNE_QUERY_ID:-7619989}"
NODE_VOTES_WS_INGESTION_ENABLED_VALUE="${NODE_VOTES_WS_INGESTION_ENABLED:-true}"
NODE_VOTES_BACKFILL_LOOKBACK_DAYS_VALUE="${NODE_VOTES_BACKFILL_LOOKBACK_DAYS:-14}"
TC_FEE_DASH_START_DATE_VALUE="${TC_FEE_DASH_START_DATE:-2022-06-22}"
TC_FEE_DASH_END_DATE_VALUE="${TC_FEE_DASH_END_DATE:-}"
TC_FEE_DASH_DAYS_PER_RUN_VALUE="${TC_FEE_DASH_DAYS_PER_RUN:-90}"
TC_FEE_DASH_HEAD_LAG_DAYS_VALUE="${TC_FEE_DASH_HEAD_LAG_DAYS_DEPLOY_VALUE:-${TC_FEE_DASH_HEAD_LAG_DAYS:-1}}"
TC_FEE_DASH_REQUEST_DELAY_MS_VALUE="${TC_FEE_DASH_REQUEST_DELAY_MS:-1000}"
TC_FEE_DASH_RATE_LIMIT_COOLDOWN_SECONDS_VALUE="${TC_FEE_DASH_RATE_LIMIT_COOLDOWN_SECONDS:-3600}"

cat > "$ENV_FILE" <<EOF
PORT=$PORT_VALUE
BOONETOOLS_DB_CONTAINER=$DB_CONTAINER_VALUE
BOONETOOLS_DB_NAME=$DB_NAME_VALUE
BOONETOOLS_DB_USER=$DB_USER_VALUE
BOONETOOLS_DB_PASSWORD=$DB_PASSWORD_VALUE
DATABASE_URL=$DATABASE_URL_VALUE
PUBLIC_API_KEY=$API_KEY_VALUE
THORNODE_PRIMARY_URL=$THORNODE_PRIMARY_URL_VALUE
THORNODE_ARCHIVE_URL=$THORNODE_ARCHIVE_URL_VALUE
THORNODE_FALLBACK_URL=$THORNODE_FALLBACK_URL_VALUE
MIDGARD_URL=$MIDGARD_URL_FINAL
MIDGARD_FALLBACK_URL=$MIDGARD_FALLBACK_URL_FINAL
RPC_REST_URL=$RPC_REST_URL_FINAL
RPC_FALLBACK_REST_URL=$RPC_FALLBACK_REST_URL_FINAL
RPC_WS_URL=$RPC_WS_URL_FINAL
MIDGARD_DELAY_MS=$MIDGARD_DELAY_MS_VALUE
RAPID_SWAPS_MAX_PAGES=$RAPID_SWAPS_MAX_PAGES_VALUE
RAPID_SWAPS_CATCHUP_MAX_PAGES=$RAPID_SWAPS_CATCHUP_MAX_PAGES_VALUE
RAPID_SWAPS_CANONICAL_SCAN_INTERVAL_SECONDS=$RAPID_SWAPS_CANONICAL_SCAN_INTERVAL_SECONDS_VALUE
RAPID_SWAPS_NORMAL_HEAD_PAGES=$RAPID_SWAPS_NORMAL_HEAD_PAGES_VALUE
RAPID_SWAPS_LAGGING_HEAD_PAGES=$RAPID_SWAPS_LAGGING_HEAD_PAGES_VALUE
RAPID_SWAPS_CATCHUP_PAGES=$RAPID_SWAPS_CATCHUP_PAGES_VALUE
RAPID_SWAPS_RATE_LIMIT_COOLDOWN_SECONDS=$RAPID_SWAPS_RATE_LIMIT_COOLDOWN_SECONDS_VALUE
RAPID_SWAPS_SOURCE_IDLE_COOLDOWN_SECONDS=$RAPID_SWAPS_SOURCE_IDLE_COOLDOWN_SECONDS_VALUE
RAPID_SWAPS_HEIGHT_OVERLAP_BLOCKS=$RAPID_SWAPS_HEIGHT_OVERLAP_BLOCKS_VALUE
RAPID_SWAPS_MAX_CANDIDATE_ATTEMPTS=$RAPID_SWAPS_MAX_CANDIDATE_ATTEMPTS_VALUE
RAPID_SWAPS_PENDING_CANDIDATE_BATCH=$RAPID_SWAPS_PENDING_CANDIDATE_BATCH_VALUE
RAPID_SWAPS_DUNE_QUERY_ID=$RAPID_SWAPS_DUNE_QUERY_ID_VALUE
RAPID_SWAPS_DUNE_START_TIME=$RAPID_SWAPS_DUNE_START_TIME_VALUE
RAPID_SWAPS_DUNE_DAYS_PER_RUN=$RAPID_SWAPS_DUNE_DAYS_PER_RUN_VALUE
RAPID_SWAPS_DUNE_HEAD_LAG_HOURS=$RAPID_SWAPS_DUNE_HEAD_LAG_HOURS_VALUE
RAPID_SWAPS_DUNE_LIMIT=$RAPID_SWAPS_DUNE_LIMIT_VALUE
RAPID_SWAPS_DUNE_SCAN_INTERVAL_SECONDS=$RAPID_SWAPS_DUNE_SCAN_INTERVAL_SECONDS_VALUE
RAPID_SWAPS_LIVE_TAIL_INTERVAL_SECONDS=$RAPID_SWAPS_LIVE_TAIL_INTERVAL_SECONDS_VALUE
RAPID_SWAPS_LIVE_TAIL_PAGES=$RAPID_SWAPS_LIVE_TAIL_PAGES_VALUE
RAPID_SWAPS_MARKET_HISTORY_DUNE_QUERY_ID=$RAPID_SWAPS_MARKET_HISTORY_DUNE_QUERY_ID_VALUE
RAPID_SWAPS_WS_INGESTION_ENABLED=$RAPID_SWAPS_WS_INGESTION_ENABLED_VALUE
APP_LAYER_LIVE_STATE_TTL_SECONDS=$APP_LAYER_LIVE_STATE_TTL_SECONDS_VALUE
RUJIRA_BASE_FEES_MIDGARD_URLS=$RUJIRA_BASE_FEES_MIDGARD_URLS_VALUE
RUJIRA_BASE_FEES_RPC_URLS=$RUJIRA_BASE_FEES_RPC_URLS_VALUE
RUJIRA_BASE_FEES_MIDGARD_MAX_PAGES=$RUJIRA_BASE_FEES_MIDGARD_MAX_PAGES_VALUE
RUJIRA_BASE_FEES_BLOCK_MAX_HEIGHTS=$RUJIRA_BASE_FEES_BLOCK_MAX_HEIGHTS_VALUE
RUJIRA_BASE_FEES_REQUEST_DELAY_MS=$RUJIRA_BASE_FEES_REQUEST_DELAY_MS_VALUE
RUJIRA_BASE_FEES_RATE_LIMIT_COOLDOWN_SECONDS=$RUJIRA_BASE_FEES_RATE_LIMIT_COOLDOWN_SECONDS_VALUE
RUJIRA_BASE_FEES_DUNE_QUERY_ID=$RUJIRA_BASE_FEES_DUNE_QUERY_ID_VALUE
RUJIRA_BASE_FEES_DUNE_START_TIME=$RUJIRA_BASE_FEES_DUNE_START_TIME_VALUE
RUJIRA_BASE_FEES_DUNE_DAYS_PER_RUN=$RUJIRA_BASE_FEES_DUNE_DAYS_PER_RUN_VALUE
RUJIRA_BASE_FEES_DUNE_HEAD_LAG_HOURS=$RUJIRA_BASE_FEES_DUNE_HEAD_LAG_HOURS_VALUE
RUJIRA_BASE_FEES_DUNE_LIMIT=$RUJIRA_BASE_FEES_DUNE_LIMIT_VALUE
RUJIRA_RESERVE_PAYMENTS_MIDGARD_URLS=$RUJIRA_RESERVE_PAYMENTS_MIDGARD_URLS_VALUE
RUJIRA_RESERVE_PAYMENTS_RPC_URLS=$RUJIRA_RESERVE_PAYMENTS_RPC_URLS_VALUE
RUJIRA_RESERVE_PAYMENTS_START_HEIGHT=$RUJIRA_RESERVE_PAYMENTS_START_HEIGHT_VALUE
RUJIRA_RESERVE_PAYMENTS_SCHEDULE_BLOCKS=$RUJIRA_RESERVE_PAYMENTS_SCHEDULE_BLOCKS_VALUE
RUJIRA_RESERVE_PAYMENTS_HEAD_LAG_BLOCKS=$RUJIRA_RESERVE_PAYMENTS_HEAD_LAG_BLOCKS_VALUE
RUJIRA_RESERVE_PAYMENTS_MIDGARD_MAX_PAGES=$RUJIRA_RESERVE_PAYMENTS_MIDGARD_MAX_PAGES_VALUE
RUJIRA_RESERVE_PAYMENTS_CANDIDATE_MAX_HEIGHTS=$RUJIRA_RESERVE_PAYMENTS_CANDIDATE_MAX_HEIGHTS_VALUE
RUJIRA_RESERVE_PAYMENTS_BLOCK_MAX_HEIGHTS=$RUJIRA_RESERVE_PAYMENTS_BLOCK_MAX_HEIGHTS_VALUE
RUJIRA_RESERVE_PAYMENTS_REQUEST_DELAY_MS=$RUJIRA_RESERVE_PAYMENTS_REQUEST_DELAY_MS_VALUE
RUJIRA_RESERVE_PAYMENTS_RATE_LIMIT_COOLDOWN_SECONDS=$RUJIRA_RESERVE_PAYMENTS_RATE_LIMIT_COOLDOWN_SECONDS_VALUE
RUJIRA_RESERVE_PAYMENTS_DUNE_QUERY_ID=$RUJIRA_RESERVE_PAYMENTS_DUNE_QUERY_ID_VALUE
RUJIRA_RESERVE_PAYMENTS_DUNE_START_TIME=$RUJIRA_RESERVE_PAYMENTS_DUNE_START_TIME_VALUE
RUJIRA_RESERVE_PAYMENTS_DUNE_HEAD_LAG_HOURS=$RUJIRA_RESERVE_PAYMENTS_DUNE_HEAD_LAG_HOURS_VALUE
BOND_TX_EVENTS_DUNE_QUERY_ID=$BOND_TX_EVENTS_DUNE_QUERY_ID_VALUE
BOND_TX_EVENTS_DUNE_START_TIME=$BOND_TX_EVENTS_DUNE_START_TIME_VALUE
BOND_TX_EVENTS_DUNE_LIMIT=$BOND_TX_EVENTS_DUNE_LIMIT_VALUE
DUNE_API_KEY=$DUNE_API_KEY_VALUE
DUNE_API_BASE_URL=$DUNE_API_BASE_URL_VALUE
DUNE_PERFORMANCE=$DUNE_PERFORMANCE_VALUE
DUNE_EXECUTION_POLL_MS=$DUNE_EXECUTION_POLL_MS_VALUE
DUNE_EXECUTION_TIMEOUT_MS=$DUNE_EXECUTION_TIMEOUT_MS_VALUE
CMC_API_KEY=$CMC_API_KEY_FINAL
CMC_GLOBAL_METRICS_HISTORICAL_URL=$CMC_GLOBAL_METRICS_HISTORICAL_URL_FINAL
CMC_GLOBAL_METRICS_INTERVAL=$CMC_GLOBAL_METRICS_INTERVAL_FINAL
TC_FEE_DASH_DUNE_QUERY_ID=$TC_FEE_DASH_DUNE_QUERY_ID_VALUE
NODE_VOTES_DUNE_QUERY_ID=$NODE_VOTES_DUNE_QUERY_ID_VALUE
NODE_VOTES_WS_INGESTION_ENABLED=$NODE_VOTES_WS_INGESTION_ENABLED_VALUE
NODE_VOTES_BACKFILL_LOOKBACK_DAYS=$NODE_VOTES_BACKFILL_LOOKBACK_DAYS_VALUE
TC_FEE_DASH_START_DATE=$TC_FEE_DASH_START_DATE_VALUE
TC_FEE_DASH_END_DATE=$TC_FEE_DASH_END_DATE_VALUE
TC_FEE_DASH_DAYS_PER_RUN=$TC_FEE_DASH_DAYS_PER_RUN_VALUE
TC_FEE_DASH_HEAD_LAG_DAYS=$TC_FEE_DASH_HEAD_LAG_DAYS_VALUE
TC_FEE_DASH_REQUEST_DELAY_MS=$TC_FEE_DASH_REQUEST_DELAY_MS_VALUE
TC_FEE_DASH_RATE_LIMIT_COOLDOWN_SECONDS=$TC_FEE_DASH_RATE_LIMIT_COOLDOWN_SECONDS_VALUE
EOF

echo "    Wrote backend/.env"
REMOTE

echo "==> Installing backend dependencies..."
ssh "$SERVER" "cd $BACKEND_DEST && npm ci --omit=dev"

echo "==> Starting dedicated BooneTools Postgres..."
ssh "$SERVER" "cd $DEST && docker compose -f ops/docker/boonetools-postgres.compose.yml --env-file backend/.env up -d"

echo "==> Waiting for Postgres initialization..."
ssh "$SERVER" "BACKEND_DEST='$BACKEND_DEST' bash -s" <<'REMOTE'
set -euo pipefail
while IFS='=' read -r key value || [[ -n "$key" ]]; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
  export "$key=$value"
done < "$BACKEND_DEST/.env"

until docker exec "$BOONETOOLS_DB_CONTAINER" \
  env PGPASSWORD="$BOONETOOLS_DB_PASSWORD" \
  pg_isready -U "$BOONETOOLS_DB_USER" -d postgres >/dev/null 2>&1; do
  sleep 2
done

until docker exec "$BOONETOOLS_DB_CONTAINER" \
  env PGPASSWORD="$BOONETOOLS_DB_PASSWORD" \
  psql -U "$BOONETOOLS_DB_USER" -d postgres -Atqc "select 1 from pg_database where datname = '$BOONETOOLS_DB_NAME'" | grep -q 1; do
  sleep 2
done
REMOTE

echo "==> Applying database migrations..."
ssh "$SERVER" "chmod +x $DEST/scripts/boonetools-db-migrate.sh $DEST/scripts/boonetools-db-backup.sh $DEST/scripts/boonetools-db-restore.sh && BOONETOOLS_ENV_FILE=$BACKEND_DEST/.env bash $DEST/scripts/boonetools-db-migrate.sh"

echo "==> Installing systemd units..."
rsync -avz "$ROOT/ops/systemd/" "$SERVER:/etc/systemd/system/"
ssh "$SERVER" "systemctl daemon-reload && systemctl enable boonetools-api.service boonetools-analytics-read-models.timer boonetools-node-votes-summary.timer boonetools-rapid-swaps-market-history.timer boonetools-status-dashboard.timer boonetools-treasury-snapshot.timer boonetools-nodeop-scheduler.timer boonetools-rapid-swaps-scheduler.timer boonetools-app-layer-live-state.timer boonetools-rujira-base-fees.timer boonetools-rujira-reserve-payments.timer boonetools-node-votes-backfill.timer boonetools-bond-history-refresh.timer boonetools-tc-fee-dash-backfill.timer boonetools-db-backup.timer boonetools-rujira-reserve-listener.service boonetools-rujira-base-fees-listener.service"

echo "==> Configuring legacy Rapid Swap listener..."
ssh "$SERVER" "BACKEND_DEST='$BACKEND_DEST' bash -s" <<'REMOTE'
set -euo pipefail
while IFS='=' read -r key value || [[ -n "$key" ]]; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
  export "$key=$value"
done < "$BACKEND_DEST/.env"

if [[ "${RAPID_SWAPS_WS_INGESTION_ENABLED:-false}" == "true" || "${NODE_VOTES_WS_INGESTION_ENABLED:-true}" == "true" ]]; then
  systemctl enable rapid-swap-listener.service
else
  systemctl disable --now rapid-swap-listener.service || true
fi
REMOTE

echo "==> Restarting backend API and listeners..."
ssh "$SERVER" "BACKEND_DEST='$BACKEND_DEST' bash -s" <<'REMOTE'
set -euo pipefail
while IFS='=' read -r key value || [[ -n "$key" ]]; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
  export "$key=$value"
done < "$BACKEND_DEST/.env"

systemctl restart boonetools-api.service boonetools-rujira-reserve-listener.service boonetools-rujira-base-fees-listener.service
if [[ "${RAPID_SWAPS_WS_INGESTION_ENABLED:-false}" == "true" || "${NODE_VOTES_WS_INGESTION_ENABLED:-true}" == "true" ]]; then
  systemctl restart rapid-swap-listener.service
else
  systemctl stop rapid-swap-listener.service || true
fi
REMOTE

echo "==> Priming App Layer live-state cache..."
start_remote_unit_with_retry boonetools-app-layer-live-state.service

echo "==> Starting first Rujira base-fee ingestion pass..."
ssh "$SERVER" "systemctl start boonetools-rujira-base-fees.service"

echo "==> Starting first Rujira Reserve payment backfill pass..."
ssh "$SERVER" "systemctl start boonetools-rujira-reserve-payments.service"

echo "==> Priming durable analytics read models..."
ssh "$SERVER" "systemctl start boonetools-analytics-read-models.service"

echo "==> Priming current node-vote summary read model..."
ssh "$SERVER" "systemctl start boonetools-node-votes-summary.service"

echo "==> Priming Rapid Swaps market-history read model..."
ssh "$SERVER" "systemctl start boonetools-rapid-swaps-market-history.service"

echo "==> Priming Treasury read model..."
ssh "$SERVER" "systemctl start boonetools-treasury-snapshot.service"

echo "==> Priming compact Status read model..."
start_remote_unit_with_retry boonetools-status-dashboard.service

echo "==> Validating and reloading Caddy with response compression..."
ssh "$SERVER" "caddy validate --config $DEST/ops/caddy/Caddyfile.boone.tools && install -m 0644 $DEST/ops/caddy/Caddyfile.boone.tools /etc/caddy/Caddyfile && systemctl reload caddy"

echo "==> Verifying public latency, payload, and compression budgets..."
ssh "$SERVER" "node $DEST/scripts/perf-smoke.mjs --base https://boone.tools/functions/v1 --require-compression"
ssh "$SERVER" "node $DEST/scripts/perf-smoke.mjs --base https://boone.tools/functions/v1 --endpoint status --requests 50 --concurrency 50 --require-compression"

echo "==> Starting scheduler and maintenance timers after successful priming and smoke checks..."
ssh "$SERVER" "systemctl restart boonetools-analytics-read-models.timer boonetools-node-votes-summary.timer boonetools-rapid-swaps-market-history.timer boonetools-status-dashboard.timer boonetools-treasury-snapshot.timer boonetools-nodeop-scheduler.timer boonetools-rapid-swaps-scheduler.timer boonetools-app-layer-live-state.timer boonetools-rujira-base-fees.timer boonetools-rujira-reserve-payments.timer boonetools-node-votes-backfill.timer boonetools-bond-history-refresh.timer boonetools-tc-fee-dash-backfill.timer boonetools-db-backup.timer"

echo "Done."
echo "Next steps:"
echo "  1. Review the read-model job histories and performance-smoke output."
echo "  2. Verify the frontend dashboards against the newly primed snapshots."

WRITERS_QUIESCED=false
trap - EXIT
