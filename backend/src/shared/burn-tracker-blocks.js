function tryDecode(value) {
  const raw = String(value ?? '');
  if (!raw) return '';
  try {
    if (/^[A-Za-z0-9+/]+=*$/.test(raw) && raw.length > 1) {
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      if (/^[\x20-\x7E]*$/.test(decoded) && decoded.length > 0) return decoded;
    }
  } catch {
    // Tendermint versions may already provide decoded attributes.
  }
  return raw;
}

function integer(value) {
  const normalized = String(value ?? '').trim();
  return /^\d+$/.test(normalized) ? BigInt(normalized) : null;
}

export function parseSystemIncomeBurnEvents(events = []) {
  let observed = false;
  let total = 0n;
  for (const event of Array.isArray(events) ? events : []) {
    if (tryDecode(event?.type).toLowerCase() !== 'rewards') continue;
    for (const attribute of Array.isArray(event?.attributes) ? event.attributes : []) {
      if (tryDecode(attribute?.key).toLowerCase() !== 'income_burn') continue;
      const amount = integer(tryDecode(attribute?.value));
      if (amount === null) continue;
      observed = true;
      total += amount;
    }
  }
  return observed ? total.toString() : null;
}
