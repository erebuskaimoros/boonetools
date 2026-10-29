import { localDateKey, localTimeZone } from '../utils/datetime.js';
import { financialCalendarWindow } from '../../../shared/financials/day-window.js';

export function financialDetailPicker({ now = Date.now(), timeZone = localTimeZone() } = {}) {
  return { min: '2021-04-13', max: localDateKey(now, timeZone) };
}

// A chart click supplies a calendar label, not a midnight instant to convert.
// Details may cover a local date absent from the chart's UTC daily labels.
export function selectFinancialDetailDay(day, { now = Date.now(), timeZone = localTimeZone() } = {}) {
  try { return financialCalendarWindow(day, now, timeZone).day; }
  catch { return ''; }
}
