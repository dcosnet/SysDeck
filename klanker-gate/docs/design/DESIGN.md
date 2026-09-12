# Frosty design system

Canonical design source of truth for the Frosty Control Plane UI
(`apps/control-ui`). Tokens are materialized in
[`tokens.css`](./tokens.css) and documented live in
[`design-system.html`](./design-system.html). Change values here first, then
regenerate the other two files.

`design-system.html` is a **static snapshot** pinned to the token values as of
the last manual regeneration. Nothing regenerates it automatically and no check
compares it against `tokens.css`, so it drifts silently whenever a token changes
here and only `tokens.css` is updated. Re-read it whenever you change a value.

**Revision: ds-r2.** This revision SUPERSEDES ds-r1 (glacier-blue). The register
is now a dense, near-neutral monochrome developer console. See
[Provenance](#references-and-provenance) for the rationale and the ds-r1 to
ds-r2 delta.

## Brand

- **Name:** Frosty (product surface: "Frosty Control Plane")
- **Personality, one line:** A quiet, near-monochrome instrument panel that
  keeps the operator's eye on the data, not the chrome.
- **Feeling words:** precise, restrained, dense

Frosty is a self-hosted control plane for a Deno-native LLM gateway. The
audience is developers and platform operators doing keyboard-heavy work over
dense telemetry: providers, keys, budgets, MCP servers, live request logs,
analytics. The identity is its own; it keeps Frosty's `sk-`/`vk-` key prefixes
and does not adopt any reference product's branding or key prefixes.

## Design read and dials

**Design read:** A trust-first operator console for developers and platform
operators. The visual language is a near-neutral monochrome (shadcn
"new-york"/neutral register): cool-tinted near-grays carrying only a whisper of
blue, a light-on-dark primary, and a single restrained accent blue reserved for
focus, links, and the active-nav marker. Dark is the default; light is a
derived, fully-tokenized theme. Density is high: compact rows, small labels,
large stat values.

| Dial | Value | Rationale |
| --- | --- | --- |
| DESIGN_VARIANCE | 3 | Operator tooling is trust-first: predictable, symmetric, repeatable layouts beat expressive composition when someone is debugging a failing provider at 2am. |
| MOTION_INTENSITY | 2 | Telemetry surfaces should feel near-instant; motion exists only as state feedback (hover, focus, enter/exit of overlays) and the live-stream pulse, never as show. |
| VISUAL_DENSITY | 8 | Data-dense tables, log streams, chart cards, and stat tiles are the product; the scale is compact (13.5px body), rows are tight, and controls are shorter than the ds-r1 baseline. |

Baseline (8 / 6 / 4) is explicitly overridden by the brief: this is a dense
dashboard, not a landing page. ds-r2 is one density step tighter than ds-r1.

## Color

**Near-neutral monochrome.** Neutrals are cool near-grays at hue 265 with
chroma at or below 0.006: never a pure gray, never a saturated tint. Dark is
the default theme.

**Primary is the shadcn-neutral inversion.** In dark, `--primary` is near-white
with an ink label; in light, it is near-black with a paper label. Primary is
the emphasis surface (primary buttons, the one solid "default" chip), not a hue.

**One accent blue, used sparingly.** A single restrained cool-blue (hue 252 in
dark, 255 in light) is the only chromatic accent in the chrome. It is used ONLY
for the focus ring (`--ring`), links, and the active-nav indicator
(`--sidebar-primary`). It is never a fill: no blue buttons, no blue banners.

**Semantic status colors are a functional vocabulary,** not extra accents:
success (green 155), warning (amber 70 to 82), destructive (red 25), info
(blue 250 to 255). One rule keeps their solid fills legible: on dark they are
light tones with ink text; on light they are deep tones with paper text.

**Charts** get their own `--chart-1..5` family (blue, green, amber, red,
violet) derived from the accent blue plus the semantic hues. Each chart mark is
verified at 3:1 or better as a non-text mark on the card surface, in both
themes.

### Color tokens

All values are OKLCH with hex fallback. Light theme is the `:root` base; dark
theme is the `.dark` override (mounted by default). Contrast column summarizes
the computed check in the [Accessibility](#accessibility) section.

| Token | Role | Light | Dark | Contrast note |
| --- | --- | --- | --- | --- |
| `--background` | App canvas | `oklch(0.99 0.002 265)` `#fbfcfd` | `oklch(0.15 0.004 265)` `#0a0b0d` | fg on it 17.59:1 light, 18.84:1 dark (AAA) |
| `--foreground` | Body text | `oklch(0.2 0.006 265)` `#151619` | `oklch(0.985 0.001 265)` `#fafafb` | AAA on all surfaces both themes |
| `--card` | Raised surface, tiles, tables | `oklch(1 0 0)` `#ffffff` | `oklch(0.185 0.004 265)` `#121314` | fg on it 18.10:1 light, 17.85:1 dark (AAA) |
| `--card-foreground` | Text on card | same as foreground | same as foreground | see foreground |
| `--popover` | Dialogs, menus, sheets, command palette | `oklch(1 0 0)` `#ffffff` | `oklch(0.205 0.004 265)` `#161719` | fg on it 18.10:1 light, 17.16:1 dark (AAA) |
| `--popover-foreground` | Text on popover | same as foreground | same as foreground | see foreground |
| `--primary` | Emphasis surface: primary buttons, solid default chip | `oklch(0.24 0.006 265)` `#1e1f22` | `oklch(0.92 0.004 265)` `#e3e4e7` | label on it 15.76:1 light, 14.14:1 dark (AAA) |
| `--primary-foreground` | Label on primary fill | `oklch(0.985 0.001 265)` `#fafafb` | `oklch(0.205 0.006 265)` `#16171a` | see primary |
| `--secondary` | Secondary button fill | `oklch(0.965 0.003 265)` `#f2f3f5` | `oklch(0.255 0.004 265)` `#222325` | label 16.36:1 light, 15.10:1 dark (AAA) |
| `--secondary-foreground` | Label on secondary | same as foreground | same as foreground | see secondary |
| `--muted` | Quiet fills: skeletons, disabled, table header | `oklch(0.965 0.003 265)` `#f2f3f5` | `oklch(0.235 0.004 265)` `#1d1e20` | muted fg on it 6.04:1 light, 6.52:1 dark (AA) |
| `--muted-foreground` | Secondary text, captions, timestamps | `oklch(0.475 0.008 265)` `#5a5c61` | `oklch(0.712 0.008 265)` `#a0a2a7` | 6.49:1 light (AA), 7.70:1 dark (AAA) on canvas |
| `--accent` | Hover and selection wash | `oklch(0.965 0.004 265)` `#f2f3f6` | `oklch(0.255 0.006 265)` `#212326` | label 14.86:1 light, 15.11:1 dark (AAA) |
| `--accent-foreground` | Text on accent wash | `oklch(0.24 0.006 265)` `#1e1f22` | same as foreground | see accent |
| `--destructive` | Errors, deletion, unhealthy | `oklch(0.52 0.2 25)` `#c21725` | `oklch(0.665 0.19 25)` `#f25855` | label on it 5.85:1 light, 5.43:1 dark (AA) |
| `--destructive-foreground` | Label on destructive fill | `oklch(0.985 0.005 25)` `#fdf9f8` | `oklch(0.205 0.04 25)` `#280e0c` | see destructive |
| `--success` | Healthy, set, enabled, live | `oklch(0.48 0.13 155)` `#00723b` | `oklch(0.72 0.15 155)` `#43c07a` | as text on canvas 5.89:1 light (AA), 8.45:1 dark (AAA) |
| `--success-foreground` | Label on success fill | `oklch(0.985 0.005 155)` `#f8fbf9` | `oklch(0.18 0.04 155)` `#021709` | 5.82:1 light (AA), 8.01:1 dark (AAA) |
| `--warning` | Missing config, needs confirmation | `oklch(0.52 0.11 70)` `#8f5d14` | `oklch(0.8 0.13 82)` `#e7b551` | as text on canvas 5.49:1 light (AA), 10.42:1 dark (AAA) |
| `--warning-foreground` | Label on warning fill | `oklch(0.985 0.005 80)` `#fcfaf6` | `oklch(0.24 0.04 82)` `#291d07` | 5.40:1 light (AA), 8.74:1 dark (AAA) |
| `--info` | Neutral-informational: transports, processing | `oklch(0.5 0.15 255)` `#1762b6` | `oklch(0.68 0.13 250)` `#549de5` | as text on canvas 5.89:1 light (AA), 6.86:1 dark (AA) |
| `--info-foreground` | Label on info fill | `oklch(0.985 0.005 250)` `#f8fafd` | `oklch(0.17 0.04 250)` `#021020` | 5.81:1 light (AA), 6.67:1 dark (AA) |
| `--border` | Hairlines, card and table borders | `oklch(0.92 0.004 265)` `#e3e4e7` | `oklch(0.27 0.006 265)` `#252629` | decorative; not a text pair |
| `--input` | Input borders (stronger than border) | `oklch(0.89 0.004 265)` `#d9dbdd` | `oklch(0.3 0.006 265)` `#2c2e31` | decorative; field identity via fill, label, focus ring |
| `--ring` | Focus ring, links, inline accents (accent blue) | `oklch(0.55 0.15 255)` `#2971c6` | `oklch(0.62 0.13 252)` `#4589d2` | vs canvas 4.76:1 light, 5.41:1 dark (link AA, UI 3:1 pass) |
| `--chart-1` | Chart series 1 (blue) | `oklch(0.52 0.15 255)` `#1f68bc` | `oklch(0.66 0.14 252)` `#4b95e5` | vs card 5.56:1 light, 6.00:1 dark (3:1 pass) |
| `--chart-2` | Chart series 2 (green) | `oklch(0.52 0.14 155)` `#007f43` | `oklch(0.72 0.15 155)` `#43c07a` | vs card 5.09:1 light, 8.00:1 dark (3:1 pass) |
| `--chart-3` | Chart series 3 (amber) | `oklch(0.6 0.12 70)` `#ad721c` | `oklch(0.8 0.13 82)` `#e7b551` | vs card 4.05:1 light, 9.88:1 dark (3:1 pass) |
| `--chart-4` | Chart series 4 (red) | `oklch(0.52 0.2 25)` `#c21725` | `oklch(0.665 0.19 25)` `#f25855` | vs card 6.12:1 light, 5.59:1 dark (3:1 pass) |
| `--chart-5` | Chart series 5 (violet) | `oklch(0.5 0.18 300)` `#7541b8` | `oklch(0.62 0.16 300)` `#966cd7` | vs card 6.55:1 light, 4.80:1 dark (3:1 pass) |
| `--sidebar` | Sidebar surface | `oklch(0.975 0.003 265)` `#f6f7f9` | `oklch(0.13 0.004 265)` `#070709` | nav label 15.31:1 light, 10.77:1 dark (AAA) |
| `--sidebar-foreground` | Nav item labels | `oklch(0.24 0.006 265)` `#1e1f22` | `oklch(0.8 0.006 265)` `#bcbec2` | see sidebar |
| `--sidebar-primary` | Active-item inset bar, live dot (accent blue) | `oklch(0.52 0.15 255)` `#1f68bc` | `oklch(0.62 0.13 252)` `#4589d2` | vs sidebar 5.18:1 light, 5.53:1 dark (UI 3:1 pass) |
| `--sidebar-primary-foreground` | Label on sidebar-primary fill | `oklch(0.985 0.001 265)` `#fafafb` | `oklch(0.985 0.001 265)` `#fafafb` | paper label |
| `--sidebar-accent` | Active and hovered nav item fill | `oklch(0.955 0.005 265)` `#eef0f4` | `oklch(0.235 0.006 265)` `#1d1e21` | active label 14.43:1 light, 15.97:1 dark (AAA) |
| `--sidebar-accent-foreground` | Active nav item label | `oklch(0.24 0.006 265)` `#1e1f22` | `oklch(0.985 0.001 265)` `#fafafb` | see sidebar-accent |
| `--sidebar-border` | Sidebar hairline | `oklch(0.91 0.004 265)` `#e0e1e4` | `oklch(0.24 0.006 265)` `#1e1f22` | decorative |
| `--sidebar-ring` | Focus ring inside sidebar | same as ring | same as ring | see ring |

## Typography

Two stacks, no shipped font files, no fetched webfonts.

- **Sans (UI):** `ui-sans-serif, system-ui, -apple-system, "Segoe UI",
  Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif`
- **Mono (telemetry):** `"JetBrains Mono", ui-monospace, "Cascadia Code",
  "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`

JetBrains Mono is named first as an optional progressive enhancement: it is
free and open (SIL OFL 1.1) and renders only where locally installed. Every
position after it is a system face, so the file is fully self-contained.

Mono is the telemetry register. Latency, cost, token counts, model ids,
versions, URLs, key names, and log lines are always mono. Prose, labels,
headings, and navigation are always sans. Serif is banned on this surface.

### Scale

Compact scale, px-snapped, tuned one density step tighter than ds-r1. Body is
13.5px. Hierarchy comes from size, weight step, and color, never from oversized
type. The stat-tile value is the one deliberately large figure (3xl mono).

| Step | Size / line height | Weight | Use |
| --- | --- | --- | --- |
| 3xl | 27px / 32px | 600, tracking -0.01em | display, large stat-tile values |
| 2xl | 21px / 26px | 600, tracking -0.01em | page titles |
| xl | 18px / 24px | 600 | section and dialog titles |
| lg | 16px / 22px | 500 | emphasized body |
| base | 13.5px / 20px | 400 | body, table cells, forms |
| sm | 13px / 18px | 400 | secondary text, helper text, nav items |
| xs | 12px / 16px | 400 | captions, badges, timestamps |
| 2xs | 11px / 16px | 500, tracking 0.02em | micro mono labels (column headers, section labels) |

Weights: 400 regular, 500 medium (labels, nav items, buttons), 600 semibold
(headings, stat numbers). Nothing heavier.

## Spacing, radius, shadow

- **Spacing base unit: 4px.** Scale: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64
  (`--space-1` through `--space-16`). Stay on the scale; when in doubt round
  down.
- **Radius: one family from a single 6px base.** `--radius-sm` 4px (badges,
  checkboxes), `--radius-md` 6px (buttons, inputs), `--radius-lg` 8px (cards,
  panels, chart cards), `--radius-xl` 12px (dialogs, sheets), `--radius-full`
  for pills and the switch. No mixed radius systems.
- **Shadows: three steps, near-neutral, never glacier.** `--shadow-sm`
  (inputs, rows), `--shadow-md` (popovers, toasts), `--shadow-lg` (dialogs,
  sheets, command palette). Dark theme leans on borders first, shadows second.
  No glassmorphism: overlays are opaque `--popover`, not blurred.
- **Control metrics (denser than ds-r1):** default control height 34px
  (`--control-h`), dense 30px (`--control-h-sm`), prominent 42px
  (`--control-h-lg`). Every interactive component guarantees a 44px minimum hit
  area (`--tap-target`); controls with a smaller visual height extend their hit
  area with a pseudo-element. Border width 1px, focus ring 2px with 2px offset.
- **Page measure.** Content is capped at `--container-max` (110rem / 1760px),
  applied once by the app shell. Page gutters use `--gutter` (24px, tightening
  to 16px at `<= 48rem` so a tablet does not spend a quarter of its width on
  padding). Anything text-heavy - prose, single-column form panels - takes the
  inner cap `--measure-max` (60rem) instead: a label-control pair stretched to
  1760px puts the label a screen away from its input. Tables and dashboards may
  use the full container width.

## Motion

Motion is feedback, not decoration. MOTION_INTENSITY 2: nothing moves unless it
communicates state.

| Token | Value | Use |
| --- | --- | --- |
| `--motion-fast` | 100ms | hover, focus, pressed feedback |
| `--motion-default` | 150ms | menus, popovers, switches, tabs |
| `--motion-slow` | 220ms | dialogs, sheets, command palette, page-level transitions |
| `--motion-spin` | 800ms | continuous loading spinner rotation |
| `--motion-ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | enters, hovers (default easing) |
| `--motion-ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` | exits, reversible toggles |
| `--motion-rise` | -2px | hover lift distance |
| `--motion-enter` | 8px | enter-toward travel (overlays come toward rest) |

Rules: elements enter toward their resting position (translate 8px to 0, fade
in) and exit away, never back the way they came. Lists may stagger at 30ms per
row, capped at 8 rows. The only ambient animation permitted is the live-stream
pulse on the `streaming` badge, because it conveys a real connection state.
Under `prefers-reduced-motion: reduce` all duration and distance tokens collapse
to zero and keyframe animations are disabled; the loading spinner falls back to
a static ring.

## Component rules

Everything consumes tokens; no component may introduce a raw color, radius,
size, or duration. shadcn/ui is the one kit; customize its components with these
tokens, never ship it in default zinc.

- **Buttons.** Variants: primary (`--primary` fill, the near-white/near-black
  emphasis surface), secondary (`--secondary` fill), ghost (transparent,
  `--accent` wash on hover), destructive (`--destructive` fill). Heights from
  control metrics; radius `--radius-md`; weight 500; focus-visible shows the 2px
  `--ring` with offset; disabled drops to 50% opacity; loading swaps in a
  `--motion-spin` spinner and disables the control. One primary action per view
  region.
- **Links and inline accents.** Links, the active-nav inset bar, and the live
  dot consume the accent blue (`--ring` in content, `--sidebar-primary` in the
  sidebar). The accent blue is never used as a component fill.
- **Badges.** Two shapes: solid (semantic fill + its foreground) and soft
  (semantic color as text over a 16% `color-mix` tint with a 32% tint border).
  Soft is the default for tables and lists; solid is reserved for the single
  most important state in a region. Radius `--radius-sm`, size xs, weight 500.
- **Status vocabulary (locked by the D-CONTRACT strings).** The app must render
  these literal badge texts with these semantics:

  | Badge text | Meaning | Style |
  | --- | --- | --- |
  | `default` | default provider | soft muted, icon-only: a `Star` glyph with `title="Default provider"` and the word in `sr-only` text |
  | `no key` | provider has no API key or cloud credentials | soft destructive |
  | `disabled` | provider disabled | soft destructive |
  | `online` | provider enabled, credentialed, last health probe clean | soft success |
  | `error` | last provider health probe failed, or a log-level error / failed request | soft warning (provider rail) / soft destructive (logs) |
  | `enabled` | resource enabled | soft success |
  | `http-sse` | MCP transport (default per D11) | soft info |
  | `streamable-http`, `auto` | MCP transports | soft info |
  | `read-only` | tool is safe (readOnlyHint) | soft info |
  | `needs confirmation` | tool requires approval | soft warning |
  | `streaming` | SSE log stream live | soft success + pulse dot |
  | `disconnected` | SSE log stream down | soft destructive |
  | `healthy` | MCP server healthy | soft success |
  | `unhealthy` | MCP server failing | soft destructive |
  | `ok` | gateway healthz | soft success |

  ds-r2 note: `default` was specified as solid primary. Shipped code renders it
  as a soft muted **icon-only** chip - the star already reads as "default", and
  the word cost ~45px of the 288px provider rail, which is what tipped a
  long-named row into the overlap bug now locked by
  `two-pane.overflow.test.tsx`. The literal strings `set` and `missing` are not
  rendered anywhere; provider key presence is shown as a dotted marker in the
  detail table and as the `no key` status in the rail. The pulse dot is allowed
  only on `streaming` and at most once per view. No other decorative dots.
- **Chips and tags.** Model chips and the `CUSTOM` provider tag are soft neutral
  (muted) pills at radius `--radius-full`, xs weight 500. Removable chips carry a
  trailing close glyph inside the 44px hit area.
- **Left nav rail.** `--sidebar` surface, 15rem expanded, 3rem icon rail
  collapsed. A top **search box** carries a `Ctrl K` / `Cmd K` affordance glyph
  and opens the command palette. Groups are **collapsible section headers**:
  each group label is a button with `aria-expanded` and a rotating chevron that
  discloses its leaves; a search query force-opens every group with a match, and
  the collapsed icon rail force-opens all of them. Leaves do not nest, and there
  is no external-link glyph variant. Section labels are 2xs mono muted. Item: sm
  weight 500, radius `--radius-md`, hover = `--sidebar-accent` wash, active =
  `--sidebar-accent` fill + `--sidebar-accent-foreground` text + a 2px
  `--sidebar-primary` inset bar on the left edge. Footer carries the
  admin-token button (with a status dot: muted / success / destructive) and the
  theme toggle. The mono version line (`gateway v{semver} on Deno {deno}`) lives
  on the Status page, not the rail.
- **Command palette.** A centered overlay on `--popover` with `--shadow-lg`,
  radius `--radius-xl`, opened by `Cmd K` / `Ctrl K`. A single search input, then
  grouped results with 2xs mono group labels; the highlighted row uses the
  `--accent` wash; each row may carry a trailing mono shortcut hint. Enters
  toward rest at `--motion-slow`; scrim is a token-derived translucent wash,
  never a blur.
- **Tabbed configuration panel.** Horizontal tabs (underline indicator in
  `--primary`) over dense field grids. Rows mix inputs, native selects,
  switches, and a monospace PEM textarea (`--font-family-mono`, `--input`
  border). A sticky footer on `--card` with a top `--border` hairline holds the
  Save (primary) and Remove (destructive ghost) actions.
- **Filter and facet sidebar.** A secondary panel of collapsible facet groups:
  a searchable model list, checkbox groups, and collapsible sections with a
  rotating chevron. Group headers are 2xs mono muted; counts are mono. Selected
  facets echo as removable soft-neutral chips above the results.
- **Analytics dashboard.** A grid of **chart cards** (`--card`, `--radius-lg`,
  1px `--border`) each with a title, a bar/line toggle, a legend keyed to
  `--chart-1..5`, and a graceful "No data available" empty state on the muted
  surface. Above them, a 4-up **stat-tile row**: xs muted sans label, 3xl mono
  semibold value, optional xs mono muted delta. Charts use only `--chart-*` for
  series and `--muted-foreground` for axes and gridlines.
- **Data tables (log and resource tables).** Card surface, 1px `--border`
  outline, radius `--radius-lg`, header row in 2xs mono muted on `--muted` with
  **sortable columns** (an up/down affordance on the active sort key). Body rows
  are 34px min height with `--space-3` cell padding and a bottom hairline only;
  hover row gets the `--accent` wash. Telemetry columns (time, latency, tokens,
  cost, model) are mono; numeric columns right-aligned. Request status renders as
  a status bar plus a soft badge. Rows expose inline actions: a secret **reveal
  (eye)** toggle and **copy** button for keys, and **edit** and **delete** icon
  buttons, each inside the 44px hit area. A footer shows **pagination**:
  "Showing X-Y of Z" (mono) with Previous and Next ghost buttons. Skeleton rows
  use `--muted` with the shimmer guarded by reduced motion.
- **Custom-provider form.** An inline form in the Providers detail pane
  presenting a **toggle grid of request types** (chat, embedding, image, audio,
  and so on) as a wrapped grid of switch rows, plus the provider id and base URL
  fields. Confirm is a primary button; the provider then carries the `CUSTOM`
  tag.
- **Forms.** Inputs on `--background`/`--card` with `--input` borders, radius
  `--radius-md`, height `--control-h`; labels sm weight 500; helper text sm
  muted; error state swaps border and helper to `--destructive` and sets
  `aria-invalid`. Focus is always the 2px ring with offset. Secrets are
  write-only fields; the UI never renders a stored key (a `hasApiKey` flag drives
  `set`/`missing`), and the reveal control only unmasks freshly entered input.
- **Overlays.** Dialogs, sheets, and the command palette on `--popover` with
  `--shadow-lg` and radius `--radius-xl`; enter toward rest at `--motion-slow`;
  scrim is a token-derived translucent wash, never a blur (no glassmorphism).
  Toasts bottom-right on `--popover` with `--shadow-md` and a 3px semantic left
  border.

## Usage rules

1. **Do** keep the neutral monochrome plus one accent blue; **don't** introduce
   a second accent hue or use the accent blue as a fill.
2. **Do** render every telemetry value (latency, cost, tokens, model ids,
   versions, log lines) in the mono stack; **don't** put prose or headings in
   mono.
3. **Do** use the semantic tokens for state (success, warning, destructive,
   info) exactly per the status vocabulary; **don't** color status by eye or
   invent new badge texts for locked contract strings.
4. **Do** lock each page to one theme with dark as default; **don't** flip
   themes mid-page or mix light cards onto the dark canvas.
5. **Do** derive every visual value from a token; **don't** hardcode hex,
   oklch, px sizes, or durations in component code.
6. **Do** use borders and surface steps for elevation on dark; **don't** use
   glows, glassmorphism, or heavy shadows.
7. **Do** keep motion at feedback level with the reduced-motion collapse;
   **don't** animate for decoration or exceed the slow tier for UI chrome.
8. **Do** keep the one 6px radius family; **don't** mix pill buttons with square
   cards or vary radius per component.
9. **Do** show empty ("No data available"), loading (skeleton), and error states
   for every data region and chart card; **don't** ship a table or chart that
   renders blank while fetching.
10. **Do** meet AA contrast and the 44px hit-area minimum on every interactive
    element in both themes; an inaccessible control is a defect, not a style
    choice.
11. **Do** keep Frosty's own identity and `sk-`/`vk-` key prefixes; **don't**
    adopt any reference product's branding or key prefixes.

## Accessibility

Contrast computed programmatically (WCAG 2.x relative luminance, sRGB) by
converting each token from OKLCH to sRGB and applying the 2.x contrast formula.
Verdicts: AA requires 4.5:1 for text, 3:1 for large text and non-text UI; AAA is
7:1. Soft-badge rows composite the semantic color at 16% alpha over the card
surface (source-over in sRGB) and measure the full-strength color text against
that composited background. Every value below is a freshly computed ds-r2
figure.

### Dark theme (default)

| Foreground | Background | Ratio | Requires | Verdict | Role |
| --- | --- | --- | --- | --- | --- |
| `--foreground` | `--background` | 18.84:1 | 4.5:1 | AAA | body text on canvas |
| `--foreground` | `--card` | 17.85:1 | 4.5:1 | AAA | body text on card |
| `--foreground` | `--popover` | 17.16:1 | 4.5:1 | AAA | body text on popover/dialog |
| `--foreground` | `--secondary` | 15.10:1 | 4.5:1 | AAA | text on secondary button |
| `--muted-foreground` | `--background` | 7.70:1 | 4.5:1 | AAA | muted text on canvas |
| `--muted-foreground` | `--card` | 7.29:1 | 4.5:1 | AAA | muted text on card |
| `--muted-foreground` | `--popover` | 7.01:1 | 4.5:1 | AAA | muted text on popover |
| `--muted-foreground` | `--muted` | 6.52:1 | 4.5:1 | AA | muted fg on muted surface |
| `--primary-foreground` | `--primary` | 14.14:1 | 4.5:1 | AAA | primary button label, solid default chip |
| `--accent-foreground` | `--accent` | 15.11:1 | 4.5:1 | AAA | hover-surface label |
| `--destructive-foreground` | `--destructive` | 5.43:1 | 4.5:1 | AA | destructive button label |
| `--success-foreground` | `--success` | 8.01:1 | 4.5:1 | AAA | solid success badge label |
| `--warning-foreground` | `--warning` | 8.74:1 | 4.5:1 | AAA | solid warning badge label |
| `--info-foreground` | `--info` | 6.67:1 | 4.5:1 | AA | solid info badge label |
| `--sidebar-foreground` | `--sidebar` | 10.77:1 | 4.5:1 | AAA | nav item label |
| `--muted-foreground` | `--sidebar` | 7.87:1 | 4.5:1 | AAA | nav section label |
| `--sidebar-accent-foreground` | `--sidebar-accent` | 15.97:1 | 4.5:1 | AAA | active nav item label |
| `--ring` | `--background` | 5.41:1 | 4.5:1 | AA | link/accent text on canvas |
| `--ring` | `--card` | 5.13:1 | 4.5:1 | AA | link/accent text on card |
| `--sidebar-primary` | `--sidebar` | 5.53:1 | 3.0:1 | AA (UI) | active nav indicator |
| `--ring` | `--background` | 5.41:1 | 3.0:1 | AA (UI) | focus ring vs canvas |
| `--ring` | `--card` | 5.13:1 | 3.0:1 | AA (UI) | focus ring vs card |

Chart marks, dark (non-text, 3:1 as a mark on `--card`):

| Series | Ratio vs card | Requires | Verdict |
| --- | --- | --- | --- |
| `--chart-1` blue | 6.00:1 | 3.0:1 | pass |
| `--chart-2` green | 8.00:1 | 3.0:1 | pass |
| `--chart-3` amber | 9.88:1 | 3.0:1 | pass |
| `--chart-4` red | 5.59:1 | 3.0:1 | pass |
| `--chart-5` violet | 4.80:1 | 3.0:1 | pass |

Soft badges, dark (color text over 16% tint composited on card):

| Badge text color | Composited bg | Ratio | Verdict |
| --- | --- | --- | --- |
| `--success` | `#1a2e25` | 6.15:1 | AA |
| `--warning` | `#342d1e` | 7.25:1 | AAA |
| `--destructive` | `#361e1f` | 4.64:1 | AA |
| `--info` | `#1c2936` | 5.17:1 | AA |
| `--muted-foreground` | `#282a2c` | 5.65:1 | AA |

### Light theme

| Foreground | Background | Ratio | Requires | Verdict | Role |
| --- | --- | --- | --- | --- | --- |
| `--foreground` | `--background` | 17.59:1 | 4.5:1 | AAA | body text on canvas |
| `--foreground` | `--card` | 18.10:1 | 4.5:1 | AAA | body text on card |
| `--foreground` | `--popover` | 18.10:1 | 4.5:1 | AAA | body text on popover/dialog |
| `--foreground` | `--secondary` | 16.36:1 | 4.5:1 | AAA | text on secondary button |
| `--muted-foreground` | `--background` | 6.49:1 | 4.5:1 | AA | muted text on canvas |
| `--muted-foreground` | `--card` | 6.68:1 | 4.5:1 | AA | muted text on card |
| `--muted-foreground` | `--popover` | 6.68:1 | 4.5:1 | AA | muted text on popover |
| `--muted-foreground` | `--muted` | 6.04:1 | 4.5:1 | AA | muted fg on muted surface |
| `--primary-foreground` | `--primary` | 15.76:1 | 4.5:1 | AAA | primary button label, solid default chip |
| `--accent-foreground` | `--accent` | 14.86:1 | 4.5:1 | AAA | hover-surface label |
| `--destructive-foreground` | `--destructive` | 5.85:1 | 4.5:1 | AA | destructive button label |
| `--success-foreground` | `--success` | 5.82:1 | 4.5:1 | AA | solid success badge label |
| `--warning-foreground` | `--warning` | 5.40:1 | 4.5:1 | AA | solid warning badge label |
| `--info-foreground` | `--info` | 5.81:1 | 4.5:1 | AA | solid info badge label |
| `--sidebar-foreground` | `--sidebar` | 15.31:1 | 4.5:1 | AAA | nav item label |
| `--muted-foreground` | `--sidebar` | 6.22:1 | 4.5:1 | AA | nav section label |
| `--sidebar-accent-foreground` | `--sidebar-accent` | 14.43:1 | 4.5:1 | AAA | active nav item label |
| `--ring` | `--background` | 4.76:1 | 4.5:1 | AA | link/accent text on canvas |
| `--ring` | `--card` | 4.89:1 | 4.5:1 | AA | link/accent text on card |
| `--sidebar-primary` | `--sidebar` | 5.18:1 | 3.0:1 | AA (UI) | active nav indicator |
| `--ring` | `--background` | 4.76:1 | 3.0:1 | AA (UI) | focus ring vs canvas |
| `--ring` | `--card` | 4.89:1 | 3.0:1 | AA (UI) | focus ring vs card |

Chart marks, light (non-text, 3:1 as a mark on `--card`):

| Series | Ratio vs card | Requires | Verdict |
| --- | --- | --- | --- |
| `--chart-1` blue | 5.56:1 | 3.0:1 | pass |
| `--chart-2` green | 5.09:1 | 3.0:1 | pass |
| `--chart-3` amber | 4.05:1 | 3.0:1 | pass |
| `--chart-4` red | 6.12:1 | 3.0:1 | pass |
| `--chart-5` violet | 6.55:1 | 3.0:1 | pass |

Soft badges, light (color text over 16% tint composited on card):

| Badge text color | Composited bg | Ratio | Verdict |
| --- | --- | --- | --- |
| `--success` | `#d6e8e0` | 4.77:1 | AA |
| `--warning` | `#ede5d7` | 4.51:1 | AA |
| `--destructive` | `#f5dadc` | 4.64:1 | AA |
| `--info` | `#dae6f3` | 4.79:1 | AA |
| `--muted-foreground` | `#e5e5e6` | 5.30:1 | AA |

**Result: 0 failures across 64 checked pairs (both themes):** 22 text/UI pairs,
5 chart marks, and 5 soft badges per theme. Weakest required margins are the
dark soft-destructive badge at 4.64:1 (text, needs 4.5:1) and the light accent
link at 4.76:1 (text, needs 4.5:1); both pass.

Decorative hairlines (`--border`, `--input`, `--sidebar-border`) are intentionally
low-contrast structure, not required 3:1 pairs under WCAG 1.4.11; field and card
identity is carried by fill, label, and the focus ring, which do pass 3:1.

Further requirements: visible focus (2px ring, 2px offset) on every interactive
element; 44px minimum hit areas; full keyboard path (including the command
palette and all row actions); labels tied to inputs; `role=alert` on error
banners; `aria-live=polite` on the log stream region; sortable headers exposed
with `aria-sort`; reduced-motion collapse as specified in Motion.

## References and provenance

- **Revision:** ds-r2, which **supersedes ds-r1** (glacier-blue). ds-r1 was a
  saturated cyan-leaning "glacier" identity; the owner found it too branded for
  an operator console and supplied reference screenshots of a modern neutral
  LLM-gateway console. ds-r2 re-anchors on that neutral register.
- **Anchor:** the modern near-neutral shadcn console register (shadcn
  "new-york"/neutral), from the owner's reference screenshots: monochrome
  cool near-grays, a light-on-dark primary, a single restrained accent blue for
  focus/links/active-nav, and a functional semantic status vocabulary. Frosty
  keeps its own identity and `sk-`/`vk-` key prefixes; it does not adopt the
  reference's branding or key prefixes.
- **ds-r1 to ds-r2 delta:** neutral hue moved from cool slate (about 230) to a
  whisper-cool 265 at much lower chroma; the glacier brand accent was removed and
  primary became the shadcn-neutral monochrome inversion (near-white in dark,
  near-black in light); the accent blue is now reserved (focus/links/active-nav
  only, never a fill); a `--chart-1..5` family was added for the new analytics
  dashboard; density increased one step (13.5px body, 34px default control,
  motion default 150ms / slow 220ms); the `default` badge moved from soft
  primary to solid primary. Token NAMES are unchanged so the app re-themes by
  swapping values.
- **UI kit:** shadcn/ui on Tailwind CSS v4 + React + Vite (locked by intake
  D-STACK). Theming format OKLCH, dual theme, dark default. One kit for the
  whole project; no second component system. Install: `npx shadcn@latest init`
  (Vite flow), then `npx shadcn@latest add button badge input select checkbox
  switch table tabs dialog sheet command sonner alert skeleton sidebar label
  form tooltip pagination`.
- **Icons:** lucide-react, explicitly granted by the owner for shadcn parity
  (recorded intake grant). No hand-rolled SVG icons.
- **Fonts:** system stacks only; JetBrains Mono (SIL OFL 1.1) named as optional
  progressive enhancement, no font files shipped, no webfont fetches.
- **Locked intake decisions honored:** D-STACK (kit), D-IDENTITY (own Frosty
  identity, dark-first, both themes tokenized), D-CONTRACT (status badge
  vocabulary and literal strings), D-DELIVERABLE (this file plus tokens.css plus
  design-system.html at `docs/design/`).
- **Contrast method:** each token converted OKLCH to sRGB and scored with the
  WCAG 2.x relative-luminance contrast formula; soft badges composited at 16%
  over card. 0 failures across 64 pairs in both themes.
