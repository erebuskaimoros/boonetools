-- Store per-churn exchange rates for multi-currency support
-- JSON keys are USD prices of each asset at that churn time
-- e.g. {"EUR": 0.92, "BTC": 67000, "XMR": 165, "ZEC": 28, "XAU": 2340, "SPY": 583, "VT": 107}
-- Frontend uses these for historical currency conversion; null triggers on-demand fetch
ALTER TABLE bond_history ADD COLUMN rates_json JSONB;
