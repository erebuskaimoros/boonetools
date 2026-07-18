/** In-memory TTL cache with request coalescing and optional stale-on-error. */
export class TtlSingleFlightCache {
  constructor({ ttlMs = 30000, now = () => Date.now() } = {}) {
    this.ttlMs = Math.max(0, Math.trunc(Number(ttlMs) || 0));
    this.now = now;
    this.entries = new Map();
    this.inFlight = new Map();
    this.generation = 0;
  }

  getEntry(key, { allowStale = false } = {}) {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }

    const stale = entry.expiresAt <= this.now();
    if (stale && !allowStale) {
      return null;
    }

    return { ...entry, stale };
  }

  get(key, options = {}) {
    return this.getEntry(key, options)?.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    const createdAt = this.now();
    const normalizedTtlMs = Math.max(0, Math.trunc(Number(ttlMs) || 0));
    this.entries.set(key, {
      value,
      createdAt,
      expiresAt: createdAt + normalizedTtlMs
    });
    return value;
  }

  delete(key) {
    this.generation += 1;
    this.inFlight.delete(key);
    return this.entries.delete(key);
  }

  clear() {
    this.generation += 1;
    this.entries.clear();
    this.inFlight.clear();
  }

  async getOrLoad(key, loader, options = {}) {
    const fresh = this.getEntry(key);
    if (fresh && !options.forceRefresh) {
      return fresh.value;
    }

    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }

    const stale = this.getEntry(key, { allowStale: true });
    const generation = this.generation;
    const promise = Promise.resolve()
      .then(() => loader())
      .then((value) => {
        if (this.generation === generation) {
          this.set(key, value, options.ttlMs ?? this.ttlMs);
        }
        return value;
      })
      .catch((error) => {
        if (!options.staleIfError || !stale) {
          throw error;
        }
        return typeof options.onStale === 'function'
          ? options.onStale(stale.value, error)
          : stale.value;
      })
      .finally(() => {
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key);
        }
      });

    this.inFlight.set(key, promise);
    return promise;
  }
}

export function createTtlSingleFlightCache(options) {
  return new TtlSingleFlightCache(options);
}
