-- Bond history: cached per-churn bond snapshots for the bond tracker chart
CREATE TABLE bond_history (
  bond_address TEXT NOT NULL,
  churn_height BIGINT NOT NULL,
  churn_timestamp BIGINT NOT NULL,       -- unix seconds
  rune_stack BIGINT NOT NULL DEFAULT 0,  -- total user bond + pending reward, base units (1e8)
  rune_price DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bond_address, churn_height)
);

CREATE INDEX idx_bond_history_address ON bond_history (bond_address, churn_height DESC);

-- Allow public read, edge function writes with service role
ALTER TABLE bond_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read" ON bond_history
  FOR SELECT USING (true);

CREATE POLICY "Service role write" ON bond_history
  FOR ALL USING (true) WITH CHECK (true);
