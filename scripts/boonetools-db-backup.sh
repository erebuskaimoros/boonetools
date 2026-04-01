#!/usr/bin/env bash
set -euo pipefail

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
BACKUP_DIR="${BOONETOOLS_DB_BACKUP_DIR:-/var/backups/boonetools-postgres}"
: "${BOONETOOLS_DB_PASSWORD:?BOONETOOLS_DB_PASSWORD is required}"

mkdir -p "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="$BACKUP_DIR/boonetools-$timestamp.dump"

docker exec "$CONTAINER" \
  env PGPASSWORD="$BOONETOOLS_DB_PASSWORD" \
  pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$backup_file"

mapfile -t backups < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'boonetools-*.dump' | sort -r)
if (( ${#backups[@]} > 14 )); then
  printf '%s\0' "${backups[@]:14}" | xargs -0 rm -f --
fi

echo "Backup written to $backup_file"
