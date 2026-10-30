import { localDateKey, localTimeZone } from '../utils/datetime.js';
import { financialCalendarWindow } from '../../../shared/financials/day-window.js';

export function financialDetailPicker({ now = Date.now(), timeZone = localTimeZone() } = {}) {
  return { min: '2021-04-13', max: localDateKey(now, timeZone) };
}

// Historical chart clicks retain their calendar label. The current UTC bucket
// opens local today, even while the chart and visitor have different dates.
export function selectFinancialDetailDay(day, { now = Date.now(), timeZone = localTimeZone(), source = 'picker' } = {}) {
  try {
    if (source === 'chart') {
      const chartDay = financialCalendarWindow(day, now, 'UTC').day;
      if (chartDay === localDateKey(now, 'UTC')) day = localDateKey(now, timeZone);
    }
    return financialCalendarWindow(day, now, timeZone).day;
  }
  catch { return ''; }
}
