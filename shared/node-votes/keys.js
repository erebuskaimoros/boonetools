// ADR aliases share documentation, never on-chain vote records.
export function adrNumber(key) {
  const match = /^ADR-?0*([1-9]\d{0,3})$/i.exec(String(key ?? '').trim());
  return match ? Number(match[1]) : null;
}
