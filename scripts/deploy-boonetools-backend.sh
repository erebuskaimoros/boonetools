#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="${SERVER:-root@178.156.211.181}"
DEST="${DEST:-/opt/boonetools-backend}"
BACKEND_DEST="$DEST/backend"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ROOT/.env"
  set +a
fi

PUBLIC_API_KEY_VALUE="${PUBLIC_API_KEY:-${VITE_NODEOP_API_KEY:-${VITE_RAPID_SWAPS_API_KEY:-}}}"
THORNODE_PRIMARY_VALUE="${THORNODE_PRIMARY_URL:-https://thornode.thorchain.network}"
THORNODE_FALLBACK_VALUE="${THORNODE_FALLBACK_URL:-https://thornode.thorchain.liquify.com}"
MIDGARD_URL_VALUE="${MIDGARD_URL:-https://midgard.thorchain.network/v2}"
MIDGARD_FALLBACK_VALUE="${MIDGARD_FALLBACK_URL:-https://midgard.liquify.com/v2}"

echo "==> Preparing remote directories..."
ssh "$SERVER" "mkdir -p $BACKEND_DEST $DEST/scripts $DEST/src/lib/rapid-swaps $DEST/src/lib/utils $DEST/ops/caddy $DEST/ops/docker $DEST/ops/systemd"

echo "==> Syncing backend, shared modules, and ops assets..."
rsync -avz --delete --exclude '.env' --exclude 'node_modules' "$ROOT/backend/" "$SERVER:$BACKEND_DEST/"
rsync -avz "$ROOT/scripts/boonetools-db-migrate.sh" "$SERVER:$DEST/scripts/"
rsync -avz "$ROOT/scripts/boonetools-db-backup.sh" "$SERVER:$DEST/scripts/"
rsync -avz "$ROOT/scripts/boonetools-db-restore.sh" "$SERVER:$DEST/scripts/"
rsync -avz "$ROOT/scripts/rapid-swap-listener.mjs" "$SERVER:$DEST/scripts/"
rsync -avz "$ROOT/src/lib/rapid-swaps/" "$SERVER:$DEST/src/lib/rapid-swaps/"
rsync -avz "$ROOT/src/lib/utils/blockchain.js" "$SERVER:$DEST/src/lib/utils/"
rsync -avz "$ROOT/ops/caddy/" "$SERVER:$DEST/ops/caddy/"
rsync -avz "$ROOT/ops/docker/" "$SERVER:$DEST/ops/docker/"
rsync -avz "$ROOT/ops/systemd/" "$SERVER:$DEST/ops/systemd/"

echo "==> Ensuring backend env file exists..."
ssh "$SERVER" "PUBLIC_API_KEY_VALUE='$PUBLIC_API_KEY_VALUE' THORNODE_PRIMARY_VALUE='$THORNODE_PRIMARY_VALUE' THORNODE_FALLBACK_VALUE='$THORNODE_FALLBACK_VALUE' MIDGARD_URL_VALUE='$MIDGARD_URL_VALUE' MIDGARD_FALLBACK_VALUE='$MIDGARD_FALLBACK_VALUE' bash -s" <<'REMOTE'
set -euo pipefail
DEST="${DEST:-/opt/boonetools-backend}"
BACKEND_DEST="$DEST/backend"
ENV_FILE="$BACKEND_DEST/.env"

if [[ -f "$ENV_FILE" ]]; then
  echo "    backend/.env exists"
  exit 0
fi

DB_PASSWORD="$(openssl rand -hex 24)"
API_KEY="${PUBLIC_API_KEY_VALUE:-$(openssl rand -hex 24)}"

cat > "$ENV_FILE" <<EOF
PORT=8787
BOONETOOLS_DB_CONTAINER=boonetools-postgres
BOONETOOLS_DB_NAME=boonetools
BOONETOOLS_DB_USER=boonetools
BOONETOOLS_DB_PASSWORD=$DB_PASSWORD
DATABASE_URL=postgresql://boonetools:$DB_PASSWORD@127.0.0.1:5433/boonetools
PUBLIC_API_KEY=$API_KEY
THORNODE_PRIMARY_URL=${THORNODE_PRIMARY_VALUE}
THORNODE_FALLBACK_URL=${THORNODE_FALLBACK_VALUE}
MIDGARD_URL=${MIDGARD_URL_VALUE}
MIDGARD_FALLBACK_URL=${MIDGARD_FALLBACK_VALUE}
RPC_WS_URL=wss://rpc.thorchain.network/websocket
MIDGARD_DELAY_MS=5000
RAPID_SWAPS_MAX_PAGES=200
RAPID_SWAPS_CATCHUP_MAX_PAGES=200
RAPID_SWAPS_HEIGHT_OVERLAP_BLOCKS=1800
RAPID_SWAPS_MAX_CANDIDATE_ATTEMPTS=12
RAPID_SWAPS_PENDING_CANDIDATE_BATCH=100
EOF

echo "    Created backend/.env"
REMOTE

echo "==> Installing backend dependencies..."
ssh "$SERVER" "cd $BACKEND_DEST && npm ci --omit=dev"

echo "==> Starting dedicated BooneTools Postgres..."
ssh "$SERVER" "cd $DEST && docker compose -f ops/docker/boonetools-postgres.compose.yml --env-file backend/.env up -d"

echo "==> Waiting for Postgres initialization..."
ssh "$SERVER" "BACKEND_DEST='$BACKEND_DEST' bash -s" <<'REMOTE'
set -euo pipefail
set -a
source "$BACKEND_DEST/.env"
set +a

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
ssh "$SERVER" "systemctl daemon-reload && systemctl enable boonetools-api.service boonetools-nodeop-scheduler.timer boonetools-rapid-swaps-scheduler.timer boonetools-db-backup.timer rapid-swap-listener.service"

echo "==> Restarting backend services and timers..."
ssh "$SERVER" "systemctl restart boonetools-api.service rapid-swap-listener.service && systemctl restart boonetools-nodeop-scheduler.timer boonetools-rapid-swaps-scheduler.timer boonetools-db-backup.timer"

echo "Done."
echo "Next steps:"
echo "  1. Import Supabase data into the local DB."
echo "  2. Diff old vs new endpoints."
echo "  3. Install the Caddy config from ops/caddy/Caddyfile.boone.tools and reload Caddy."
