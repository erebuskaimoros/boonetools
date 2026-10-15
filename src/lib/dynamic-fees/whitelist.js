const STATES = {
  active: { label: 'Whitelisted', color: '#00cc66' },
  monitor: { label: 'Monitor only', color: '#5588cc' },
  removed: { label: 'Removed from whitelist', color: '#d4a017' }
};

// Consume effective history, never raw votes or the current Mimir value. Older
// vote-tracker history is reconstructed; preserve that uncertainty in the UI.
export function normalizeWhitelistHistory(payload, thorname) {
  const key = `DYNAMICFEE-WHITELIST-${String(thorname).trim().toUpperCase()}`;
  if (String(payload?.mimir_key || '').toUpperCase() !== key) return [];
  const rows = (Array.isArray(payload.effective_history) ? payload.effective_history : [])
    .flatMap(row => {
      const raw = String(row.effective_value ?? '').trim();
      const value = raw === '' ? NaN : Number(raw);
      const timestamp = Date.parse(row.block_time) / 1000;
      const height = Number(row.height);
      if (!Number.isFinite(value) || !Number.isFinite(timestamp) || timestamp <= 0 || !Number.isInteger(height) || height <= 0) return [];
      const kind = value === 1 ? 'active' : value === 2 ? 'monitor' : value <= 0 ? 'removed' : null;
      if (!kind) return [];
      const confirmed = ['validator_consensus', 'protocol_direct', 'protocol_safety'].includes(row.change_source)
        && !row.inferred_from_current_node_mimirs;
      const time = new Date(timestamp * 1000).toISOString();
      return [{ ...STATES[kind], kind, value, timestamp, height, time, date: time.slice(0, 10),
        txId: /^[a-f0-9]{64}$/i.test(row.tx_id || '') ? row.tx_id : '',
        estimated: !confirmed,
        source: confirmed ? (row.source_label || 'Protocol event') : 'Reconstructed consensus',
        id: `${height}:${kind}` }];
    }).sort((a, b) => a.height - b.height || a.timestamp - b.timestamp);

  // The vote tracker can contain both a reconstructed threshold crossing and
  // the actual set_mimir event. Prefer the latter within a same-state run.
  const transitions = [];
  for (const row of rows) {
    const previous = transitions.at(-1);
    if (previous?.kind !== row.kind) transitions.push(row);
    else if (previous.estimated && !row.estimated) transitions[transitions.length - 1] = row;
  }
  return transitions;
}

// Category bars occupy index +/- 0.5. Position at the actual time inside a
// displayed bucket, including partial W/M buckets. Missing days stay missing.
export function positionWhitelistMarkers(events, points) {
  if (!points.length) return [];
  const from = Number(points[0].startTime), to = Number(points.at(-1).endTime);
  return events.filter(event => event.timestamp >= from && event.timestamp < to).flatMap(event => {
    const index = points.findIndex(point => event.timestamp >= Number(point.startTime) && event.timestamp < Number(point.endTime));
    if (index >= 0) {
      const point = points[index];
      const fraction = (event.timestamp - Number(point.startTime)) / (Number(point.endTime) - Number(point.startTime));
      return [{ ...event, bucketIndex: index, xValue: index - 0.5 + fraction }];
    }
    const next = points.findIndex(point => Number(point.startTime) > event.timestamp);
    return next > 0 ? [{ ...event, bucketIndex: null, xValue: next - 0.5 }] : [];
  });
}

export function whitelistEventText(event) {
  return `${event.label} · ${event.time.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}${event.estimated ? ' · consensus estimate' : ''}`;
}

// Feature-local Chart.js overlay: no datasets, values, axes or accounting are
// modified. Reading the current x scale keeps lines correct during zoom/reset.
export function createWhitelistMarkerPlugin(getMarkers) {
  return {
    id: 'affiliateWhitelistMarkers',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea: area, scales } = chart;
      if (!area || !scales.x) return;
      const lanes = [[], [], []];
      ctx.save();
      ctx.beginPath();
      ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
      ctx.clip();
      ctx.font = '600 11px "JetBrains Mono", monospace';
      ctx.textBaseline = 'top';
      for (const marker of getMarkers()) {
        const x = scales.x.getPixelForValue(marker.xValue);
        if (!Number.isFinite(x) || x < area.left || x > area.right) continue;
        ctx.strokeStyle = marker.color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash(marker.estimated ? [3, 4] : [7, 4]);
        ctx.beginPath();
        ctx.moveTo(x, area.top);
        ctx.lineTo(x, area.bottom);
        ctx.stroke();
        const label = `${marker.label.toUpperCase()} · ${marker.date.slice(5)}${marker.estimated ? ' *' : ''}`;
        const width = ctx.measureText(label).width + 8;
        if (width > area.right - area.left - 4) continue;
        const left = Math.max(area.left + 2, Math.min(x + 5, area.right - width - 2));
        const lane = lanes.findIndex(boxes => boxes.every(box => left > box[1] + 4 || left + width < box[0] - 4));
        if (lane < 0) continue; // All events remain available as accessible text.
        lanes[lane].push([left, left + width]);
        const top = area.top + 5 + lane * 20;
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(left, top, width, 17);
        ctx.fillStyle = marker.color;
        ctx.fillText(label, left + 4, top + 2);
      }
      ctx.restore();
    }
  };
}
