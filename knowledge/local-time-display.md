# Browser-local time display

Implementation and release contract, October 25, 2026.

`src/lib/utils/datetime.js` formats presentation timestamps using the browser's
IANA timezone. Dates are evaluated at the instant being displayed, so historical
daylight-saving offsets are respected. A bounded formatter cache avoids creating
an Intl formatter per row. Missing or invalid values stay unavailable; date-only
bucket keys are deliberately rejected as instants.

Financials freshness, retries, settlement checks, swap times and hourly charts;
POL and Burn snapshot timestamps; Pool Analysis and Dislocation observations;
Wasm hourly views; ADR26 event details; Status, Node Votes, Rapid Swaps, Thorfolio,
Vault Explorer, App Layer and shared datetime consumers use the formatter.
Existing browser-local date-only event displays and Limit Orders' browser-zone
chart remain local. Static reports and daily/monthly accounting dates retain
their source calendar.

`src/lib/charts/hour-labels.js` plans visible local-hour ticks before rendering.
It detects local date changes between visible ticks (even when midnight is
skipped), keeps original timestamps as keys, and labels repeated DST hours with
their respective timezone abbreviations. Half/quarter-hour zones display actual
UTC bucket starts, rather than relabeling them as local clock-hour boundaries.
Financials tables show the local date as well as time for transactions, since a
UTC reporting day can span two local dates.

No provider, storage, query, bucket aggregation, daily selection or backend
changes are required. Daily/weekly/monthly source dates remain explicitly UTC.
There is no setting or persistence requirement: the browser supplies the user's
timezone automatically. A normal reload picks up a changed device timezone.

Validation: frontend suite (816 tests in both New York and UTC environments), import/provider/surface/Svelte checks
(zero errors, 56 pre-existing warnings), production build, and focused timezone
coverage for New York DST, Kathmandu quarter-hour offsets, local midnight,
missing values and unchanged UTC reporting dates. Browser preview uses
`http://127.0.0.1:4181/financials`. Browser checks confirmed 24/24 observed
hourly buckets, America/New_York range and local date-transition labels, EDT
freshness/cutoff text, plus POL snapshot timestamps and layout. The development
server uses the public BooneTools API base for the other dashboards; Financials
retains its existing bounded local adapter.

Release through the guarded frontend deployment only. No backend activation,
migration, cache reset or provider warmup is needed. After activation, reload
Financials and POL to verify the served bundle uses local timestamps, retains
UTC reporting dates, and preserves the H/24H behavior.
