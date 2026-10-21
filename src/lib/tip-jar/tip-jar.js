/**
 * "Buy me a coffee?": a plain RUNE send to boonew's tip jar from the visitor's
 * connected wallet. Kept free of wallet code so the footer can import it.
 */

export const TIP_JAR_ADDRESS = 'thor194zytw9em6950gym75psq5qt6f2mt2le2nnnt8';

/** Dollar presets offered in the send modal; the first is prefilled. */
export const TIP_PRESETS_USD = [3, 5, 10];

/** THORChain's native transaction fee, used until /thorchain/network answers. */
export const DEFAULT_NATIVE_FEE_RUNE = 0.02;

/** RUNE for a dollar amount, rounded up to 2 decimals so the tip is never short. */
export function runeForUsd(usd, runePriceUsd) {
  if (!(usd > 0) || !(runePriceUsd > 0)) return '';
  return (Math.ceil((usd / runePriceUsd) * 100) / 100).toFixed(2);
}

/** Why an amount can't be sent yet ('' when it can). A null balance means it isn't known. */
export function tipAmountProblem(amount, { balanceRune = null, feeRune = DEFAULT_NATIVE_FEE_RUNE } = {}) {
  const text = String(amount ?? '').trim();
  if (!text) return 'Enter an amount of RUNE.';
  if (!/^\d+(\.\d{1,8})?$/.test(text) || Number(text) <= 0) return 'Enter a positive RUNE amount with up to 8 decimals.';
  if (balanceRune != null && Number(text) + feeRune > balanceRune) {
    return `This wallet holds ${balanceRune} RUNE, which doesn't cover the amount plus the ${feeRune} RUNE network fee.`;
  }
  return '';
}
