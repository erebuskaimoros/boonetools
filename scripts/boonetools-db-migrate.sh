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
  applied="$(run_psql -Atqc "select 1 from public.boonetools_schema_migrations where filename = '$filename'")"

  if [[ "$applied" == "1" ]]; then
    echo "Skipping already-applied migration: $filename"
    continue
  fi

  echo "Applying migration: $filename"
  run_psql < "$file"
  run_psql -c "insert into public.boonetools_schema_migrations (filename) values ('$filename') on conflict do nothing"
done
