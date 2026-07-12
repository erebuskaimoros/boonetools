# BooneTools Website Agent Notes

## Scope

- This repo owns the primary boone.tools frontend, production backend, database migrations, deployment scripts, and operations files.
- It does not own the legacy `../RUNE-Tools` app, the desktop app in `../rune-tools-desktop`, or the separate `../../chain-analysis-app`.
- THORChain protocol behavior belongs in `../../ThorNode`; Rujira contract truth belongs in `../../Rujira`.

## Project Guidance

- Read `DESIGN.md` before UI work. Runtime tokens live in `src/lib/styles/variables.css`, shared styles in `src/lib/styles/base.css`, and longer rationale in `docs/style.md`.
- Keep backend migrations, handlers, services/timers, frontend consumers, and deployment docs synchronized for production features.
- Run Git commands from this repo root. The top-level workspace tracks only this repo's gitlink, not its internal files.

## Shared Context

- Read `../../AGENTS.md`, `../../knowledge/projects/boonetools.md`, and `../../knowledge/workstreams/analytics-and-tooling.md`.
- Keep detailed local notes in `knowledge/`; update the shared wiki for durable cross-project conclusions.
