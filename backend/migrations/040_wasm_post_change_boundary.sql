-- Align Wasm ingestion storage and work queues with the post-Mimir-zero
-- monitoring contract. The retired before/after report remains a static
-- artifact and does not require production ingestion before activation.
begin;

delete from public.wasm_arb_economics_blocks
where height < 27181679;

delete from public.wasm_arb_economics_rujira_fees
where height < 27181679;

delete from public.wasm_arb_economics_actions
where height < 27181679;

delete from public.wasm_arb_economics_oracle_samples
where height < 27181679;

delete from public.wasm_arb_economics_network_buckets
where bucket_start < '2026-07-27T14:04:45Z'::timestamptz;

-- tx_search pagination is relative to the requested height interval. Its old
-- page cursor cannot be reused after moving the lower bound forward.
delete from public.wasm_arb_economics_sync_state
where sync_key = 'collector-tx-search-backfill';

delete from public.api_read_models
where model_key in (
  'wasm-arb-economics:v1',
  'wasm-arb-economics:v2',
  'wasm-arb-economics:v3'
);

commit;
