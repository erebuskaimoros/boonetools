import { adrNumber } from './keys.js';
import { getManualVoteKeyReference } from './manual-references.js';

// Reviewed against the mainnet version reported on 2026-11-06. Descriptions are
// editorial summaries of the linked consumers, not inferred from key names.
export const REFERENCE_REVIEW = Object.freeze({
  version: '3.21.1', date: '2026-11-06', commit: '72b7c6348833bb9b933655c265bddcee79699184'
});
const REPO = 'https://gitlab.com/thorchain/thornode';
const source = (file, line, label = 'Implementation on GitLab', commit = REFERENCE_REVIEW.commit) => ({
  label, file, line, commit, url: `${REPO}/-/blob/${commit}/${file}${line ? `#L${line}` : ''}`
});
const impl = (file, line) => source(`x/thorchain/${file}.go`, line);
const haltHeight = 'A positive THORChain block height activates the halt at that height. 0 disables this halt; other halts can still apply.';
const afterHeight = 'A positive THORChain block height activates this control after that height. 0 disables it.';
const bps = 'Basis points: 100 = 1%; 10,000 = 100%.';
const rune = 'RUNE base units: 100,000,000 = 1 RUNE.';
const switchOn = 'Positive values enable it; 0 disables it.';

function mimir(title, summary, values, sources, note = '') {
  return { kind: 'mimir', status: 'reviewed', title, summary, values, sources: [sources].flat(), note };
}

const exact = {
  MAXSWAPSPERBLOCK: mimir('Maximum swap queue budget',
    'Caps the number of swap candidates processed in a queue pass. The advanced queue applies the budget in each rapid-swap iteration, so this is not a cap on the whole block across all iterations.',
    'Number of candidates per queue pass. Missing/negative values use the compiled default.', impl('manager_adv_swap_queue_current', 1086)),
  MINSWAPSPERBLOCK: mimir('Minimum swap queue budget',
    'Sets the lower target for a queue pass: a smaller queue is processed in full; larger queues use half their size, bounded by the minimum and maximum settings.',
    'Number of candidates, subject to MaxSwapsPerBlock. This does not create swaps when the queue is empty.', impl('manager_adv_swap_queue_current', 1086)),
  DISABLETSSSIGNERFILTERING: mimir('Disable TSS signer filtering',
    'Bypasses the eligibility filtering used for keygen and keysign participants. Normally forced-leave nodes are excluded and keysign selection also considers jail status.',
    'Positive activation height: filtering is disabled at and after that THORChain height. 0 keeps filtering enabled.', impl('keysign_eligibility', 21)),
  BONDYIELDENABLED: mimir('Automatic bond yield payouts',
    'Allows providers to configure automatic payouts of a portion of future bond rewards. The reward-distribution path pays configured destinations and leaves the remainder bonded.',
    switchOn, [impl('helpers_bond_yield', 11), impl('manager_validator_current', 813)]),
  MEMOLESSTXNCOST: mimir('Reference memo registration cost',
    'Sets the base cost to register a reference memo. The occupancy slope can raise the actual charge as the asset’s reference slots fill.',
    `${rune} 0 makes registration free.`, impl('handler_reference_memo', 302)),
  MEMOLESSTXNCOSTSLOPEBPS: mimir('Reference memo cost slope',
    'Raises registration cost with occupied slots: base cost × (1 + slope × used/free), where slope is this value divided by 10,000. Occupancy is estimated conservatively and can remain elevated after a burst.',
    '0 keeps the base cost flat. 10,000 makes the cost 2× at half capacity and 10× at 90% capacity.', impl('handler_reference_memo', 302)),
  SYSTEMINCOMEBURNRATEBPS: mimir('System income burn share',
    'Deducts a share of system income for burning before allocating the remaining income to liquidity and bond rewards.', bps,
    impl('manager_network_current', 2566)),
  WASMARBSLIPMINBPS: mimir('WASM arbitrage minimum slip fee',
    'Sets the minimum slip-fee floor for swaps attributed to the configured WASM arbitrage contract. A zero floor still permits the normal size-dependent swap fee.', bps,
    impl('helpers', 528)),
  HALTCHURNING: mimir('Halt validator churn',
    'Stops scheduled validator rotation and the associated churn process when the activation height is reached.', haltHeight,
    impl('manager_validator_current', 55)),
  BONDSLASHBAN: mimir('Bond penalty for a ban vote',
    'Slashes the banned node’s bond by the configured amount, capped at its remaining bond, and transfers it to the Reserve. This is separate from theft-related bond slashing.', rune,
    impl('handler_ban', 119)),
  SIGNATUREREFRESHBLOCKS: mimir('Vault signature keep-alive interval',
    'Sets how stale a vault signature may become before Bifrost initiates a keep-alive self-sign. This is a Bifrost liveness control, not a consensus reward interval.',
    'THORChain blocks. 0 disables keep-alives. Signing halts and node/scanner health still gate execution.',
    source('bifrost/pkg/chainclients/solana/sol_keepalive.go', 170)),
  SOLDURABLENONCE: mimir('Provision Solana durable nonces',
    'Lets Bifrost provision durable-nonce accounts for active Solana vaults. Once a vault’s nonce is committed, that vault uses durable signing regardless of this switch.',
    'Positive = permit new provisioning. 0 stops provisioning; it does not revert already provisioned vaults to recent-blockhash signing.',
    source('constants/mimir_strings.go', 19)),
  POLRESERVESYSTEMINCOMEBPS: mimir('System income allocated to POL',
    'Routes this share of system income into the POL allocation. If Stable Reserve is enabled, its configured share can receive part of this allocation.',
    `${bps} 0 disables the allocation.`, impl('manager_network_current', 2220)),
  POLRESERVEMAXDEPLOYMENT: mimir('POL deployment limit',
    'Caps the RUNE deployed from the POL reserve in a pool deployment during a block. Available reserve funds and pool eligibility can reduce the actual deposit.', rune,
    impl('manager_network_current', 1194)),
  TARGETOUTBOUNDFEESURPLUSRUNE: mimir('Target outbound fee surplus',
    'Sets the target surplus of outbound fees withheld over gas spent. The dynamic outbound fee multiplier moves toward its lower bound as the target is reached.', rune,
    impl('keeper/v1/keeper_outbound_fees', 74)),
  MAXOUTBOUNDATTEMPTS: mimir('Outbound retry limit',
    'Limits how long an undelivered outbound is retried before the recovery path handles it. The limit is evaluated using signing periods and the original transaction’s finalised height.',
    'Number of signing periods/attempts. 0 disables this attempt limit.', impl('manager_slasher_current', 563)),
  PENDULUMASSETSBASISPOINTS: mimir('Incentive Pendulum asset multiplier',
    'Scales the value of assets treated as needing bond security when dividing system income between bonds and pools. Values above 10,000 make the secured asset side larger.', bps,
    impl('manager_network_current', 2589)),
  PENDULUMUSEVAULTASSETS: mimir('Use vault assets in the Pendulum',
    'Uses the security calculation’s vault-asset exposure rather than only assets held in pools. This includes exposure outside ordinary LP balances.',
    'Positive = use vault assets; 0 = use pool assets.', impl('manager_network_current', 2589)),
  STREAMINGLIMITSWAPMAXAGE: mimir('Limit swap maximum age',
    'Expires an unfinished advanced-queue limit swap after its allowed age and finalizes/refunds the remainder through the normal limit-swap completion path.',
    'THORChain blocks. A swap can specify a shorter custom lifetime, bounded by this maximum.', impl('manager_adv_swap_queue_current', 351)),
  PAUSELP: mimir('Pause liquidity actions globally',
    'Pauses LP actions for all chains. Despite the word “Pause”, this is an activation height, not a time when activity resumes.', haltHeight,
    impl('keeper/v1/keeper_halt', 129)),
  HALTTRADING: mimir('Halt trading globally',
    'Stops trading through the global trading guard. Ragnarok and chain-specific guards can independently stop trading.', haltHeight,
    impl('keeper/v1/keeper_halt', 71)),
  HALTCHAINGLOBAL: mimir('Halt chains globally',
    'Activates the global chain-halt guard used by trading and other chain operations. Signing has its own independent halt controls.', haltHeight,
    impl('keeper/v1/keeper_halt', 96)),
  NODEPAUSECHAINGLOBAL: mimir('Temporary global chain pause',
    'Pauses chain operations until a THORChain block height. Unlike HaltChainGlobal, this value is the pause’s end height.',
    'Paused while the current height is less than or equal to this value. The pause expires when the current height exceeds it.', impl('keeper/v1/keeper_halt', 103)),
  HALTSIGNING: mimir('Halt outbound signing globally',
    'Stops Bifrost outbound signing across chains, including internal signing paths such as consolidation and EVM unstuck transactions.', haltHeight,
    source('bifrost/pkg/chainclients/shared/signing/halt.go', 28)),
  HALTWASMGLOBAL: mimir('Halt WASM operations globally',
    'Stops WASM operations guarded by the WASM manager, including contract execution. Per-contract halts can apply separately.', afterHeight,
    impl('manager_wasm_current', 310)),
  HALTSECUREDGLOBAL: mimir('Halt secured assets globally',
    'Stops secured-asset manager operations through the global secured-asset guard. Deposit and withdrawal controls also exist per chain.', haltHeight,
    impl('manager_secured_asset_current', 188)),
  HALTMEMOLESS: mimir('Halt reference memo transactions',
    'Blocks reference-memo registration and execution of transactions using reference memos.',
    'Any positive value halts immediately; 0 allows them subject to the other reference-memo settings.',
    [impl('handler_reference_memo', 87), impl('handler_observed_tx_helpers', 1946)]),
  CHURNINTERVAL: mimir('Validator churn interval',
    'Schedules the next regular validator churn relative to the last churn height. Overdue churns use the separate retry interval.',
    'THORChain blocks between regular churns.', impl('manager_validator_current', 55)),
  NUMBEROFNEWNODESPERCHURN: mimir('New nodes per churn',
    'Targets this many additional ready nodes at churn, on top of replacements for removed nodes. Desired validator count and minimum BFT requirements also constrain selection.',
    'Node count. Missing or non-positive values use 1.', impl('manager_validator_current', 1916)),
  TRADEACCOUNTSENABLED: mimir('Enable trade accounts',
    'Gates trade-account deposits, withdrawals, and swaps using trade assets. Deposits also require TradeAccountsDepositEnabled.', switchOn,
    [impl('handler_trade_account_deposit', 40), impl('handler_trade_account_withdrawal', 42), impl('swap_current', 241)]),
  ADVSWAPQUEUERAPIDSWAPMAX: mimir('Rapid swap iterations per block',
    'Limits advanced-queue processing passes in a block. Iteration stops early when the preceding pass executed no successful swaps.',
    'Iteration count. The per-pass candidate budget is controlled by MinSwapsPerBlock and MaxSwapsPerBlock.', impl('manager_adv_swap_queue_current', 816)),
  ENABLEADVSWAPQUEUE: mimir('Advanced swap queue mode',
    'Selects the advanced queue and controls whether limit swaps may be created and processed.',
    '0 = disabled; 1 = market and limit swaps; 2 = market-only mode, with limit-swap processing skipped.', impl('manager_adv_swap_queue_current', 195)),
  L1DYNAMICFEEENABLED: mimir('Dynamic L1 minimum fees',
    'Enables per-THORName, per-pair fee tracking and adaptive minimum fees for eligible L1 swaps. THORName whitelist state controls whether a name is active or monitored.',
    'Only 1 enables this feature; other values disable it.', impl('manager_dynamic_fee_current', 95)),
  TCYCLAIMINGHALT: mimir('Halt TCY claims',
    'Stops claiming TCY against eligible THORFi claims. TCY trading, staking, and distributions have separate controls.',
    'Positive = claims halted; 0 = claims allowed.', impl('handler_tcy_claim', 48)),
  CONFMULTIPLIERBASISPOINTS: mimir('Unscoped confirmation multiplier',
    'The reviewed UTXO clients read chain-qualified keys such as ConfMultiplierBasisPoints-LTC. This unscoped key is not a global fallback in that lookup.',
    'No effect established for this exact key in the reviewed version.', source('bifrost/pkg/chainclients/shared/utxo/common_mainnet.go', 12))
};
exact.CONFMULTIPLIERBASISPOINTS.status = 'unrecognized';

// These are real historical vote keys. Keep their identity and explain the
// mismatch instead of silently correcting them into a functioning control.
const unrecognized = {
  HALTTRRONTRADING: ['Unrecognized chain spelling', 'The trading guard constructs HaltTRONTrading for TRON. This key contains an extra R.', impl('keeper/v1/keeper_halt', 84)],
  HALTSIGNGING: ['Unrecognized signing key', 'The signer reads HaltSigning. This key contains an extra G.', source('bifrost/pkg/chainclients/shared/signing/halt.go', 33)],
  'CONFMULTIPLERBASSPOINTS-LTC': ['Misspelled confirmation multiplier', 'The UTXO client reads ConfMultiplierBasisPoints-LTC. This key misspells both Multiplier and Basis.', source('bifrost/pkg/chainclients/shared/utxo/common_mainnet.go', 12)],
  'HALTCONTRACT-YEVLEC': ['Unrecognized contract halt key', 'The WASM manager reads HaltWasmContract followed by the contract’s final six characters. This key omits Wasm.', impl('manager_wasm_current', 321)],
  HALTWASMCONTRACT: ['Incomplete contract halt key', 'A contract halt needs a hyphen and the contract address’s final six characters. This bare key is not the global WASM halt.', impl('manager_wasm_current', 321)],
  WASMDEPLOYENABLED: ['Unrecognized WASM deployment key', 'No consumer of WasmDeployEnabled was found in the reviewed release. Deployment permissions are checked through WasmPermissionless and the WASM permission configuration.', impl('manager_wasm_current', 358)],
  ARD26: ['Unrecognized ADR spelling', 'This key begins ARD rather than ADR. It is a separate on-chain key and is not included in the ADR 26 spelling comparison.', source('docs/architecture/adr-026-dynamic-l1-min-fee-per-thorname.md', null, 'ADR 26 on GitLab')],
  'TORANCHOR-BASE-USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA0291': ['Truncated TOR anchor asset', 'The USDC contract suffix in this key is missing its final 3. Anchor lookup uses the pool’s exact asset string, so this does not select the BASE.USDC pool named by the full contract.', impl('keeper/v1/keeper_anchors', 12)]
};

const adrs = {
  23: ['RUNE supply restructure',
    'Burn most of the Reserve’s RUNE, retain a smaller operating buffer, and reduce the maximum supply to 360 million RUNE to simplify the supply structure.',
    'adr-023-rune-supply-restructure.md'],
  24: ['System income to protocol-owned liquidity',
    'Direct a validator-controlled share of system income into permanent protocol-owned pool liquidity, with pool selection controlled by governance or an algorithm.',
    'adr-024-revenue-pol.md', 'ae3cc9cfe86caef0212e699daf2f4a13ee322395',
    'The ADR is linked at its archived GitLab revision; it is absent from the current architecture directory. Implemented POL settings use different names from this proposal.'],
  25: ['Migrate the Dev Fund address',
    'Move Dev Fund custody to a new 2-of-3 multisig and restart its three-year sunset period while retaining the existing system-income allocation.',
    'adr-025-migrate-dev-fund-address.md'],
  26: ['Dynamic L1 minimum fees',
    'Adapt minimum L1 swap fees per THORName and asset pair using on-chain fee-revenue feedback. Validators enroll names in active or monitor mode and set the controller’s bounds.',
    'adr-026-dynamic-l1-min-fee-per-thorname.md'],
  28: ['Exploit conciliation',
    'Reconcile pool and vault accounting after the exploit, allocating losses through Reserve POL, Reserve synths, savers, and Treasury positions while preserving ordinary LP positions and addressing the stuck swap.',
    'adr-028-exploit-conciliation.md'],
  29: ['Bond yield payouts',
    'Let bond providers send a chosen share of future bond rewards to a payout destination at reward distribution. The remainder stays bonded; failed payouts are rebonded.',
    'adr-029-bond-yield-payouts.md'],
  30: ['Delegated node operator permissions',
    'Let node operators delegate selected management actions to other addresses, with optional expiry, while retaining custody of bond funds and exclusive control over operator rotation and delegation.',
    'adr-030-delegated-node-operator-permissions.md'],
  31: ['THORChain and Rujira cooperation',
    'Asks validators to choose between closer cooperation with shared revenue and POL, limited cooperation, or discontinuing the App Layer on THORChain. It also proposes how future exploit losses should be handled.',
    'adr-031-rujira-alignment.md', 'c39c90774a4bccb4b4f648e251b7037810ae0062',
    'Proposal options: 1 = reinforce cooperation; 2 = limited cooperation; 3 = discontinue the App Layer. This document is from the proposal’s GitLab revision.'],
};

const chains = 'BTC|ETH|BSC|BASE|AVAX|LTC|BCH|DOGE|GAIA|TRON|XRP|SOL|ZEC|THOR';
const matchChain = (key, before, after = '') => new RegExp(`^${before}(${chains})${after}$`).exec(key);

function family(key) {
  let match;
  if ((match = matchChain(key, 'HALTSIGNING'))) return mimir(`${match[1]} signing halt`,
    `Stops Bifrost signing for ${match[1]}. The global signing halt can independently stop signing.`, haltHeight,
    source('bifrost/pkg/chainclients/shared/signing/halt.go', 28));
  if ((match = matchChain(key, 'HALT', 'TRADING'))) return mimir(`${match[1]} trading halt`,
    `Stops swaps and guarded liquidity additions involving ${match[1]}. Chain and global trading halts can also apply.`, haltHeight,
    impl('keeper/v1/keeper_halt', 84));
  if ((match = matchChain(key, 'HALT', 'CHAIN'))) return mimir(`${match[1]} chain halt`,
    `Activates the ${match[1]} chain-halt guard used by trading and chain operations. Outbound signing has a separate switch.`, haltHeight,
    impl('keeper/v1/keeper_halt', 109));
  if ((match = matchChain(key, 'SOLVENCYHALT', 'CHAIN'))) return mimir(`${match[1]} solvency halt`,
    `Halts ${match[1]} through the solvency guard. The solvency checker can set or clear this key as it assesses vault balances.`, haltHeight,
    [impl('keeper/v1/keeper_halt', 116), impl('handler_solvency_helpers', 110)]);
  if ((match = matchChain(key, 'STOPSOLVENCYCHECK'))) return mimir(`Disable ${match[1]} solvency checks`,
    `Skips acting on solvency consensus for ${match[1]}. This suppresses the checker; it does not repair a vault deficit or automatically clear an existing halt.`, afterHeight,
    impl('handler_solvency_helpers', 93));
  if ((match = matchChain(key, 'PAUSELP'))) return mimir(`Pause ${match[1]} liquidity actions`,
    `Pauses LP actions on ${match[1]}. The global PauseLP setting can also apply.`, haltHeight, impl('keeper/v1/keeper_halt', 129));
  if ((match = matchChain(key, 'ALLOWNOVAULT-'))) return mimir(`Allow ${match[1]} no-vault recovery`,
    `Authorizes the special noop:novault recovery path to debit recorded vault balances on ${match[1]}. It is a recovery control, not a normal deposit or trading switch.`,
    '1 permits the recovery indefinitely. Another positive value permits it through that THORChain height, inclusive. 0 disables it.', impl('handler_noop', 126));
  if ((match = /^HALT(SECURED|TRADE)(DEPOSIT|WITHDRAW)-([A-Z]+)$/.exec(key)) && new RegExp(`^(${chains})$`).test(match[3])) {
    const secured = match[1] === 'SECURED';
    const deposit = match[2] === 'DEPOSIT';
    const file = secured ? (deposit ? 'handler_secured_asset_deposit' : 'handler_secured_asset_withdraw')
      : (deposit ? 'handler_trade_account_deposit' : 'handler_trade_account_withdrawal');
    return mimir(`Halt ${match[3]} ${secured ? 'secured' : 'trade'} ${deposit ? 'deposits' : 'withdrawals'}`,
      `Blocks ${deposit ? 'deposits into' : 'withdrawals from'} ${secured ? 'secured-asset' : 'trade-asset'} balances for ${match[3]}. Other asset operations have separate controls.`, haltHeight,
      impl(file, secured ? (deposit ? 96 : 43) : (deposit ? 62 : 87)));
  }
  if ((match = /^HALTWASMCONTRACT-([A-Z0-9]{6})$/.exec(key))) return mimir(`Halt WASM contract …${match[1].toLowerCase()}`,
    'Stops WASM operations for contracts whose address ends in this exact six-character suffix. This suffix match does not verify a contract’s identity or existence.', afterHeight,
    impl('manager_wasm_current', 321));
  if ((match = /^PAUSELPDEPOSIT-([A-Z]+-.+)$/.exec(key))) return mimir('Pause deposits into one pool',
    `Blocks new liquidity deposits to the exact asset named by ${match[1]}. The key uses the asset’s Mimir string, with a hyphen between chain and symbol.`,
    'Any positive value pauses deposits immediately; 0 permits them subject to other checks.', impl('keeper/v1/keeper_halt', 147));
  if ((match = /^TORANCHOR-([A-Z]+-.+)$/.exec(key))) return mimir('TOR price anchor pool',
    `Includes the exact pool named by ${match[1]} in the TOR anchor set used for USD pricing. The asset must match a pool; a similarly spelled key does not select it.`,
    'Positive = include the pool as an anchor; 0 = exclude it.', impl('keeper/v1/keeper_anchors', 12));
  if ((match = /^DYNAMICFEE-WHITELIST-([A-Z0-9_-]+)$/.exec(key))) return mimir(`Dynamic fees for ${match[1]}`,
    'Enrolls this registered THORName in per-pair dynamic fee tracking. The master L1DynamicFeeEnabled setting must also be enabled.',
    '1 = active, track and apply adaptive floors; 2 = monitor, track without applying floors; 0/absent = not enrolled. Removal clears its dynamic fee state.',
    impl('manager_dynamic_fee_current', 43));
  if ((match = /^REVSHARE-([A-Z0-9_-]+)$/.exec(key))) return mimir(`Revenue share for ${match[1]}`,
    'Credits the configured share of attributable liquidity fees to this THORName’s affiliate collector. The name must have a valid owner; its preferred-asset payout settings apply.', bps,
    impl('manager_network_current', 2428));
  if ((match = /^OVERSOLVENCYTOTREASURYBPS-([A-Z]+-.+)$/.exec(key))) return mimir('Asset oversolvency Treasury share',
    `Overrides the portion of excess vault assets routed toward the Treasury recovery flow for ${match[1]}.`,
    `${bps} Clamped to 0–10,000; missing/negative uses the global OverSolvencyToTreasuryBps setting.`, impl('manager_network_current', 3512));
  if ((match = matchChain(key, 'CONFMULTIPLIERBASISPOINTS-'))) return mimir(`${match[1]} confirmation multiplier`,
    `Scales the value-based confirmation requirement used by the UTXO client for ${match[1]}.`,
    `${bps} Missing or non-positive values use 10,000 (1×).`, source('bifrost/pkg/chainclients/shared/utxo/common_mainnet.go', 12));
  if ((match = matchChain(key, 'MAXCONFIRMATIONS-'))) return mimir(`${match[1]} confirmation cap`,
    `Caps the confirmation requirement for ${match[1]}. This limits the calculated waiting requirement rather than the number of blocks the chain can produce.`,
    'Positive number of external-chain confirmations; 0 leaves the calculated requirement uncapped.', source('bifrost/pkg/chainclients/shared/utxo/common_mainnet.go', 21));
  if ((match = /^ENABLESWITCH-([A-Z]+)-([A-Z0-9]+)$/.exec(key))) return mimir(`Enable ${match[1]}.${match[2]} switching`,
    'Permits the switch handler’s burn-and-mint conversion for this exact asset. Other switch-handler validation still applies.', afterHeight,
    impl('handler_switch', 91));
  if (/^COMPROMISEDVAULT-THORPUB1[A-Z0-9]+$/.test(key)) return mimir('Compromised vault flag',
    'Marks the exact vault public key as compromised across its chains. The vault is excluded from deposit-address selection and guarded inbound processing avoids crediting compromised deposits.',
    'Any positive value flags the vault; 0 clears this flag.', impl('handler_observed_tx_helpers', 209));
  if (/^SOLVENCYHALTVAULT-THORPUB1[A-Z0-9]+-[A-Z]+$/.test(key)) return mimir('Per-vault solvency flag',
    'Records insolvency for the specified vault and chain. Any remaining chain flag keeps the vault out of inbound-address selection; a solvent observation can clear its chain’s flag.',
    'Positive = flagged (the checker records the detection height); 0 = cleared.', impl('handler_solvency_helpers', 201));
  if (/^UPGRADE-\d+\.\d+\.\d+$/.test(key)) return {
    kind: 'upgrade', status: 'reviewed', title: `Software upgrade ${key.slice(8)}`,
    summary: 'Validator approval of the named software-upgrade proposal and its scheduled height. This is an upgrade proposal vote, not a numeric Mimir setting.',
    values: 'The tracker shows proposal approvals separately from numeric Mimir votes.', sources: [impl('handler_upgrade', 18)], note: ''
  };
  return null;
}

export function getVoteKeyReference(rawKey) {
  const key = String(rawKey ?? '').trim().toUpperCase();
  const manual = getManualVoteKeyReference(key);
  if (manual) return manual;
  const number = adrNumber(key);
  if (number != null && adrs[number]) {
    const [title, summary, file, commit, note = 'ADR votes signal a governance decision; the document does not establish whether every proposed change is deployed.'] = adrs[number];
    return { key, kind: 'adr', status: 'reviewed', number, title: `ADR ${number}: ${title}`, summary,
      values: '', note, sources: [source(`docs/architecture/${file}`, null, 'Official ADR on GitLab', commit)], review: REFERENCE_REVIEW };
  }
  if (unrecognized[key]) {
    const [title, summary, reference] = unrecognized[key];
    return { key, kind: 'mimir', status: 'unrecognized', title, summary,
      values: 'No effect established for this exact key in the reviewed version.',
      note: 'Votes on this key remain separate. The related source is linked to explain the mismatch, not to imply that this key controls it.',
      sources: [{ ...reference, label: 'Related source on GitLab' }], review: REFERENCE_REVIEW };
  }
  const entry = exact[key] || family(key);
  if (entry) return { ...entry, key, review: REFERENCE_REVIEW };
  return { key, kind: number != null ? 'adr' : 'mimir', status: 'unknown',
    title: number != null ? `ADR ${number}: description not yet reviewed` : 'Description not yet reviewed',
    summary: 'This exact key is not covered by the reviewed catalog. Its presence in vote history does not by itself establish a protocol effect.',
    values: '', note: 'No meaning has been inferred from similarly spelled keys.', sources: [], review: REFERENCE_REVIEW };
}

// Central catalog entries are plain text and immutable source links. Old
// servers and malformed/new schemas fall back to the bundled reviewed copy.
export function resolveVoteKeyReference(rawKey, catalog = {}) {
  const fallback = getVoteKeyReference(rawKey);
  // Only the bundled allowlist grants manual precedence. Stale central entries
  // and later generated text cannot reassign a colliding document number.
  if (fallback.maintenance === 'manual') return fallback;
  const entry = Object.hasOwn(catalog || {}, fallback.key) ? catalog[fallback.key] : null;
  if (!entry || entry.key !== fallback.key || !['reviewed', 'generated', 'unrecognized'].includes(entry.status)
    || !['mimir', 'adr', 'upgrade'].includes(entry.kind)
    || !['title', 'summary', 'values', 'note'].every(field => typeof entry[field] === 'string')
    || !entry.review || typeof entry.review.date !== 'string' || typeof entry.review.version !== 'string'
    || !Array.isArray(entry.sources) || !entry.sources.length
    || !entry.sources.every(link => typeof link.label === 'string' &&
      /^https:\/\/gitlab\.com\/thorchain\/thornode\/-\/blob\/[a-f0-9]{40}\/[a-zA-Z0-9_./-]+(?:#L\d+)?$/.test(link.url))) return fallback;
  const { maintenance, nonbinding, provenance, ...validated } = entry;
  return validated;
}
