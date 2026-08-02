-- Document optional workload sub-lanes for ordinary provider failures.
begin;

comment on column public.provider_circuit_breakers.provider_key is
  'global:<hostname> for confirmed gateway 429/Retry-After cooldowns; service:<hostname><service-path>[:<scope>] for ordinary upstream failures. market-snapshots is shared by canonical pool/oracle acquisition.';

commit;
