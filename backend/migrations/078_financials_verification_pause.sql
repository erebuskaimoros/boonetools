-- A bounded verifier can be paused before any HTTP request is made. Keep the
-- actual shared retry horizon separate from candidate checks and completion.
alter table financials_swap_ledger
  add column verification_deferred_until timestamptz,
  add column verification_deferred_reason text
    check (verification_deferred_reason in ('request-budget', 'provider-cooldown'));
