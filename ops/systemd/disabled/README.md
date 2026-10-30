# Disabled timers

Deploys install only `ops/systemd/*.timer`, and disable and remove any installed
unit missing from the release. Timers kept here are turned off on the next
deploy; move one back to `ops/systemd/` to turn it on again.

- `boonetools-wasm-arb-economics*.timer` — Wasm Arb Economics collection, paused
  2026-10-30. The fee lane's `tx_search` failed on every run and the scheduler
  exhausted the shared daily Midgard budget. The services remain for manual runs.
