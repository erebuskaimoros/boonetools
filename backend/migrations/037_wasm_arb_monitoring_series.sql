-- Replace the intervention-comparison payload with the bounded post-Mimir-zero
-- monitoring contract. The source accounting tables remain unchanged.

delete from api_read_models
where model_key in (
  'wasm-arb-economics:v1',
  'wasm-arb-economics:v2',
  'wasm-arb-economics:v3'
);
