# Status provider freshness incident — September 23, 2026

## Evidence

At 21:08 UTC the public RPC reported height 27,957,812 with a recent committed
block; the status read model reported height 27,943,798 and `Stalled`.
Production API/read-model jobs were healthy. The primary public Liquify REST
API and dedicated RPC returned current state, while the configured fallback
`thornode.thorchain.liquify.com` was approximately one day behind. The public
WebSocket reconnected at 20:55 UTC and started delivering old heights.
Five-minute RPC header repair advanced the stored head, but its growing age
between repairs was mistaken for a consensus stall.

The initiating shared cooldown was an HTTP 429 with gRPC code 8 and
`received message larger than max`: an 18.5 MB swap-queue result exceeded the
10.5 MB response limit. The scanner requested 1,000 entries at once. Treating
this deterministic request-size failure as a gateway rate limit blocked the
healthy REST/Midgard routes and selected the lagging fallback. The error
recurred at 21:17 UTC with a 25.6 MB response and extended the cooldown another
hour. A 100-entry queue request succeeded.

Vanaheimex independently returned a real `Too many requests from this IP`
429. Those cooldowns must remain respected; expired scanner values must not
look like current validator lag.

## Regression and recovery contract

- Request-size failures cannot open provider/service cooldowns, including an
  already-persisted breaker with that exact failure reason. Genuine rate
  limits and Retry-After continue to back off.
- Queue scans page through the whole result with bounded response sizes;
  exhausted limits or failed pages cannot publish an apparently complete scan.
- Core state cannot regress below its last accepted height or a newer durable
  chain head. A verified THORNode source supplies the other fields in that
  refresh cycle; fallback state cannot silently replace newer Mimir/node data.
- A missing or stale stream is an acquisition failure, not proof of a stalled
  chain. Scheduled RPC verification supplies independent live head evidence;
  public HTTP handlers remain provider-free.
- Old scanner reports become unavailable, and a browser status response older
  than 45 seconds loses its live/stall assertion. Technical warning duplication
  is condensed into readable notices.

Five behavioral regressions reproduced before fixes: global cooldown on a
size error, oversized/unpaginated queue scan, regressed core state marked
fresh, false consensus stall from inconsistent heights, and stale scanner
stats presented as current. UI coverage also checks expired live/stall labels.

## Validation

All 111 focused tests passed, including confirmed real stalls, failed RPC
verification, replayed streams, missing predecessor intervals, out-of-order
browser responses, bounded queue scans, and poisoned core-cache recovery.
The full frontend/backend suites passed before final review additions; CI
verifies the complete release. Architecture/surface/Svelte checks passed with
zero errors and the existing 56 warnings. A live read-only queue scan retrieved
712 entries across eight 100-entry requests in approximately 0.7 seconds.
