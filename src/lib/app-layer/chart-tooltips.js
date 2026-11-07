const usd2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2
});

export function buildAccruedValueTooltipDetails(row) {
  return [
    `TC-retained 01 + 03: ${Number.isFinite(row.accrued_value_usd) ? usd2.format(row.accrued_value_usd) : row.unpriced_events ? 'Unpriced' : 'Unavailable'}`
  ];
}

export function buildPolAccrualTooltipDetails(row, grain) {
  const lines = [];
  if (grain === 'weekly') {
    lines.push(`Post-cutover gross in this week: ${usd2.format(row.post_cutover_gross_usd || 0)}`);
  }
  lines.push(
    `Allocation: ${row.bucket_start >= '2026-08-13' || row.post_cutover_gross_usd ? '1/3 of post-cutover accrual' : 'pre-cutover · no POL'}`
  );
  return lines;
}
