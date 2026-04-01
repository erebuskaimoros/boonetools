#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /path/to/boonetools-backup.dump" >&2
  exit 1
fi

BACKUP_FILE="$1"
if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${BOONETOOLS_ENV_FILE:-$ROOT/backend/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

CONTAINER="${BOONETOOLS_DB_CONTAINER:-boonetools-postgres}"
DB_NAME="${BOONETOOLS_DB_NAME:-boonetools}"
DB_USER="${BOONETOOLS_DB_USER:-boonetools}"
: "${BOONETOOLS_DB_PASSWORD:?BOONETOOLS_DB_PASSWORD is required}"

docker exec "$CONTAINER" env PGPASSWORD="$BOONETOOLS_DB_PASSWORD" dropdb -U "$DB_USER" --if-exists "$DB_NAME"
docker exec "$CONTAINER" env PGPASSWORD="$BOONETOOLS_DB_PASSWORD" createdb -U "$DB_USER" "$DB_NAME"
docker exec -i "$CONTAINER" \
  env PGPASSWORD="$BOONETOOLS_DB_PASSWORD" \
  pg_restore -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges < "$BACKUP_FILE"

echo "Restore completed from $BACKUP_FILE"
