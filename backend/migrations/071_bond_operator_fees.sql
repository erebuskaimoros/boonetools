-- NULL means the churn payout has not yet been verified, not zero earnings.
alter table bond_history add column if not exists operator_fee bigint
  check (operator_fee >= 0);
comment on column bond_history.operator_fee is
  'RUNE base units paid to this operator at churn, from paired bond_reward/bond_returned events. Excluded from rune_stack.';
