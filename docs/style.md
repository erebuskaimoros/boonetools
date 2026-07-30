# BOONE Tools UI Style Reference

Long-form reference for the **terminal aesthetic** that the boone.tools site
uses today. The compact agent-facing contract lives in
[`../DESIGN.md`](../DESIGN.md); runtime tokens live in
`src/lib/styles/variables.css` (terminal palette under the `--term-*` prefix).

> **History note (2026-05).** The site previously used an indigo/purple
> gradient theme with system fonts and `PageHeader`/`--gradient-card` patterns.
> That system is now legacy. The current home page (`App.svelte`) and the
> reference dashboards (`BondTrackerV2`, `AppLayerBaseLayerDashboard`) all use
> the terminal aesthetic documented below. The old gradient tokens and
> components are preserved in `variables.css` and `$lib/components/` so legacy
> tools keep rendering, but **do not use them in new work**.

---

## Table of Contents

1. [Aesthetic In One Sentence](#aesthetic-in-one-sentence)
2. [Reference Files](#reference-files)
3. [Color Palette](#color-palette)
4. [Typography](#typography)
5. [Layout & Containers](#layout--containers)
6. [Component Vocabulary](#component-vocabulary)
7. [Motion](#motion)
8. [Chart.js Styling](#chartjs-styling)
9. [Legacy System](#legacy-system)
10. [Migration Notes](#migration-notes)

---

## Aesthetic In One Sentence

Brutalist Bloomberg-terminal — dense, mono-typed, hard-edged, dark; closer to
a Linux TUI than a marketing site. Every new screen should read as a terminal
session first and a web page second.

## Reference Files

These are the canonical examples of the live style. When the docs and the
code disagree, the code wins.

| File | Role |
| --- | --- |
| `src/App.svelte` (`terminal-home`, `terminal-hero`, `nav-row` blocks) | Welcome screen — sets the entire visual language. |
| `src/lib/BondTrackerV2.svelte` | Fully-built terminal tool with mono Chart.js, tables, alerts. |
| `src/lib/AppLayerBaseLayerDashboard.svelte` | Most recent dashboard; structural reference for new tools. |

## Color Palette

The palette is intentionally narrow.

### Surface

| Token | Hex | Use |
| --- | --- | --- |
| `--term-bg` | `#080808` | Page background. |
| `--term-surface` | `#0a0a0a` | Panels, blocks, sticky table headers. |
| `--term-surface-hover` | `#0d0d0d` | Hover state for rows and metric cells. |
| `--term-surface-deep` | `#050505` | Inset surfaces inside cards (pill backgrounds). |
| `--term-surface-inset` | `#060606` | Subtle inset rows (target lines inside flow nodes). |

### Borders

| Token | Hex | Use |
| --- | --- | --- |
| `--term-border-faint` | `#111111` | Internal row separators in tables. |
| `--term-border` | `#1a1a1a` | Default border on cards, blocks, metric cells. |
| `--term-border-soft` | `#141414` | Dashed/soft dividers between block sections. |

### Text Ramp

| Token | Hex | Use |
| --- | --- | --- |
| `--term-text-strong` | `#ffffff` | Almost never — reserved for hot states. |
| `--term-text` | `#f5f5f5` | Display titles, primary metric values. |
| `--term-text-body` | `#e8e8e8` | Body text, default table cells. |
| `--term-text-2` | `#d8d8d8` | Secondary text, status text, table mono content. |
| `--term-text-3` | `#c8c8c8` | Labels, chart ticks, descriptive prose. |
| `--term-text-4` | `#bcbcbc` | Sub-labels and nonessential metadata. |
| `--term-text-5` | `#b2b2b2` | Inactive affordances and decorative labels. |
| `--term-text-6` | `#a8a8a8` | Bracket characters and decorative indices. |
| `--term-text-7` | `#a0a0a0` | The dimmest permitted UI ink; decorative use only. |

Create hierarchy with weight, spacing, and position before reducing contrast.
Structural rules may be faint, but text must remain readable. Use the dimmest
tokens only for decorative or inactive elements, never content, controls,
table headers, or chart labels.

### Accents

| Token | Hex | Use |
| --- | --- | --- |
| `--term-accent` | `#00cc66` | Terminal green. Status dots, highlighted path, hover names, `$` prompts, blinking cursor, accent numeric columns. |
| `--term-accent-soft` | `rgba(0,204,102,0.07)` | Primary card vertical fade. |
| `--term-accent-edge` | `rgba(0,204,102,0.4)` | Primary card border, primary pill border. |
| `--term-accent-glow` | `0 0 6px rgba(0,204,102,0.4)` | Status-dot glow only. |
| `--term-amber` | `#d4a017` | Reserve/destination cards, event labels in timelines, currency line on charts, `WRN` tag. |
| `--term-amber-soft` | `rgba(212,160,23,0.06)` | Reserve card vertical fade. |
| `--term-error` | `#e05260` | Error alert borders/labels. |
| `--term-info` | `#5588cc` | Informational chart series only. |

Do not introduce a new dominant hue for a one-off feature.

## Typography

Two fonts. No others.

### Loading

Both fonts are loaded once in `App.svelte`'s `<svelte:head>`:

```html
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
```

`:global(*)` defaults to `'DM Sans'`, so **mono must be set explicitly** on
every terminal element.

### Usage map

| Font | Used for |
| --- | --- |
| `'JetBrains Mono'` | Page titles, section h2s, all numbers, all labels, status pills, indices, addresses, hashes, bracketed metadata, table contents, inline code, command-line headers, timeline dates and events. |
| `'DM Sans'` | Descriptive prose only — block ledes, card role copy, explanatory paragraphs. |

### Size scale

| Token | Size | Use |
| --- | --- | --- |
| display | 30px / 800 | Page title (e.g. `APP LAYER → BASE LAYER_`). |
| metric | 24px / 800 | Primary metric values inside metric cards. |
| h2 | 14px / 700 / `0.08em` upper | Block headings. |
| body | 14px / 400 | Default body, descriptive paragraphs. |
| body-small | 13px / 400 | Block ledes, foot prose. |
| number | 12px / 600 | Mono numbers and addresses in cells. |
| label | 11px / 600 / `0.12em` upper | Metric labels, foot tags. |
| label-micro | 10px / 700 / `0.18em` upper | Incidental markers and compact status pills. |

Display titles use `letter-spacing: 0.06em`. Uppercase mono labels typically
sit between `0.08em` and `0.18em`. Never use negative tracking.

Essential mono content—including controls, metadata, table headers, and chart
axes—must be at least 11px. Tooltips start at 12px. Ten-pixel text is reserved
for incidental markers and must retain strong contrast. Multi-line body copy
starts at 13px and uses at least 1.5 line-height.

## Layout & Containers

| Width | Use |
| --- | --- |
| 600–650px | Single-focus trackers. |
| 800–900px | Moderate dashboards. |
| 1200–1400px | Wide explorers, multi-column tables. |
| Full width | Data tables with many columns. |

- Page padding: `24px 0 56px` on desktop, tighter on mobile.
- Metric grids: flush 4-up (`grid-template-columns: repeat(4, 1fr)`, `gap: 0`)
  inside a single `1px solid #1a1a1a` outer border. Internal cells use
  `border-right: 1px solid #1a1a1a` and drop the right border on the last
  cell.
- Sections (`.block`): square, `1px solid #1a1a1a`, `#0a0a0a` background,
  ~20px padding. `▌` green title marker + h2 + right-aligned `[meta]`.
- Do not nest cards inside cards. Sections group; cards represent repeated
  items or focused metrics.

## Component Vocabulary

These are the patterns you should reach for first.

### Command-line head

Tool header rendered as a shell prompt.

```svelte
<div class="head-top">
  <div class="head-left">
    <span class="prompt">$</span>
    <span class="cmd">track</span>
    <span class="arg">--app-layer → --base-layer</span>
  </div>
  <div class="head-right">
    <span class="status">
      <span class="dot ok"></span> LIVE
    </span>
    <span class="sep">│</span>
    <button class="refresh">
      <span class="bracket">[</span><span class="key">R</span><span class="bracket">]</span>
      refresh
    </button>
  </div>
</div>
<h1 class="title">APP LAYER <span class="arrow">→</span> BASE LAYER<span class="cursor">_</span></h1>
<p class="lede">{description in DM Sans}</p>
<div class="rule"></div>
```

Key details:
- `$` is `--term-accent` and bold. `cmd` is `text-body` semibold. `arg` is
  `text-3`.
- Status dot pulses 2s when live. Sep `│` is `text-6` dim.
- Bracket button: bracket chars `text-6`, key letter `accent`, action text
  lowercase, border-color flips to accent on hover.
- Title uppercase mono 30/800, arrows green, `_` cursor blinks 1s.
- Section `rule` is a 1px gradient: `accent 0% → border 14% → border 100%`.

### Block (general section)

```svelte
<section class="block">
  <div class="block-head">
    <div class="block-title">
      <span class="title-marker">▌</span>
      <h2>observed reserve payments</h2>
    </div>
    <div class="block-meta">[apr 30 → may 15]</div>
  </div>
  <p class="block-lede">{description}</p>
  <!-- ...content... -->
</section>
```

### Metric grid (4-up)

Flush, indexed, hoverable.

```svelte
<div class="metric-grid">
  <article class="metric">
    <div class="metric-head">
      <span class="metric-idx">01</span>
      <span class="metric-label">paid to tc reserve</span>
    </div>
    <strong class="metric-value">$1,638.65</strong>
    <small class="metric-foot">2,970.39 RUNE observed</small>
  </article>
  ...
</div>
```

### Alerts

One-line, three-letter tag.

```svelte
<div class="alert err">
  <span class="alert-tag">ERR</span>
  <span>artifact data — {message}</span>
</div>
```

Tag colors: `ERR` = `--term-error`, `WRN` = `--term-amber`, `INF` =
`--term-info`. Border + background are tinted 0.4 / 0.06 opacity of the same
hue.

### Tables

Mono throughout. Sticky `surface` header. 11px label-style header cells.
1px `border-faint` row separators. Right-aligned numeric columns. The
accent-colored "primary value" column uses `--term-accent`.

```svelte
<table>
  <thead>
    <tr>
      <th>denom</th>
      <th>amount</th>
      <th>est. usd</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td class="mono">{denom}</td>
      <td class="num">{amount}</td>
      <td class="num accent">{usd}</td>
    </tr>
  </tbody>
</table>
```

### Flow board

3-column "collector → queue → destination" layout. Highlighted path uses
green left-border + soft green fill on rows. Reserve cards use amber
treatment.

```svelte
<div class="flow">
  <div class="flow-col">
    <div class="col-head">app collectors</div>
    <article class="node">
      <div class="node-head">
        <span class="node-idx">01</span>
        <strong>RUJI Trade</strong>
        <span class="node-pill hot">50% → base</span>
      </div>
      <p class="node-role">Orderbook revenue collector</p>
      <div class="targets">
        <div class="target on-base">
          <span class="target-arrow">→</span>
          <span class="target-name">Base Layer Collector</span>
          <b class="target-pct">50%</b>
        </div>
      </div>
    </article>
  </div>
  ...
</div>
```

### Timeline

Vertical list with mono index + square accent node + dashed connector.

```svelte
<ol class="timeline">
  <li>
    <div class="t-idx">01</div>
    <div class="t-rail">
      <span class="t-node"></span>
      <span class="t-line"></span>
    </div>
    <div class="t-body">
      <span class="t-date">2025-06-02</span>
      <strong class="t-collector">Base Layer Collector</strong>
      <b class="t-event">Initialized on code 6</b>
      <p class="t-flow">RUNE target pointed directly to the TC Reserve module</p>
    </div>
  </li>
</ol>
```

Date is `--term-accent`. Event label is `--term-amber`. Node is an 8px square
with a 1px accent border.

### Status pills

```svelte
<span class="node-pill hot">50% → base</span>
<span class="node-pill code">code 159</span>
<span class="node-pill amber">RESERVE memo</span>
```

10px uppercase mono, 2px×7px, `border-default` → accent/amber on variant.
Status pills are the **only** place full pill rounding (`border-radius: 999px`)
is acceptable.

### Inline code

```svelte
<span class="inline-code">rujira-revenue</span>
```

Mono 11px, `#111` background, `#1a1a1a` border, accent text.

## Motion

Motion is functional, never decorative.

| Animation | Purpose | Spec |
| --- | --- | --- |
| `pulse-dot` | Live status indicator. | 2s infinite, opacity 1 → 0.45 → 1. |
| `blink` | Title cursor `_`. | 1s steps(1), 50/50 on/off. |
| `marquee` | Chart/data loading. | 1.2s steps(5), opacity 0.3 → 1 → 0.3. |
| hover row | Table/metric hover. | 0.15s ease, background only. |

Do not add page-load staggered reveals, hover-scale transforms, shimmer
sweeps, or scroll-triggered effects.

## Chart.js Styling

See `renderPaymentChart` in `AppLayerBaseLayerDashboard.svelte` for a complete
example. Quick recipe:

```js
{
  legend: { labels: { color: '#e8e8e8', font: { family: "'JetBrains Mono', monospace", size: 11, weight: 600 } } },
  tooltip: {
    backgroundColor: '#0a0a0a',
    borderColor: '#1a1a1a',
    borderWidth: 1,
    titleColor: '#ffffff',
    bodyColor: '#f5f5f5',
    titleFont: { family: "'JetBrains Mono', monospace", size: 12, weight: 700 },
    bodyFont: { family: "'JetBrains Mono', monospace", size: 12 }
  },
  scales: {
    x: {
      grid: { color: '#111', drawBorder: false },
      border: { color: '#1a1a1a' },
      ticks: { color: '#c8c8c8', font: { family: "'JetBrains Mono', monospace", size: 11 } }
    },
    y: {
      grid: { color: '#111' },
      border: { color: '#1a1a1a' },
      ticks: { color: '#00cc66', font: { family: "'JetBrains Mono', monospace", size: 11 } }
    }
  }
}
```

Bar series: `#00cc66` border + `rgba(0,204,102,0.55)` fill, `borderRadius: 0`.
Line series for cumulative/secondary: `#d4a017`. Point border `#080808` for
crisp contrast against the dark surface.

## Legacy System

Some older tools (`TCY.svelte`, `Nodes.svelte`, `LPChecker.svelte`,
`Treasury.svelte`, etc.) still use the pre-terminal aesthetic:

- System font stack (`-apple-system, BlinkMacSystemFont, ...`).
- `--gradient-card`, `--gradient-primary`, `--bg-main`, etc. tokens.
- `PageHeader`, `DataCard`, `ActionButton`, `ErrorDisplay` shared components.
- 12px rounded corners, drop shadows, indigo/purple `#667eea → #764ba2`
  gradient headers.

Those tools render fine and we are not actively migrating them. If you have
to touch one, you can stay in the legacy style for that file. **New tools
must use the terminal aesthetic.**

When you do migrate a legacy tool to terminal style:

1. Drop the `@import '$lib/styles/variables.css'` block and stop using
   `--gradient-*` / `--bg-card` tokens. Use `--term-*` instead.
2. Replace `PageHeader` with the command-line head pattern.
3. Replace `DataCard` with `.metric` cells in a flush `.metric-grid`.
4. Replace `ErrorDisplay` with `.alert err|warn|info` rows.
5. Replace any `'-apple-system'` font-family with the JetBrains Mono / DM
   Sans pair from this doc.

## Migration Notes

- The shared `$lib/components/` components were built against the legacy
  system. They will not be deleted, but new terminal-style work should write
  the small mono markup inline (or extract into
  `$lib/components/terminal/` if a pattern is genuinely reused 3+ times).
- `src/lib/styles/variables.css` retains the legacy `--bg-*`,
  `--gradient-*`, `--text-*` tokens for compatibility. The new `--term-*`
  tokens documented above are the canonical palette for new work.
- `App.svelte` does not import `variables.css` — its terminal styles are
  written inline. That is intentional and the recommended pattern for new
  terminal tools.

*Last updated: 2026-05-17 — full rewrite for terminal aesthetic.*
