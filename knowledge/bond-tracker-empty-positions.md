# Bond Tracker empty positions

The September 2, 2026 empty-address fix keeps the address form visible while
checking for a current bond. A successful lookup with no matching position shows
**No bond found** beside the editable query. It does not open the dashboard or
request bond history. Only a confirmed bond position opens the tracker and saves
the address for future visits.

Previously, the empty result threw into the error handler, which started the
history refresh queue anyway. The address remained in local storage, so reopening
the tracker repeated the loading state. Switching addresses also left previous
amounts and in-flight work alive.

An empty lookup also clears any saved address and bond/node URL parameters, so
reopening a previously saved empty query returns to the form. Changing addresses
resets position/history state and invalidates late current-position, history,
and historical-rate responses. Failed or malformed node data produces a retryable
error rather than reporting no bond. THORNode's legitimate null provider lists
remain valid. The former zero-valued dashboard and its optional past-bonds action
have been removed; bonded positions retain their existing HIST toggle.

Regression coverage is in `tests/bond-tracker-empty-state.test.js`. It executes
the component's async handlers with controlled provider responses and covers
pending and empty lookups, stale totals, saved-address recovery, malformed/fallback
responses, null provider lists, and late completions after changing addresses.
Browser checks cover the form at mobile width and recovery after reloading.
