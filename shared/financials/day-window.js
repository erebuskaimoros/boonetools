const DAY_MS = 86400_000;
const formatters = new Map();

export function financialTimeZone(value = 'UTC') {
  // Intl accepts ISO numeric offsets, while PostgreSQL interprets their signs
  // differently. Calendar caches use named IANA zones (including their aliases).
  if (typeof value !== 'string' || !value || value.length > 100 || /^[+-]/.test(value)) throw new Error('Invalid time zone');
  try { return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw new Error('Invalid time zone'); }
}

export function financialLocalDay(timestamp, timeZone = 'UTC') {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    if (formatters.size >= 64) formatters.clear();
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Find the first instant of the calendar date, including zones whose clock
// advances at midnight. The next date is resolved independently: DST days
// must not be assumed to contain exactly 24 hours.
function midnight(day, timeZone) {
  const nominal = Date.parse(`${day}T00:00:00Z`) / 1000;
  let low = nominal - 36 * 3600, high = nominal + 36 * 3600;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (financialLocalDay(middle * 1000, timeZone) < day) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function financialCalendarWindow(day, now = Date.now(), timeZone = 'UTC') {
  const nominal = Date.parse(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '') || !Number.isFinite(nominal)
    || new Date(nominal).toISOString().slice(0, 10) !== day || day < '2021-04-13') {
    throw new Error('Day must be a valid calendar date from 2021-04-13 through today');
  }
  const zone = financialTimeZone(timeZone);
  const nextDay = new Date(nominal + DAY_MS).toISOString().slice(0, 10);
  const from = zone === 'UTC' ? nominal / 1000 : midnight(day, zone);
  const to = zone === 'UTC' ? from + DAY_MS / 1000 : midnight(nextDay, zone);
  if (from > now / 1000 || to <= from || financialLocalDay(from * 1000, zone) !== day) {
    throw new Error('Day must be a valid calendar date from 2021-04-13 through today');
  }
  return { day, from, to, ...(zone !== 'UTC' && { timeZone: zone }) };
}
