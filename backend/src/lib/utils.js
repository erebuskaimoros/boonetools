export function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function safeString(value) {
  return String(value || '').trim();
}

export function chunkArray(items, chunkSize = 250) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  if (items.length <= chunkSize) {
    return [items];
  }

  const output = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    output.push(items.slice(index, index + chunkSize));
  }
  return output;
}

function formatUtcIso(value) {
  return value.toISOString().replace('Z', '+00:00');
}

export function toIsoString(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? formatUtcIso(value) : null;
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? formatUtcIso(new Date(parsed)) : value;
  }

  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? formatUtcIso(new Date(parsed)) : null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
