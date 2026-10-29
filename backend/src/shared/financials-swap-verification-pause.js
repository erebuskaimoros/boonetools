/** Verifier-wide admission state, shared by Financials and pool rankings. It
 * applies to newly captured candidates too, without changing their checks. */
export async function readFinancialSwapVerificationPause(client, now) {
  const { rows: [ledger] } = await client.query(`select verification_deferred_until,
    verification_deferred_reason from financials_swap_ledger`);
  const retryAt = ledger?.verification_deferred_until && new Date(ledger.verification_deferred_until).getTime();
  return retryAt > now ? { deferred: true, deferredReason: ledger.verification_deferred_reason,
    nextCheckAt: new Date(retryAt).toISOString() } : null;
}

export async function deferFinancialSwapVerification(client, error, txId, now) {
  const explicit = Date.parse(error.retryAt || error.blockedUntil || '');
  const seconds = Math.max(0, Number(error.retryAfterSeconds) || 0);
  const retryAt = new Date(Math.max(now + (explicit > now || seconds ? 1000 : 60_000),
    Number.isFinite(explicit) ? explicit : 0, now + seconds * 1000)).toISOString();
  const reason = error.code === 'MIDGARD_BUDGET_DEFERRED' ? 'request-budget' : 'provider-cooldown';
  // Persist only fixed reason codes, never provider messages or credentials.
  await client.query(`with pause as (
      update financials_swap_ledger set verification_deferred_reason = case
          when verification_deferred_until > $1::timestamptz then verification_deferred_reason else $2 end,
        verification_deferred_until = greatest(verification_deferred_until, $1::timestamptz)
      returning verification_deferred_until
    ) update financials_swap_candidates set next_check_at = greatest(next_check_at,
      (select verification_deferred_until from pause)) where tx_id = $3`, [retryAt, reason, txId]);
}

export async function clearFinancialSwapVerificationPause(client, now) {
  await client.query(`update financials_swap_ledger set verification_deferred_until = null,
    verification_deferred_reason = null where verification_deferred_until <= $1::timestamptz`,
  [new Date(now).toISOString()]);
}

export function financialSwapVerificationSchedule(due, pause, now) {
  if (!due.length) return { nextCheckAt: null };
  return { ...(pause || {}), nextCheckAt: new Date(Math.max(now, Math.min(...due),
    pause ? Date.parse(pause.nextCheckAt) : 0)).toISOString() };
}
