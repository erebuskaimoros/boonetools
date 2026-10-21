/** Display formatters shared by the Position Tracker panels. */

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

export function fmtAmount(value, digits = 2) {
  const numeric = Number(value) || 0;
  if (numeric !== 0 && Math.abs(numeric) < 0.01) {
    return numeric.toLocaleString('en-US', { maximumSignificantDigits: 3 });
  }
  return numeric.toLocaleString('en-US', { maximumFractionDigits: digits });
}

export function fmtCompact(value) {
  return compact.format(Number(value) || 0);
}

export function fmtPct(value, digits = 2) {
  const numeric = Number(value) || 0;
  return `${numeric.toFixed(digits)}%`;
}

export function signed(text, value) {
  return Number(value) > 0 ? `+${text}` : text;
}

export function shortAddr(address, head = 6, tail = 4) {
  const value = String(address || '');
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

export function poolTicker(pool) {
  const [chain, symbol = ''] = String(pool || '').split('.');
  const ticker = symbol.split('-')[0];
  return ticker === chain ? ticker : `${chain}.${ticker}`;
}

export function fmtDate(seconds) {
  if (!seconds) return '--';
  return new Date(seconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function txUrl(hash) {
  return `https://thorchain.net/tx/${String(hash || '').replace(/^0x/i, '')}`;
}

export function addressUrl(address) {
  return `https://thorchain.net/address/${address}`;
}

export function nodeUrl(address) {
  return `https://thorchain.net/node/${address}`;
}
