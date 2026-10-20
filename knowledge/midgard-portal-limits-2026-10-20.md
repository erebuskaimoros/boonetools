# Free Liquify Portal Midgard burst limits

## Scope and evidence

The user confirmed that the Free plan is intentional and the active Portal
key is Midgard-only. No subscription, endpoint credential, RPC route or frontend
change is part of this adjustment.

The October 19 23:49 UTC Pool Analysis sweep made 32 successful pool-history
requests out of 44. Its other 12 were rejected locally with `total-minute`,
not an upstream 429. Their prior 23:30 snapshots remained intact; the scheduler
published its successful work and did not retry at the 23:50 quota reset.
This produced a partially stale dashboard until a later scheduled sweep.

The configured key's durable counters at 23:56 UTC were 633/2,000 for the hour
and 12,147/20,000 for the UTC day, including 4,439 bulk requests. The production
key had been activated at 05:52 UTC. Its approximately 18-hour first-day total
is not a stable monthly forecast: live collectors, recovery and visitor-driven
scans contribute different amounts.

The authenticated Portal's **Your Current Limits** showed Free plan, one
endpoint, 10 requests/s, 100,000 requests/day and 300,000 requests/month. Its
account summary included historical RPC method traffic; the sole current
endpoint was Midgard. Account-wide usage and current-key counters are therefore
not interchangeable. The [public pricing page](https://www.liquify.com/portal)
advertised a different Free daily allowance (50,000), so the account's stated
limits, not marketing defaults or paid-plan assumptions, informed this change.

## Chosen safety caps

| Scope | Overall | Bulk subset |
| --- | ---: | ---: |
| Portal minute | 180 | 60 |
| Hour, unchanged | 2,000 | 1,000 |
| UTC day, unchanged | 20,000 | 5,000 |

Portal requests additionally share a 200ms admission interval across processes:
at most five admissions per second. This leaves margin below the Free 10/s
ceiling and smooths simultaneous scheduled sweeps. A 44-pool refresh plus the
observed 28 competing requests fits inside the new minute allowance.

The bulk subset is included in the overall counters, not added to them. It
cannot consume the capacity reserved for other reads. Public endpoints retain
60/minute overall and 30/minute bulk. Only a configured HTTPS
`gateway.liquify.com/api=<key>` Midgard base selects the Portal profile; an
arbitrary URL, an unconfigured credential or a dedicated RPC URL cannot opt in.

Long-window Portal defaults inherit existing operator settings. Optional
Portal-specific overrides and the minimum interval are documented in
`backend/.env.example`. This change does **not** raise hourly/daily caps and
does **not** implement or guarantee the provider's account-wide monthly quota.
If steady Midgard demand exceeds that allowance, reduce acquisition volume or
resolve the allowance with the provider; do not infer spare quota from a new
key or automatically purchase a plan.

## Correctness and rollout

The regression test first reproduced the local minute-cap failure with 28
competing requests followed by a 44-pool sweep. Other tests cover profile
isolation, unchanged long-window caps, bounded abortable pacing, and immediate
deferral on real quota exhaustion.

Migration 070 preserves migration 069 and every existing hashed counter. The
new paced admission path locks the same provider row, adds no quota charge when
waiting, and retains the latest admitted start across process restarts. Real
Postgres tests exercise concurrent clients, second-boundary spacing, rollback
compatibility, reapplication, cancellation/refunds, and clock regression.

Deploy the exact CI-passing backend commit using the normal guarded release
script. Do not reset budgets, cooldowns, caches or scan cursors. Verify the
resolved production profile without printing its credential; then verify a
complete Pool Analysis sweep and the public response's per-pool freshness.

Local verification passed the complete standard backend suite (863 passing,
15 opt-in skips), 628 frontend tests, and 36 targeted real-Postgres,
reproduction and pacing-safety tests with no skips. Architecture/surface checks
and the Svelte diagnostic ratchet pass (zero errors; 56 existing warnings).
The automated node-IP update already on main grew the public-data artifact by
exactly 84 bytes; the static-file baseline was reconciled by that exact amount
without changing frontend code or weakening the check.
