import { parseChainHeaderFromNewBlock } from './chain-headers.js';
import { parseRujiraBaseFeeBlock } from './rujira-base-fees.js';
import { parseRujiraReservePaymentBlock } from './rujira-reserve-payments.js';
import { parseSystemIncomeBurnEvents } from './burn-tracker-blocks.js';
import { parseSystemIncomePolBlock } from './system-income-pol-blocks.js';

export function normalizeNewBlockForRujiraBaseFees(data = {}, blockHeight = 0) {
  const finalize = data?.result_finalize_block || data?.result_end_block || {};
  return {
    result: {
      height: String(Number(blockHeight || data?.block?.header?.height) || 0),
      txs_results: Array.isArray(finalize.tx_results)
        ? finalize.tx_results
        : Array.isArray(finalize.txs_results)
          ? finalize.txs_results
          : [],
      finalize_block_events: Array.isArray(finalize.events) ? finalize.events : []
    }
  };
}

export function parseConsolidatedChainBlock(input = {}) {
  const data = input.data || input;
  const header = parseChainHeaderFromNewBlock(data);
  if (!header) return null;
  const baseFeePayload = normalizeNewBlockForRujiraBaseFees(data, header.height);
  const systemIncomePol = parseSystemIncomePolBlock(data);
  return {
    header,
    data,
    events: baseFeePayload.result.finalize_block_events,
    incomeBurnE8: parseSystemIncomeBurnEvents(baseFeePayload.result.finalize_block_events),
    systemIncomePol,
    reservePayments: parseRujiraReservePaymentBlock(header.height, data, {
      blockTime: header.blockTime,
      source: 'liquify-ws'
    }),
    baseFees: parseRujiraBaseFeeBlock(header.height, baseFeePayload, {
      blockTime: header.blockTime
    }),
    baseFeePayload
  };
}
