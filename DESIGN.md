---
version: "terminal-2026-07"
name: "BOONE Tools"
description: "Agent-facing design contract for the boone.tools Svelte utilities."
colors:
  background: "#080808"
  surface: "#0a0a0a"
  surface-hover: "#0d0d0d"
  surface-deep: "#050505"
  inset: "#060606"
  border-faint: "#111111"
  border-default: "#1a1a1a"
  border-strong: "#2a2a2a"
  ink: "#080808"
  text-primary: "#ededed"
  text-strong: "#ffffff"
  text-body: "#d2d2d2"
  text-secondary: "#b8b8b8"
  text-muted: "#a3a3a3"
  text-dim: "#949494"
  text-dimmer: "#858585"
  text-dimmest: "#7a7a7a"
  accent: "#00cc66"
  accent-soft: "rgba(0, 204, 102, 0.07)"
  accent-edge: "rgba(0, 204, 102, 0.4)"
  amber: "#d4a017"
  amber-soft: "rgba(212, 160, 23, 0.06)"
  error: "#e05260"
  warning: "#d4a017"
  info: "#5588cc"
  currency: "#ffc107"
typography:
  display:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: 30px
    fontWeight: 800
    lineHeight: "1.1"
    letterSpacing: 0.06em
    case: "uppercase"
  h2:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: 14px
    fontWeight: 700
    lineHeight: "1.2"
    letterSpacing: 0.08em
    case: "uppercase"
  label:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: 11px
    fontWeight: 600
    lineHeight: "1.2"
    letterSpacing: 0.12em
    case: "uppercase"
  label-micro:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: 10px
    fontWeight: 700
    lineHeight: "1.2"
    letterSpacing: 0.18em
    case: "uppercase"
  metric:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: 24px
    fontWeight: 800
    lineHeight: "1.1"
    letterSpacing: "-0.01em"
  number:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: 12px
    fontWeight: 600
    lineHeight: "1.4"
  body:
    fontFamily: "'DM Sans', -apple-system, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: "1.6"
  body-small:
    fontFamily: "'DM Sans', -apple-system, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: "1.55"
fonts:
  load: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&family=DM+Sans:wght@400;500;600;700&display=swap"
  display: "'JetBrains Mono', monospace"
  body: "'DM Sans', -apple-system, sans-serif"
  mono: "'JetBrains Mono', monospace"
shape:
  radius-none: 0px
  radius-tiny: 2px
  pill: 9999px
  borders: "Sharp corners. Use border-radius only on tiny accents (status pills, marker dots). Cards, panels, tables, and metrics use square corners with thin 1px borders."
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 20px
  2xl: 24px
  3xl: 32px
components:
  shell:
    backgroundColor: "{colors.background}"
    fontFamily: "{fonts.body}"
    textColor: "{colors.text-body}"
  command-line:
    description: "Tool header rendered as a shell prompt. Use a green `$` prompt, the verb (cmd), then arguments. Pair with a right-aligned status pill + bracketed shortcut button."
    fontFamily: "{fonts.mono}"
    fontSize: 12px
    color: "{colors.text-muted}"
  page-title:
    description: "Uppercase mono display title with green accent arrows or punctuation and a blinking green `_` cursor."
    typography: "{typography.display}"
    color: "{colors.text-primary}"
    accent: "{colors.accent}"
  block:
    description: "Flat card with thin border and `▌` green title marker. Right side carries bracketed metadata."
    backgroundColor: "{colors.surface}"
    border: "1px solid {colors.border-default}"
    borderRadius: "{shape.radius-none}"
    padding: "18px 20px 22px"
    titleMarker: "▌"
    titleMarkerColor: "{colors.accent}"
  metric-card:
    description: "4-up indexed metric tiles flush against each other inside a single bordered grid (no gaps, single 1px border around the group, internal borders between)."
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border-default}"
    padding: "16px 18px"
    height: 116px
    indexColor: "{colors.accent}"
    valueTypography: "{typography.metric}"
    labelTypography: "{typography.label}"
    hoverBackground: "{colors.surface-hover}"
  status-pill:
    description: "Compact uppercase pill with optional pulsing dot. Color reflects state (accent for ok, amber for warn, dim for inactive)."
    fontFamily: "{fonts.mono}"
    fontSize: 10px
    border: "1px solid {colors.border-default}"
    padding: "2px 7px"
  status-dot:
    description: "6px circle. Green pulses when live, amber static when degraded, dim grey when inactive."
    size: 6px
    okColor: "{colors.accent}"
    warnColor: "{colors.amber}"
    okGlow: "0 0 6px rgba(0, 204, 102, 0.4)"
    okAnimation: "pulse-dot 2s infinite"
  bracket-button:
    description: "Terminal-style action button. Pattern: `[X] action` with bracket chars in `text-dim`, X in `accent`, action lowercase in `text-secondary`. Border `border-default` → `accent` on hover."
    background: transparent
    border: "1px solid {colors.border-default}"
    padding: "5px 10px"
    hoverBorder: "{colors.accent}"
    hoverColor: "{colors.accent}"
  table:
    description: "Mono throughout, uppercase header row with 11px label-style text, 1px `border-faint` row separators, sticky `surface` header, green hover background and accent-colored numeric column."
    fontFamily: "{fonts.mono}"
    fontSize: 12px
    headerColor: "{colors.text-muted}"
    headerBackground: "{colors.surface}"
    rowBorder: "1px solid {colors.border-faint}"
    rowHoverBackground: "{colors.surface-hover}"
    accentColumnColor: "{colors.accent}"
  inline-code:
    description: "Inline mono code chip used inside body text."
    fontFamily: "{fonts.mono}"
    background: "{colors.border-faint}"
    color: "{colors.accent}"
    border: "1px solid {colors.border-default}"
    padding: "1px 5px"
  alert:
    description: "Single-row alert with uppercase 3-letter tag (`ERR`, `WRN`, `INF`). Mono throughout."
    fontFamily: "{fonts.mono}"
    fontSize: 12px
    tagColors: { err: "{colors.error}", warn: "{colors.amber}", info: "{colors.info}" }
  timeline:
    description: "Vertical ordered list with `01`/`02` mono indices, square accent node + dashed connector rail, green date, amber event label."
    nodeColor: "{colors.accent}"
    railColor: "{colors.border-default}"
    dateColor: "{colors.accent}"
    eventColor: "{colors.amber}"
  flow-card:
    description: "Card in a 3-column flow board. Highlighted path uses green left-border + soft green background. Reserve/destination uses amber treatment."
    background: "{colors.surface-hover}"
    border: "1px solid {colors.border-default}"
    primaryBorder: "{colors.accent-edge}"
    primaryBackground: "linear-gradient(180deg, {colors.accent-soft} 0%, {colors.surface} 60%)"
    reserveBorder: "rgba(212, 160, 23, 0.4)"
    reserveBackground: "linear-gradient(180deg, {colors.amber-soft} 0%, {colors.surface} 60%)"
  rule:
    description: "Horizontal section divider with a green spark on the left fading into the default border color."
    style: "linear-gradient(90deg, {colors.accent} 0%, {colors.border-default} 14%, {colors.border-default} 100%)"
    height: 1px
---

## Overview

BOONE Tools is a public THORChain power-user surface. The site has a single
visual identity: a **brutalist Bloomberg-terminal aesthetic**. It is dense,
data-first, mono-typed, hard-edged, and dark — closer to a Linux dashboard or a
Bloomberg panel than a marketing site.

Anything you ship — a new tool, a new panel, a new card — must read like a
terminal screen first and a web page second. If it could plausibly run in a
TTY, you are in the right neighborhood.

This file is the compact agent-facing contract. The long-form rationale and
component inventory live in [`docs/style.md`](docs/style.md). Runtime CSS
tokens live in `src/lib/styles/variables.css` (terminal palette under
`--term-*` names; older `--bg-*` / `--gradient-*` tokens remain for legacy
components but should NOT be used in new work).

## Anchors (look at these first)

The canonical examples of the live style are:

- `src/App.svelte` — terminal shell: collapsible left sidebar nav on desktop
  (`sidebar`, `side-item`, `bracket-btn` classes), top bar + dropdown nav on
  mobile and in desktop-app iframe mode. There is no homepage; `/` defaults
  to the status dashboard. This shell sets the entire visual language for
  the site.
- `src/lib/BondTrackerV2.svelte` — a fully-built terminal tool with mono
  tables, green/amber Chart.js styling, and `#1a1a1a` borders.
- `src/lib/AppLayerBaseLayerDashboard.svelte` — most recent dashboard built
  against this contract. Use it as the structural reference for new tools.

If anything in this document disagrees with `App.svelte` or
`BondTrackerV2.svelte`, the rendered code wins. Update this file.

## Colors

The palette is intentionally narrow:

- **Backgrounds:** `#080808` (page), `#0a0a0a` (panels), `#0d0d0d` (hover),
  `#060606`/`#050505` (inset). No gradients on surfaces.
- **Borders:** `#1a1a1a` is the default rule. `#111` for very faint internal
  separators. Use dashed `#1a1a1a` for "this is a soft divider" cues.
- **Text:** `#ededed` for primary, `#d2d2d2` for body, `#b8b8b8` for
  secondary, then a restrained ramp (`#a3a3a3` → `#7a7a7a`) for labels,
  indices, bracket characters, and incidental metadata. Structural rules may
  be faint; user-facing content must remain readable.
- **Accent (Terminal Green):** `#00cc66`. Reserve this for: status dots, the
  highlighted base layer / primary path, hover states, command-line `$`
  prompts, the blinking `_` cursor in titles, accent numeric columns, primary
  pills, and the spark on section rules. Do not use it for ordinary body
  copy.
- **Amber:** `#d4a017`. Reserve for: destination/reserve cards, currency-like
  values on charts, event labels in timelines, the `WRN` alert tag.
- **Reds and blues:** `#e05260` (errors only), `#5588cc` (informational chart
  series only). Do not introduce new dominant hues for one-off features.

Use weight, spacing, and position to create hierarchy before reducing contrast.
Normal-sized text should meet WCAG AA contrast against its actual surface.
Reserve the dimmest tokens for decorative punctuation or inactive affordances,
never data, axes, table headers, explanatory copy, or controls.

## Typography

Two fonts. No others.

- **`'JetBrains Mono'`** — used for: page titles, section h2s, all numbers,
  all labels, status pills, indices, addresses, hashes, bracketed metadata,
  table contents, inline code, command-line headers, timeline dates and
  events. If it is structural data, it is mono.
- **`'DM Sans'`** — used for: descriptive prose only (block ledes, card role
  copy, the "system income note" style explanations). Body fallback to
  `-apple-system, sans-serif`.

Both fonts are loaded from Google Fonts in `App.svelte`'s `<svelte:head>`:

```html
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
```

`:global(*)` sets the default to `'DM Sans'`, so mono must be set explicitly on
every terminal element. User-facing mono content starts at 11px; 10px is
reserved for genuinely incidental markers and must use high contrast. Body
copy starts at 13px, with 14px preferred. Chart axes and legends are at least
11px, and tooltips are at least 12px. Display titles and primary metric values
remain 22px–30px.

Most uppercase mono labels carry letter-spacing between `0.08em` and `0.18em`.
Display titles use `0.06em`. Never use negative letter-spacing.

## Layout

- Single-focus trackers: ~600–650px wide.
- Moderate dashboards: ~800–900px wide.
- Wide explorers and grids: 1200–1400px or full-width when the data demands.
- Page padding: `24px 0 56px` on desktop, tightened on mobile.
- Metric grids: flush 4-up with internal borders and one outer border. No
  gaps between metric cells unless responsive collapse pushes them.
- Sections (`.block`): square, `1px solid #1a1a1a`, `#0a0a0a` background,
  ~20px padding, with a `▌` green title marker and bracketed `[metadata]` on
  the right side of the header.

Do not nest cards inside cards. Use sections for groups, single bordered
panels for repeated items.

## Shapes and elevation

The aesthetic is flat and hard-edged.

- **Border radius is 0 by default.** A small radius (1–2px) is acceptable on
  rare accents. Status pills are the only place where `border-radius: 999px`
  appears.
- **No drop shadows on cards.** Use thin borders for separation.
- **No gradient surfaces.** The only gradients allowed are:
  1. The horizontal section rule (`accent → border-default`).
  2. Very subtle vertical fades inside primary/reserve flow cards
     (`rgba(0,204,102,0.07) → surface`). Keep them faint — they hint at
     state, they don't decorate.
- **Inset shadows** are acceptable on the primary base-layer card to suggest
  a faint glow:
  `inset 0 0 18px rgba(0, 204, 102, 0.04)`.

## Motion

Motion is functional, not decorative.

- **Status dot pulse** (2s infinite, 1 → 0.45 opacity) for live state.
- **Blinking cursor** (`_`) on the page title — 1s steps, 50/50 on/off.
- **Marquee loader** (`▓░░░░`) for chart loading states — 1.2s steps.
- Hover transitions on cards and rows are short (`0.15s ease`) and limited to
  background and border color. No translate, no scale, no glow expansion.

Do not add page-load reveals, staggered fades, or scroll-triggered effects.
Terminals don't animate; they redraw.

## Component vocabulary

Always reach for these patterns before inventing new ones:

| Pattern | Use for |
| --- | --- |
| **Command-line head** | Tool page header. `$ verb --args` mono prompt, status pill on the right with pulsing dot, `[R] refresh` bracket button. |
| **`.block`** | Any grouped section (chart, table, flow, timeline). Header has `▌` marker + h2 + right-aligned `[meta]`. |
| **`.metric-grid`** | The 4-up summary tiles at the top of a dashboard. Indexed `01`/`02`/.... |
| **`.alert err\|warn\|info`** | One-line failure/warning/info notices with a 3-letter tag. |
| **`.table` (mono)** | Any list with > 2 columns of structured data. Sticky `surface` header, accent numeric column. |
| **`.timeline`** | Ordered historical events. `01` index, square node, dashed rail, green date, amber event. |
| **`.flow-col` + `.node`** | Multi-stage data flow (collector → queue → destination). Highlight the active path with green left-border. |
| **Bracket button** | Any clickable action that isn't an icon-only control. Example: `[R] refresh`, `[?] help`. |
| **Inline code chip** | Code fragments inside prose: `<span class="inline-code">rujira-revenue</span>`. |

If you need something that doesn't fit one of these, copy from
`AppLayerBaseLayerDashboard.svelte` first, then decide whether to abstract.

## Shared Svelte components

The components in `src/lib/components/` (`PageHeader`, `DataCard`,
`ActionButton`, etc.) were built against the **legacy** purple-gradient
system. **Do not use them in new terminal-style work.** Build the patterns
inline using the contract above, or extract reusable terminal components into
`src/lib/components/terminal/` as needed.

`LoadingBar.svelte`, `StatusIndicator.svelte`, `ErrorDisplay.svelte`, and
similar are still acceptable inside legacy components but should not be added
to new terminal screens — write the small bit of mono markup directly.

Reusable terminal primitives live under `src/lib/components/terminal/`.
`TerminalAlert.svelte` is the canonical `ERR` / `WRN` / `INF` row and preserves
the alert treatment described above. Shared Chart.js palette/font primitives
live in `src/lib/charts/terminal.js`; feature-specific datasets, plugins, and
interaction controllers stay beside each feature's model.

## Do's and Don'ts

Do:

- Treat every page as a terminal session. Headers, labels, footers all read
  like shell output.
- Default to mono and a readable neutral grey. Reach for green only to signal
  live data, active paths, and the user's focus.
- Keep borders thin (`1px`), corners sharp, surfaces flat.
- Keep essential labels, controls, tables, axes, and metadata at 11px or
  larger; body copy starts at 13px. Use 10px only for incidental markers.
- Mark the highlighted path in any flow with green left-border + soft green
  background.
- Use `→` arrows, `▌` markers, `▣`/`◈` node glyphs, `[brackets]`, and `$`
  prompts as part of the visual vocabulary.

Don't:

- Use `PageHeader` (purple gradient) or `--gradient-card` on new screens.
- Introduce `'Inter'`, `'Roboto'`, `'Space Grotesk'`, system-font sans, or
  any decorative serif. Two fonts: JetBrains Mono, DM Sans.
- Add rounded corners larger than 2px (status pills excepted).
- Add drop shadows on cards.
- Use indigo/purple (`#667eea` / `#764ba2`) anywhere on the surface.
- Add page-load staggered reveals, hover scale, or glow-on-hover effects.
- Build "marketing" framing — heroes with big subtitle prose, gradient
  callouts, decorative icons. The first frame of every tool is the working
  interface.
