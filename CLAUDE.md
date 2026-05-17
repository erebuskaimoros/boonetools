# CLAUDE.md

## Knowledge Base

See `knowledge/` for project documentation:
- `tc-info.md` - THORChain architecture reference
- `rune-dip-buying-bot-plan.md` - Trading bot design
- `trading-bot-research.md` - Research notes
- `sessions/` - Session logs

## Sub-Projects

### Website UI (`website/`)

For website UI work, read `website/DESIGN.md` first. It is the compact agent-facing design contract; runtime CSS tokens remain in `website/src/lib/styles/variables.css`, shared class patterns are in `website/src/lib/styles/base.css`, and longer UI notes are in `website/docs/style.md`.

### Trading Bot (`rune-tools-desktop/src/bot/`)

Automated RUNE dip-buying bot using THORChain. Monitors price, detects 3% dips from rolling high, executes swaps via THORChain, takes profits on recovery.

Key files: `signalEngine.ts`, `positionManager.ts`, `executor.ts`, `priceMonitor.ts`

### Backtesting System (`rune-tools-desktop/src/bot/backtest/`)

Historical simulation of the dip-buying strategy against Midgard price data. Includes parameter optimization, risk metrics (Sharpe, Sortino, Calmar), and data quality validation.

Key files: `engine.ts`, `metrics.ts`, `dataLoader.ts`, `optimizer.ts`, `cli.ts`

Run with: `npx tsx src/bot/backtest/cli.ts run --start 2024-01-01 --end 2024-03-01`
