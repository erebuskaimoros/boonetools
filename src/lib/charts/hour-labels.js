import { formatLocalDate, formatLocalTime, localDateKey, localTimeZone } from '../utils/datetime.js';

// Plan ticks before formatting: renderers may request labels out of order.
// Keep the original timestamp as identity, including repeated DST clock hours.
export function localHourLabels(rows, { start = 0, end = rows.length - 1, step = 1, timeZone = localTimeZone() } = {}) {
  const wallTimes = rows.map(row => `${localDateKey(row.day, timeZone)} ${formatLocalTime(row.day, {
    timeZone, second: undefined, timeZoneName: undefined
  })}`);
  const counts = new Map();
  for (const wallTime of wallTimes) counts.set(wallTime, (counts.get(wallTime) || 0) + 1);
  const labels = new Map();
  let previousDate;
  for (let index = start; index <= end && rows[index]; index += Math.max(1, step)) {
    const row = rows[index], date = localDateKey(row.day, timeZone);
    const dateLabel = date !== previousDate ? formatLocalDate(row.day, { timeZone, year: undefined }) : '';
    const clock = formatLocalTime(row.day, { timeZone, second: undefined,
      timeZoneName: counts.get(wallTimes[index]) > 1 ? 'short' : undefined });
    labels.set(row.day, `${dateLabel}\n${clock}${row.partial ? '*' : ''}`);
    previousDate = date;
  }
  return labels;
}
