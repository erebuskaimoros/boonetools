import { calendarDays, dayOf, dayTime, nextDay } from '../../../shared/protocol-fee-comparison/model.js';

export const NEAR_RPC = 'https://archival-rpc.mainnet.fastnear.com';
export const NEAR_TRANSFERS = 'https://transfers.main.fastnear.com/v0/transfers';
export const FEE_WALLETS = ['fefundsadmin.sputnik-dao.near', '1csfundsadmin.sputnik-dao.near', 'buybacks.multisignature.near'];
const tokens = (atomic) => Number(atomic) / 1e24;

/** Index successful incoming NEAR/wNEAR only; no account balance delta or USD proxy. */
export async function nearWalletDays(request, startDay, endDay) {
  const totals = Object.fromEntries(calendarDays(startDay, endDay).map(day => [day, [0n, 0n]]));
  for (const [walletIndex, wallet] of FEE_WALLETS.entries()) {
    let resume, pages = 0;
    const seenTokens = new Set(), seenTransfers = new Set();
    do {
      const result = await request(NEAR_TRANSFERS, { method: 'POST', body: {
        account_id: wallet, direction: 'receiver', from_timestamp_ms: dayTime(startDay),
        to_timestamp_ms: dayTime(endDay), desc: false, limit: 100, ...(resume ? { resume_token: resume } : {})
      } });
      if (!Array.isArray(result?.transfers) || !Object.hasOwn(result, 'resume_token')) throw new Error('Incomplete FastNear transfer response');
      for (const transfer of result.transfers) {
        if (!['native:near', 'nep141:wrap.near'].includes(transfer.asset_id)) continue;
        // Attached contract-call deposits are not TRANSFER actions in the
        // report's accounting boundary (e.g. DAO proposal bonds).
        if (transfer.asset_id === 'native:near' && transfer.transfer_type !== 'NativeTransfer') continue;
        if (transfer.account_id !== wallet || !/^-?\d+$/.test(transfer.amount)
          || !/^\d+$/.test(transfer.block_timestamp) || transfer.receipt_id == null || transfer.transfer_index == null) throw new Error('Malformed FastNear transfer');
        const amount = BigInt(transfer.amount);
        const other = transfer.other_account_id;
        if (amount <= 0n || FEE_WALLETS.includes(other)) continue;
        const timestamp = Number(BigInt(transfer.block_timestamp) / 1000000n);
        if (timestamp < dayTime(startDay) || timestamp >= dayTime(endDay)) throw new Error('FastNear returned an out-of-window transfer');
        const key = `${transfer.receipt_id}:${transfer.transfer_index}:${transfer.asset_id}`;
        if (seenTransfers.has(key)) throw new Error('Duplicate FastNear transfer across pages');
        seenTransfers.add(key);
        totals[dayOf(timestamp)][walletIndex === 0 ? 0 : 1] += amount;
      }
      resume = result.resume_token;
      if (resume && (typeof resume !== 'string' || seenTokens.has(resume))) throw new Error('FastNear pagination did not advance');
      if (resume) seenTokens.add(resume);
      if (++pages > 5000) throw new Error('FastNear pagination safety limit');
    } while (resume);
  }
  return Object.entries(totals).map(([day, [frontend, other]]) => ({ day, frontend_near: tokens(frontend), other_near: tokens(other),
    frontend_atomic: frontend.toString(), other_atomic: other.toString(), source: 'fastnear-transfers-v1' }));
}

/** NEAR's block supply invariant: supply_new = supply_old + epoch_mint - newly included chunk burns. */
export function nearEpochMint(block, previous) {
  const h = block?.header, p = previous?.header;
  if (!h || !p || h.prev_hash !== p.hash || h.prev_height !== p.height || h.epoch_id === p.epoch_id
    || h.latest_protocol_version > 86 || !Array.isArray(block.chunks)) throw new Error('Unverified NEAR epoch boundary or protocol version');
  const burns = block.chunks.filter(chunk => chunk.height_included === h.height)
    .reduce((sum, chunk) => {
      const amount = BigInt(chunk.balance_burnt);
      if (amount < 0n) throw new Error('Negative NEAR chunk burn');
      return sum + amount;
    }, 0n);
  const mint = BigInt(h.total_supply) - BigInt(p.total_supply) + burns;
  if (mint < 0n) throw new Error('Negative NEAR epoch issuance');
  return { height: h.height, hash: h.hash, timestamp: Number(BigInt(h.timestamp_nanosec) / 1000000n),
    previousHash: p.hash, previousHeight: p.height, atomic: mint.toString(), burnedAtomic: burns.toString(), protocolVersion: h.latest_protocol_version };
}

/** Follow consecutive epoch starts, not every block. Persist each verified mint for resumable acquisition. */
export async function collectNearIssuance({ request, epochs = {}, startDay, endDay, save = async () => {}, log = () => {}, maxEpochs = 2000, maxNewEpochs = 100 }) {
  let sequence = 0;
  async function rpc(method, params) {
    const value = await request(NEAR_RPC, { method: 'POST', body: { jsonrpc: '2.0', id: ++sequence, method, params } });
    if (value?.error || !value?.result) throw new Error(`NEAR ${method}: ${value?.error?.cause?.name || value?.error?.message || 'missing archive data'}`);
    return value.result;
  }
  const head = await rpc('block', { finality: 'final' });
  if (Number(BigInt(head.header.timestamp_nanosec) / 1000000n) < dayTime(endDay)) throw new Error('NEAR archive is behind the completed-day cutoff');
  let info = await rpc('validators', [null]), oldest, pendingBlock;
  const visited = [];
  let acquired = 0;
  for (let count = 0; count < maxEpochs; count++) {
    let row = epochs[info.epoch_start_height];
    if (!row) {
      if (acquired >= maxNewEpochs) break;
      const block = pendingBlock?.header.height === info.epoch_start_height ? pendingBlock : await rpc('block', { block_id: info.epoch_start_height });
      const previous = await rpc('block', { block_id: block.header.prev_hash });
      row = nearEpochMint(block, previous);
      if (row.height > head.header.height) throw new Error('NEAR epoch start is not finalized yet');
      // Epoch IDs are the last block hash of the epoch two epochs back.
      // Historical validator-info is pruned even on archive providers; block
      // headers retain this verifiable link to the preceding epoch's start.
      const anchor = await rpc('block', { block_id: block.header.epoch_id });
      let prior;
      for (let skip = 1; skip <= 100; skip++) {
        try { prior = await rpc('block', { block_id: anchor.header.height + skip }); break; }
        catch (error) { if (!/UNKNOWN_BLOCK|unknown block|has never been observed/i.test(error.message)) throw error; }
      }
      if (!prior || row.height !== info.epoch_start_height || prior.header.epoch_id !== previous.header.epoch_id
        || prior.header.prev_hash !== anchor.header.hash || !(prior.header.height < row.height)) throw new Error('NEAR epoch history has a gap');
      pendingBlock = prior;
      row.epochHeight = info.epoch_height;
      row.previousEpochHeight = info.epoch_height - 1;
      row.previousEpochStart = prior.header.height;
      epochs[row.height] = row;
      acquired++;
      await save(epochs);
      if (count % 30 === 0) log(`NEAR on-chain issuance verified through ${dayOf(row.timestamp)} (${count + 1} epochs)`);
    }
    visited.push(row); oldest = row;
    if (row.timestamp < dayTime(startDay)) break;
    info = { epoch_start_height: row.previousEpochStart, epoch_height: row.previousEpochHeight };
  }
  if (!oldest) throw new Error('No NEAR epochs acquired');
  if (oldest.timestamp >= dayTime(startDay)) throw new Error(`NEAR archive backfill has reached ${dayOf(oldest.timestamp)}; earlier epochs remain unverified`);
  // The oldest epoch's day is incomplete until the preceding epoch has been read.
  const from = oldest.timestamp < dayTime(startDay) ? startDay : nextDay(dayOf(oldest.timestamp));
  const days = Object.fromEntries(calendarDays(from, endDay).map(day => [day, 0n]));
  for (const row of visited) { const day = dayOf(row.timestamp); if (Object.hasOwn(days, day)) days[day] += BigInt(row.atomic); }
  return Object.entries(days).map(([day, atomic]) => ({ day, nearIssuance: tokens(atomic), nearIssuanceAtomic: atomic.toString(), nearIssuanceMethod: 'onchain-epoch-mints-v1' }));
}
