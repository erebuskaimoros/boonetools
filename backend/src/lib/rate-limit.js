const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 180;
const DEFAULT_MAX_BUCKETS = 20_000;

export function getRequestClientId(request) {
  const forwarded = String(request?.headers?.['x-forwarded-for'] || '');
  const forwardedAddress = forwarded.split(',')[0]?.trim();
  return forwardedAddress
    || String(request?.headers?.['x-real-ip'] || '').trim()
    || String(request?.socket?.remoteAddress || '').trim()
    || 'unknown';
}

export function createFixedWindowRateLimiter(options = {}) {
  const windowMs = Math.max(1000, Number(options.windowMs) || DEFAULT_WINDOW_MS);
  const maxRequests = Math.max(1, Number(options.maxRequests) || DEFAULT_MAX_REQUESTS);
  const maxBuckets = Math.max(100, Number(options.maxBuckets) || DEFAULT_MAX_BUCKETS);
  const now = options.now || Date.now;
  const buckets = new Map();

  function prune(timestamp) {
    if (buckets.size < maxBuckets) return;
    for (const [key, bucket] of buckets) {
      if (timestamp >= bucket.resetAt) buckets.delete(key);
      if (buckets.size < maxBuckets) break;
    }

    // Keep the map bounded even when every existing bucket is still live.
    // Map iteration order gives us a deterministic oldest-client eviction.
    while (buckets.size >= maxBuckets) {
      const oldestKey = buckets.keys().next().value;
      if (oldestKey === undefined) break;
      buckets.delete(oldestKey);
    }
  }

  return function check(request) {
    const timestamp = Number(now());
    const key = getRequestClientId(request);
    let bucket = buckets.get(key);
    if (!bucket || timestamp >= bucket.resetAt) {
      if (bucket) buckets.delete(key);
      prune(timestamp);
      bucket = { count: 0, resetAt: timestamp + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, maxRequests - bucket.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - timestamp) / 1000));

    return {
      allowed: bucket.count <= maxRequests,
      limit: maxRequests,
      remaining,
      resetAt: bucket.resetAt,
      retryAfterSeconds
    };
  };
}
