// Presentation only. Keep API timestamps, UTC bucket keys and aggregation in
// their source calendar; convert instants only when rendering them to a user.
const formatters = new Map();

export function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function instant(value) {
  // A date-only reporting bucket is not an instant at local midnight.
  if (value === null || value === undefined || value === '' || /^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatter(options) {
  const resolved = { ...options, timeZone: options.timeZone || localTimeZone() };
  const key = JSON.stringify(resolved);
  if (!formatters.has(key)) {
    if (formatters.size >= 64) formatters.clear();
    formatters.set(key, new Intl.DateTimeFormat('en-US', resolved));
  }
  return formatters.get(key);
}

export function formatLocalDateTime(value, options = {}) {
  const date = instant(value);
  return date ? formatter({ year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    timeZoneName: 'short', ...options }).format(date) : '—';
}

export function formatLocalTime(value, options = {}) {
  const date = instant(value);
  return date ? formatter({ hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'short', ...options }).format(date) : '—';
}

export function formatLocalDate(value, options = {}) {
  const date = instant(value);
  return date ? formatter({ year: 'numeric', month: 'short', day: 'numeric', ...options }).format(date) : '—';
}

export function localDateKey(value, timeZone = localTimeZone()) {
  const date = instant(value);
  if (!date) return '';
  const parts = Object.fromEntries(formatter({ timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatLocalHour(value, options = {}) {
  return formatLocalDateTime(value, { year: undefined, second: undefined, timeZoneName: undefined, ...options });
}
