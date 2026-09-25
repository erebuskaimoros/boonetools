// Inclusive UTC-day bounds, never percentages of a changing live dataset.
// These helpers require sorted, unique YYYY-MM-DD rows. Other x-domains should
// get an explicit adapter rather than being coerced into calendar days.
export function utcDayIndices(rows, window = null) {
  if (!rows.length) return { start: 0, end: 0 };
  if (!window) return { start: 0, end: rows.length - 1 };
  const start = rows.findIndex((row) => row.day >= window.startDay);
  const end = rows.findLastIndex((row) => row.day <= window.endDay);
  return start < 0 || end < start
    ? { start: 0, end: rows.length - 1 } : { start, end };
}

export function utcDayWindow(rows, start, end) {
  if (!rows.length || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const first = Math.max(0, Math.min(rows.length - 1, Math.ceil(start)));
  const last = Math.max(first, Math.min(rows.length - 1, Math.floor(end)));
  return first === 0 && last === rows.length - 1
    ? null : { startDay: rows[first].day, endDay: rows[last].day };
}

export function utcDayZoomWindow(rows, zoom) {
  const last = rows.length - 1;
  const index = (value, percent, fallback) => {
    if (typeof value === 'string') {
      const found = rows.findIndex((row) => row.day === value);
      if (found >= 0) return found;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return typeof percent === 'number' && Number.isFinite(percent) ? last * percent / 100 : fallback;
  };
  return utcDayWindow(rows, index(zoom?.startValue, zoom?.start, 0), index(zoom?.endValue, zoom?.end, last));
}

export function zoomUtcDayWindow(rows, window, factor, minPoints = 2) {
  if (!rows.length || !Number.isFinite(factor) || factor <= 0) return window;
  const { start, end } = utcDayIndices(rows, window);
  const count = Math.min(rows.length, Math.max(minPoints, Math.round((end - start + 1) * factor)));
  const first = Math.max(0, Math.min(rows.length - count, Math.round((start + end + 1 - count) / 2)));
  return utcDayWindow(rows, first, first + count - 1);
}
