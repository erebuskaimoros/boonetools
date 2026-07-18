import { chunkArray } from '../lib/utils.js';

function quoteIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sourceRankSql(expression, priorities = {}) {
  const entries = Object.entries(priorities).filter(([source, rank]) => (
    /^[a-z0-9_-]+$/.test(source) && Number.isFinite(Number(rank))
  ));
  const cases = entries.map(([source, rank]) => (
    `when ${quoteLiteral(source)} then ${Math.trunc(Number(rank))}`
  ));
  return `(case lower(coalesce(${expression}, 'unknown')) ${cases.join(' ')} else 10 end)`;
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
  const tableSql = quoteIdentifier(table);
  const strategies = options.updateStrategies || {};
  const sourcePreference = options.sourcePreference || null;
  const sourceColumn = sourcePreference?.column;
  const observedAtColumn = sourcePreference?.observedAtColumn;
  const existingSource = sourceColumn ? `${tableSql}.${quoteIdentifier(sourceColumn)}` : '';
  const incomingSource = sourceColumn ? `excluded.${quoteIdentifier(sourceColumn)}` : '';
  const existingRank = sourceColumn
    ? sourceRankSql(existingSource, sourcePreference.priorities)
    : '';
  const incomingRank = sourceColumn
    ? sourceRankSql(incomingSource, sourcePreference.priorities)
    : '';
  const incomingWins = sourceColumn
    ? (
        observedAtColumn
          ? `(${incomingRank} > ${existingRank} or (${incomingRank} = ${existingRank} and excluded.${quoteIdentifier(observedAtColumn)} >= ${tableSql}.${quoteIdentifier(observedAtColumn)}))`
          : `${incomingRank} >= ${existingRank}`
      )
    : '';

  const updateAssignment = (column) => {
    const columnSql = quoteIdentifier(column);
    const existing = `${tableSql}.${columnSql}`;
    const incoming = `excluded.${columnSql}`;
    if (strategies[column] === 'greatest') {
      return `${columnSql} = greatest(${existing}, ${incoming})`;
    }
    if (strategies[column] === 'least') {
      return `${columnSql} = least(${existing}, ${incoming})`;
    }
    if (sourceColumn && column === sourceColumn) {
      return `${columnSql} = case when ${incomingWins} then ${incoming} else ${existing} end`;
    }
    if (sourceColumn) {
      return `${columnSql} = case when ${incomingWins} then ${incoming} else ${existing} end`;
    }
    return `${columnSql} = ${incoming}`;
  };

  const updateSql = conflictColumns.length > 0
    ? (
        updateColumns.length > 0
          ? `do update set ${updateColumns.map(updateAssignment).join(', ')}`
          : 'do nothing'
      )
    : '';

  const sql = `insert into ${tableSql} (${quotedColumns}) values ${tuples.join(', ')}${conflictSql}${updateSql}`;
  return client.query(sql, values);
}
