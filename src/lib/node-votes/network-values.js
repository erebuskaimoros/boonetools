const CONSTANT_TYPE_LABELS = Object.freeze({
  int_64_values: 'INT64',
  bool_values: 'BOOL',
  string_values: 'STRING'
});

function entries(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value)
    : [];
}

function sortByKey(rows) {
  return rows.sort((left, right) => left.key.localeCompare(right.key));
}

export function networkValueText(value) {
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function buildNetworkValueRows(networkValues = {}) {
  const mimirs = networkValues.mimirs || {};
  const constants = networkValues.constants || {};
  const mimirByUpperKey = new Map(
    entries(mimirs).map(([key, value]) => [key.toUpperCase(), value])
  );
  const mimirRows = sortByKey(entries(mimirs).map(([key, value]) => ({
    key,
    value,
    active_value: value,
    source: 'mimir',
    type: 'mimir',
    type_label: 'MIMIR',
    overridden: false
  })));
  const constantRows = [];

  for (const [type, values] of entries(constants)) {
    for (const [key, value] of entries(values)) {
      const activeValue = mimirByUpperKey.get(key.toUpperCase());
      constantRows.push({
        key,
        value,
        active_value: activeValue,
        source: 'constant',
        type,
        type_label: CONSTANT_TYPE_LABELS[type] || type.replace(/_values$/, '').toUpperCase(),
        overridden: activeValue !== undefined
      });
    }
  }

  return [...mimirRows, ...sortByKey(constantRows)];
}

export function filterNetworkValueRows(rows, searchTerm = '') {
  const query = String(searchTerm).trim().toLowerCase();
  if (!query) return rows;

  return rows.filter((row) => (
    row.key.toLowerCase().includes(query)
    || networkValueText(row.value).toLowerCase().includes(query)
    || (row.active_value !== undefined && networkValueText(row.active_value).toLowerCase().includes(query))
    || row.source.includes(query)
    || row.type_label.toLowerCase().includes(query)
    || (row.overridden && 'overridden'.includes(query))
  ));
}
