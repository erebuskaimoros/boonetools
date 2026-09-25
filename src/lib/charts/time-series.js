import { TERMINAL_CHART_PALETTE as palette } from './terminal.js';
import { utcDayIndices } from './viewport.js';
import { analyzeTimeSeries } from './analytics.js';

export const TIME_SERIES_FONT = "'JetBrains Mono', monospace";
export const TIME_SERIES_ZOOM_ID = 'time-series-window';

export const escapeTooltipText = (text) => String(text)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

// Strings are detail rows; metric rows carry the same trusted local palette as
// their series. All labels, values and metadata are escaped, never raw HTML.
export function timeSeriesTooltip(lines) {
  return lines.map((line) => {
    if (typeof line === 'string') return escapeTooltipText(line);
    const { id, color, fill = color, text } = line;
    return `<span aria-hidden="true" data-series="${escapeTooltipText(id)}" style="display:inline-block;width:12px;height:12px;box-sizing:border-box;vertical-align:middle;margin-right:6px;border-radius:0;border:1px solid ${escapeTooltipText(color)};background-color:${escapeTooltipText(fill)}"></span> ${escapeTooltipText(text)}`;
  }).join('<br>');
}

export function utcDayLabel(day) {
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC' })
    : day;
}

/**
 * Calendar-bucket overview / interactive mixed and composition profiles. Adapters supply computed
 * values, explicit axes/series, formatters and tooltip details. No acquisition,
 * aggregation, currency conversion, interpolation or baseline rebasing here.
 */
export function buildTimeSeriesOption(rows, {
  axes, series, tooltip, hidden = [], window = null, width = 1000,
  zoomId = TIME_SERIES_ZOOM_ID, minSpan = 1, xLabel = utcDayLabel,
  zoom = true, compact = false, tooltipEnabled = true, sourceGrain = 'day', calendar = 'UTC', analysis = null
}) {
  const spec = { rows, axes, series, sourceGrain, calendar };
  if (analysis) {
    const view = analyzeTimeSeries(rows, analysis.baseSpec || spec, analysis);
    const originalTooltip = tooltip;
    rows = view.rows; axes = view.axes; series = view.series; hidden = view.hiddenAxes;
    if (view.grouped) xLabel = day => utcDayLabel(day);
    tooltip = (row) => {
      const index = rows.indexOf(row);
      const averages = view.visible.filter(item => /-\d+d$/.test(item.id));
      if (!view.grouped) return originalTooltip(row) + (averages.length ? '<br>' + timeSeriesTooltip(averages.map(item => ({
        ...item, text: `${item.label}: ${formatAnalysisValue(item, index)}${row.partial || row.provisional ? ' · PARTIAL' : ''}`
      }))) : '');
      return timeSeriesTooltip([
        `${row.fromDay} → ${row.throughDay} · ${calendar} ${view.grain.toUpperCase()}${row.partial ? ' · PARTIAL BUCKET' : ''}`,
        ...view.visible.filter(item => item.legend !== false && !item.visibilityId).map(item => ({
          ...item, text: `${item.label}: ${formatAnalysisValue(item, index)}`
        })),
        'Flows: sum · balances/cumulative: closing observation · rates: feature-weighted or labeled mean.',
        ...(averages.length ? ['Rolling overlays remain daily means; missing windows are unavailable.'] : [])
      ]);
    };
    function formatAnalysisValue(item, index) {
      const raw = item.data[index];
      const value = typeof raw === 'object' ? raw?.value : raw;
      return value == null ? 'unavailable' : axes.find(axis => axis.id === item.axis)?.format?.(value) ?? String(value);
    }
    if (window && view.grouped) {
      const first = rows.find(row => row.endDay >= window.startDay);
      const last = rows.findLast(row => row.day <= window.endDay);
      if (first && last) window = { startDay: first.day, endDay: last.day };
    }
  }
  const wide = width >= 600 && !compact;
  const fontFamily = TIME_SERIES_FONT;
  const { start, end } = utcDayIndices(rows, zoom ? window : null);
  const visibleAxes = (position) => axes.filter((axis) => (axis.position || 'right') === position && !hidden.includes(axis.id));
  const rightAxes = visibleAxes('right');
  const axisSpacing = wide ? 86 : 62;
  const right = rightAxes.length ? rightAxes.length * axisSpacing + (wide ? 14 : 8) : 12;
  const yAxis = axes.map((axis) => ({
    id: axis.id, type: 'value', show: !hidden.includes(axis.id),
    position: axis.position || 'right',
    offset: Math.max(0, visibleAxes(axis.position || 'right').findIndex((item) => item.id === axis.id)) * axisSpacing,
    name: wide ? axis.label : '', nameLocation: 'middle', nameGap: wide ? 61 : 0,
    nameTextStyle: { color: axis.color, fontFamily, fontSize: 11 },
    ...(axis.baseline === 'auto'
      ? { scale: true, boundaryGap: ['3%', '3%'] }
      : { min: axis.baseline === 'signed' ? ({ min }) => Math.min(0, min * 1.05) : 0,
          max: ({ max }) => max > 0 ? max * 1.05 : 1 }),
    ...(Number.isFinite(axis.min) ? { min: axis.min } : {}),
    ...(Number.isFinite(axis.max) ? { max: axis.max } : {}),
    ...(axis.integer ? { minInterval: 1 } : {}),
    splitNumber: 5,
    axisLine: { show: true, lineStyle: { color: axis.color } },
    axisTick: { show: false },
    splitLine: { show: axis.position === 'left', lineStyle: { color: palette.grid } },
    axisLabel: { color: axis.color, fontFamily, fontSize: 11, hideOverlap: true, formatter: axis.format }
  }));

  return {
    _spec: spec, _rows: rows,
    animation: false, backgroundColor: 'transparent', textStyle: { fontFamily },
    grid: { left: visibleAxes('left').length ? wide ? 88 : 64 : 12, right, top: zoom ? 32 : 16, bottom: 30 },
    tooltip: {
      show: tooltipEnabled,
      trigger: 'axis', renderMode: 'html', confine: true,
      backgroundColor: palette.surface, borderColor: palette.borderStrong, borderWidth: 1,
      padding: 12, textStyle: { color: palette.text, fontFamily, fontSize: 12, lineHeight: 18 },
      extraCssText: 'border-radius:0;box-shadow:none;max-width:100%;white-space:normal;overflow-wrap:anywhere;',
      axisPointer: { type: 'line', lineStyle: { color: palette.muted, type: 'dashed', width: 1 } },
      formatter: (items) => {
        const first = Array.isArray(items) ? items[0] : items;
        const row = rows.find((point) => point.day === first?.axisValue) ?? rows[first?.dataIndex];
        return row ? tooltip(row) : '';
      }
    },
    toolbox: {
      show: zoom,
      right, top: 0, itemSize: 13, itemGap: 12,
      iconStyle: { borderColor: palette.muted },
      emphasis: { iconStyle: { borderColor: palette.info }, textStyle: { fontFamily, fontSize: 12 } },
      feature: zoom ? { dataZoom: {
        xAxisIndex: 0, yAxisIndex: 'none',
        title: { zoom: 'Drag to zoom', back: 'Undo zoom' },
        brushStyle: { color: 'rgba(85,136,204,0.12)', borderColor: palette.info, borderWidth: 1 }
      } } : {}
    },
    dataZoom: zoom ? [{
      id: zoomId, type: 'inside', xAxisIndex: 0,
      startValue: start, endValue: end, rangeMode: ['value', 'value'],
      minValueSpan: Math.min(minSpan, Math.max(0, rows.length - 1)),
      filterMode: 'filter', zoomOnMouseWheel: false, moveOnMouseWheel: false,
      moveOnMouseMove: false, preventDefaultMouseMove: false, throttle: 0
    }] : [],
    xAxis: {
      type: 'category', data: rows.map((row) => row.day), boundaryGap: true,
      axisLine: { lineStyle: { color: palette.border } }, axisTick: { show: false },
      axisLabel: {
        color: palette.muted, fontFamily, fontSize: 11, hideOverlap: true,
        interval: Math.max(0, Math.ceil((end - start + 1) / (wide ? 9 : 4)) - 1),
        formatter: xLabel
      }
    },
    yAxis,
    series: series.map((item) => ({
      id: item.id, name: item.label, type: item.mark,
      ...(item.stack ? { stack: item.stack } : {}),
      yAxisIndex: axes.findIndex((axis) => axis.id === item.axis),
      data: hidden.includes(item.visibilityId || item.id) ? [] : item.data,
      z: item.order ?? (item.mark === 'line' ? 3 : 2), emphasis: { disabled: true },
      ...(item.mark === 'bar' ? {
        ...(item.barMaxWidth == null ? {} : { barMaxWidth: item.barMaxWidth }),
        itemStyle: { color: item.fill || item.color, borderColor: item.color, borderWidth: 1, borderRadius: 0 }
      } : {
        connectNulls: false, smooth: item.smooth || false,
        symbol: 'circle', showSymbol: Boolean(item.symbolSize) || item.data.filter(value => value != null).length === 1, symbolSize: item.symbolSize || 4,
        itemStyle: { color: item.color },
        ...(item.areaFill ? { areaStyle: { color: item.areaFill, opacity: 1 } } : {}),
        lineStyle: { color: item.color, width: item.lineWidth ?? 2, type: item.lineType || (item.dashed ? 'dashed' : 'solid') }
      }),
      // Status labels annotate gaps/known zeros without inventing bar values.
      markPoint: { silent: true, symbolSize: 0, data: (hidden.includes(item.visibilityId || item.id) ? [] : item.markers || []).map((marker) => ({
        coord: [marker.day, marker.value], value: marker.text,
        label: { show: true, formatter: '{c}', offset: [0, -8], color: marker.color || item.color, fontFamily, fontSize: 12 }
      })) }
    }))
  };
}
