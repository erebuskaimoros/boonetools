begin;

-- WBTC has its own actively traded Binance spot market. Existing BTCUSDT
-- observations cannot be relabeled, so invalidate that leg and let the
-- reference-aware repair job reconstruct it from WBTCUSDT history.
update public.pool_dislocation_observations
set binance_symbol = 'WBTCUSDT',
    binance_bid_usd = null,
    binance_ask_usd = null,
    binance_price_usd = null,
    binance_observed_at = null,
    binance_price_method = null,
    source_skew_ms = null,
    updated_at = now()
where asset = 'ETH.WBTC-0X2260FAC5E5542A773AA44FBCFEDF7C193BC2C599';

-- These pool assets have no directly traded Binance spot market. Remove the
-- underlying-asset references instead of presenting them as executable books.
update public.pool_dislocation_observations
set binance_symbol = null,
    binance_bid_usd = null,
    binance_ask_usd = null,
    binance_price_usd = null,
    binance_observed_at = null,
    binance_price_method = null,
    source_skew_ms = null,
    updated_at = now()
where asset in (
  'AVAX.SOL-0XFE6B19286885A4F7F55ADAD09C3CD1F906D2478F',
  'BSC.BTCB-0X7130D2A12B9BCBFAE4F2634D864A1EE1CE3EAD9C',
  'BSC.ETH-0X2170ED0880AC9A755FD29B2688956BD959F933F8',
  'BSC.USDC-0X8AC76A51CC950D9822D68B83FE1AD97B32CD580D'
);

-- Do not serve a pre-migration summary while the scheduler rebuilds it.
delete from public.api_read_models
where model_key = 'pool-dislocation-summary:v1';

commit;
