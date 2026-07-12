# BooneTools Website Guidance

Read [AGENTS.md](./AGENTS.md) for repo scope and [../../AGENTS.md](../../AGENTS.md) for workspace rules.

## Local Sources of Truth

- `DESIGN.md`: compact UI contract; read before UI work
- `src/lib/styles/variables.css`: runtime tokens
- `src/lib/styles/base.css`: shared style patterns
- `docs/style.md`: longer visual rationale
- `knowledge/`: website-specific protocol notes and session history

## Cross-Project Scope

- This repo owns the primary BooneTools website and production backend.
- `../RUNE-Tools` is the legacy/alternate web app.
- `../rune-tools-desktop` is the Electron line.
- `../../chain-analysis-app` is a separate local investigation app.
- `../../ThorNode` and `../../Rujira` own protocol and contract behavior respectively.

Use [../../knowledge/projects/boonetools.md](../../knowledge/projects/boonetools.md) for shared product context.
