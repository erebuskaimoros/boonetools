-- Add user_bond column to distinguish bond from pending reward
-- user_bond = just the provider's bond (p.bond), without pending reward
-- pending_reward = rune_stack - user_bond
ALTER TABLE bond_history ADD COLUMN user_bond BIGINT;
