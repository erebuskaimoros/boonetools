import { chunkArray } from '../lib/utils.js';

function quoteIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

function normalizeValue(value, column, options = {}) {
  if (value === undefined) {
    return null;
  }

  const jsonColumns = Array.isArray(options.jsonColumns) ? options.jsonColumns : [];
  if (jsonColumns.includes(column) && value !== null) {
    return JSON.stringify(value);
  }

  return value;
}

export async function insertRows(client, table, rows, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return;
  }

  const chunkSize = Number(options.chunkSize) || 250;
  for (const chunk of chunkArray(rows, chunkSize)) {
    await insertRowChunk(client, table, chunk, options);
  }
}

function insertRowChunk(client, table, rows, options = {}) {
  const columns = options.columns || Object.keys(rows[0] || {});
  if (columns.length === 0) {
    return;
  }

  const values = [];
  const tuples = rows.map((row) => {
    const placeholders = columns.map((column) => {
      values.push(normalizeValue(row[column], column, options));
      return `$${values.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });

  const quotedColumns = columns.map(quoteIdentifier).join(', ');
  const sql = `insert into ${quoteIdentifier(table)} (${quotedColumns}) values ${tuples.join(', ')}`;
  return client.query(sql, values);
}

export async function upsertRows(client, table, rows, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return;
  }

  const chunkSize = Number(options.chunkSize) || 250;
  for (const chunk of chunkArray(rows, chunkSize)) {
    await upsertRowChunk(client, table, chunk, options);
  }
}

function upsertRowChunk(client, table, rows, options = {}) {
  const columns = options.columns || Object.keys(rows[0] || {});
  if (columns.length === 0) {
    return;
  }

  const conflictColumns = Array.isArray(options.conflictColumns) ? options.conflictColumns : [];
  const updateColumns = Array.isArray(options.updateColumns)
    ? options.updateColumns
    : columns.filter((column) => !conflictColumns.includes(column));

  const values = [];
  const tuples = rows.map((row) => {
    const placeholders = columns.map((column) => {
      values.push(normalizeValue(row[column], column, options));
      return `$${values.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });

  const quotedColumns = columns.map(quoteIdentifier).join(', ');
  const conflictSql = conflictColumns.length > 0
    ? ` on conflict (${conflictColumns.map(quoteIdentifier).join(', ')}) `
    : '';
  const updateSql = conflictColumns.length > 0
    ? (
        updateColumns.length > 0
          ? `do update set ${updateColumns.map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`).join(', ')}`
          : 'do nothing'
      )
    : '';

  const sql = `insert into ${quoteIdentifier(table)} (${quotedColumns}) values ${tuples.join(', ')}${conflictSql}${updateSql}`;
  return client.query(sql, values);
}
