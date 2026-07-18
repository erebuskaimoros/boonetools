#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${BOONETOOLS_ENV_FILE:-$ROOT/backend/.env}"

if [[ -f "$ENV_FILE" ]]; then
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    export "$key=$value"
  done < "$ENV_FILE"
fi

CONTAINER="${BOONETOOLS_DB_CONTAINER:-boonetools-postgres}"
DB_NAME="${BOONETOOLS_DB_NAME:-boonetools}"
DB_USER="${BOONETOOLS_DB_USER:-boonetools}"
: "${BOONETOOLS_DB_PASSWORD:?BOONETOOLS_DB_PASSWORD is required}"

# Serialize the whole runner at the host level so two deploys cannot both
# observe an unapplied filename and start the same migration.
MIGRATION_LOCK_FILE="${BOONETOOLS_DB_MIGRATION_LOCK_FILE:-/var/lock/boonetools-db-migrate.lock}"
mkdir -p "$(dirname "$MIGRATION_LOCK_FILE")"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$MIGRATION_LOCK_FILE"
  if ! flock -n 9; then
    echo "Another BooneTools database migration run is already active." >&2
    exit 1
  fi
else
  MIGRATION_LOCK_DIR="${MIGRATION_LOCK_FILE}.d"
  if ! mkdir "$MIGRATION_LOCK_DIR" 2>/dev/null; then
    echo "Another BooneTools database migration run is already active." >&2
    exit 1
  fi
  trap 'rmdir "$MIGRATION_LOCK_DIR"' EXIT
fi

run_psql() {
  docker exec -i "$CONTAINER" \
    env PGPASSWORD="$BOONETOOLS_DB_PASSWORD" \
    psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"
}

run_psql <<'SQL'
create table if not exists public.boonetools_schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);
SQL

for file in "$ROOT"/backend/migrations/*.sql; do
  filename="$(basename "$file")"
  [[ "$filename" =~ ^[A-Za-z0-9_.-]+$ ]] || {
    echo "Unsafe migration filename: $filename" >&2
    exit 1
  }
  applied="$(run_psql -Atqc "select 1 from public.boonetools_schema_migrations where filename = '$filename'")"

  if [[ "$applied" == "1" ]]; then
    echo "Skipping already-applied migration: $filename"
    continue
  fi

  echo "Applying migration: $filename"
  # Migration files historically own their BEGIN/COMMIT wrapper. Strip only
  # those standalone wrapper lines and add the applied marker in the same
  # transaction, so a crash cannot commit the schema without recording it.
  {
    printf 'begin;\n'
    awk 'tolower($0) !~ /^[[:space:]]*(begin|commit);[[:space:]]*$/' "$file"
    printf "insert into public.boonetools_schema_migrations (filename) values ('%s') on conflict do nothing;\n" "$filename"
    printf 'commit;\n'
  } | run_psql
done
