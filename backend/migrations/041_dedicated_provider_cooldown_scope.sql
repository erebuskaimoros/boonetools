-- Keep authenticated provider quotas independent from the public gateway's
-- IP-based circuit breaker without persisting endpoint API keys.
begin;

comment on column public.provider_circuit_breakers.provider_key is
  'global:<hostname> for public gateway 429/Retry-After cooldowns; global:<hostname>/api=dedicated for authenticated endpoint cooldowns; service:<hostname><redacted-service-path>[:<scope>] for ordinary upstream failures.';

commit;
