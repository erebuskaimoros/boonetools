import { DAY_SECONDS, FINANCIALS_RANGES, buildFinancialsPoints, buildLiveFinancialsPoint, financialsWindow, utcDay } from '../../../shared/financials/model.js';

export const FINANCIALS_MODEL_TTL_MS = 120_000;
export const financialsModelKey = (range) => `financials:${range}:v1`;

// A stopped collector must not leave yesterday's partial totals labeled Today
// or allow those amounts into the completed-day averages after midnight.
export function ageFinancialsPayload(payload, now = Date.now()) {
  const window = financialsWindow(payload.range, now);
  const today = utcDay(window.to);
  if (payload.throughDay === today) return payload;
  const range = FINANCIALS_RANGES.find((item) => item.id === payload.range);
  const existing = new Map(payload.points.filter((point) => !point.partial).map((point) => [point.day, point]));
  const points = buildFinancialsPoints({ from: window.from + (range.days ? DAY_SECONDS : 0), to: window.to })
    .map((point) => existing.get(point.day) || point);
  points.push(buildLiveFinancialsPoint({ from: window.to }));
  return { ...payload, throughDay: today, points, stale: true,
    live: { ...payload.live, day: today, through: null, stale: true, bondPending: false,
      error: 'The collector has not published today’s snapshot yet' },
    bonding: { ...payload.bonding, pending: 0, days: points.filter((point) => point.bondingApr !== null).length }
  };
}
