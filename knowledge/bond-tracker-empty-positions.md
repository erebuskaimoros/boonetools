# Bond Tracker empty positions

The September 2, 2026 empty-address fix treats a successful node lookup with no
matching current bond position as a completed result. Bond, next award, and APY
show zero; no automatic bond-history request or refresh polling starts. The
dashboard explains the empty result and offers **Change address** and **View past
bonds**. The latter explicitly requests historical nodes for former bond providers.

Previously, the empty result threw into the error handler, which started the
history refresh queue anyway. The address remained in local storage, so reopening
the tracker repeated the loading state. Switching addresses also left previous
amounts and in-flight work alive.

Changing addresses now clears the saved address and bond/node URL parameters,
resets position/history state, and invalidates late current-position, history,
and historical-rate responses. Failed or malformed node data produces a retryable
error rather than reporting an empty position. THORNode's legitimate null provider
lists remain valid.

Regression coverage is in `tests/bond-tracker-empty-state.test.js`. It executes
the component's async handlers with controlled provider responses and covers
empty results, stale totals, saved-address recovery, malformed/fallback responses,
null provider lists, and late completions after changing addresses. Browser checks
cover the empty state at mobile width and recovery after reloading.
