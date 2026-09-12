# UI design (control plane)

This document records the Frosty Deno control-plane SPA (`apps/control-ui`)
**exactly as implemented in the working tree**. It is a reference for the
interface a reader will actually see, not a wishlist. Where the shipped code
diverges from the declared design source [DESIGN.md](DESIGN.md), the code is
authoritative here and the divergence is called out.

The control plane is served same-origin by the gateway from the same port
(default 8080); it renders API-only until `deno task build-ui` has produced
`apps/control-ui/dist`. See
[../concepts/architectural-overview.md](../concepts/architectural-overview.md)
for how the SPA fits the gateway (one process, or N under `FROSTY_WORKERS`), and
[../../apps/control-ui/CONVENTIONS.md](../../apps/control-ui/CONVENTIONS.md) for
the binding SPA contract.

## Stack (verified)

| Concern | Choice | Evidence |
| --- | --- | --- |
| Framework | React 19 (`^19.2.8`) + react-dom, mounted via `ReactDOM.createRoot` inside `React.StrictMode` | `package.json:9-10`, `src/main.tsx:6-10` |
| Styling | Tailwind CSS v4 (`^4.3.3`) CSS-first, wired through `@tailwindcss/vite`; **no `tailwind.config.*`, no `postcss.config.*`** | `vite.config.ts:7`, `package.json:14,22` |
| Class utility | `cn()` = `twMerge(clsx(...))` | `src/lib/utils.ts:4` |
| Icons | `lucide-react ^1.25.0` only (plus a documented brand-SVG exception) | `package.json:8` |
| Router | none - a hand-rolled hash router in `App.tsx` | grep: no router dependency |
| State / component libraries | none - no Radix, no shadcn runtime, no state library; every primitive is hand-written | `package.json`; grep |
| App version | `0.7.0` | `apps/control-ui/package.json` |
| Design revision | `ds-r2` (supersedes ds-r1 "glacier-blue"); dark is the default theme | `tokens.css:2,9`; `index.html:2` |

Design tokens live in `apps/control-ui/src/styles/tokens.css` (340 lines,
OKLCH). A near-identical mirror ships at [tokens.css](tokens.css) in this folder
(CRLF, 331 lines pre-`deno fmt`); the two carry **zero value differences** and
are synced by hand, with no generator or CI check tying them together.

---

## 1. Design system

### 1.1 Identity and principles

`ds-r2` is a dense, near-neutral monochrome developer console, register shadcn
"new-york"/neutral (`DESIGN.md:29-35`). The load-bearing rules, all verified
against code:

- **Dark is the default and only pre-paint-resolved theme.** The document mounts
  with `class="dark"` (`index.html:2`).
- **Neutrals are hue 265, chroma <= 0.006** - a whisper of cool, never pure gray
  (`tokens.css:11-12`).
- **`--primary` is an emphasis surface, not a hue.** It is the shadcn-neutral
  inversion: near-black in light, near-white in dark (`tokens.css:44,202`).
- **One cool-blue accent (hue 252 dark / 255 light), used only for the focus
  ring, links, and the active-nav indicator - never as a fill.** Verified: there
  is no `bg-ring` anywhere in the app.
- **Semantic status color (success/warning/destructive/info) is a functional
  vocabulary only**, never decorative.
- **lucide-react icons only; same-origin only.** No external CDN, font, script,
  or image origin exists in `index.html`, `index.css`, `tokens.css`, or any
  component. No `@font-face`, no `<link>` to a font, no font files shipped.

Declared design dials (informational): DESIGN_VARIANCE 3, MOTION_INTENSITY 2,
VISUAL_DENSITY 8 (`DESIGN.md:37-41`).

Token counts: **105 custom properties in `:root`**, of which **41 are
re-declared in `.dark`** (38 colors + 3 shadows) and **5 are re-declared under
`prefers-reduced-motion`**. Light values are the `:root` base
(`tokens.css:32-187`); dark is a `.dark` class override (`tokens.css:192-245`);
`color-scheme` is set per theme (`:33,193`) so native widgets follow.

### 1.2 Color palette

Every emitted value is OKLCH. The **hex** columns are the fallback hexes written
in the token file's own comments - documentation only, not the rendered value.
Line numbers reference `apps/control-ui/src/styles/tokens.css`.

#### Surfaces

| Token | Light (OKLCH) | Light hex | Dark (OKLCH) | Dark hex | Usage |
| --- | --- | --- | --- | --- | --- |
| `--background` | `0.99 0.002 265` (36) | `#fbfcfd` | `0.15 0.004 265` (195) | `#0a0b0d` | `body` fill (`index.css:20`); sticky config-footer fill (`ProviderConfigPanel.tsx:370`) |
| `--foreground` | `0.2 0.006 265` (37) | `#151619` | `0.985 0.001 265` (196) | `#fafafb` | `body` text (`index.css:21`); every modal scrim as `bg-foreground/40` |
| `--card` | `1 0 0` (38) | `#ffffff` | `0.185 0.004 265` (197) | `#121314` | Card surface; every field fill; sticky table header; active tab/segment; Sheet body |
| `--card-foreground` | = foreground (39) | `#151619` | = foreground (198) | `#fafafb` | Card / Sheet text |
| `--popover` | `1 0 0` (40) | `#ffffff` | `0.205 0.004 265` (199) | `#161719` | Dialog, DropdownMenu, Combobox listbox, TimeRangePicker, ColumnPicker, CommandPalette, Toast, chart tooltip (`/95`), skip-link chip |
| `--popover-foreground` | = foreground (41) | `#151619` | = foreground (200) | `#fafafb` | Same set as popover |

#### Primary (shadcn-neutral inversion - an emphasis surface, not a chromatic hue)

| Token | Light (OKLCH) | Light hex | Dark (OKLCH) | Dark hex | Usage |
| --- | --- | --- | --- | --- | --- |
| `--primary` | `0.24 0.006 265` (44) | `#1e1f22` | `0.92 0.004 265` (202) | `#e3e4e7` | Button `default` fill; Switch ON track; Checkbox `accent-primary`; Toast action link; Badge `primary` tone |
| `--primary-foreground` | `0.985 0.001 265` (45) | `#fafafb` | `0.205 0.006 265` (203) | `#16171a` | Button `default` label; Switch thumb when ON |

#### Supporting surfaces

| Token | Light (OKLCH) | Light hex | Dark (OKLCH) | Dark hex | Usage |
| --- | --- | --- | --- | --- | --- |
| `--secondary` | `0.965 0.003 265` (48) | `#f2f3f5` | `0.255 0.004 265` (205) | `#222325` | Button `secondary`; active pill in NavTabs `pill`; TagInput chips |
| `--secondary-foreground` | = foreground (49) | `#1e1f22` | = foreground (206) | `#fafafb` | Button `secondary` label |
| `--muted` | `0.965 0.003 265` (50) | `#f2f3f5` | `0.235 0.004 265` (207) | `#1d1e20` | Skeleton bar; Switch OFF track; Tabs / SegmentedSelect track; provider-icon tile; Badge `muted`; table row hover (`/40`) |
| `--muted-foreground` | `0.475 0.008 265` (51) | `#5a5c61` | `0.712 0.008 265` (208) | `#a0a2a7` | All secondary text, placeholders, chart axis labels + gridlines, table column headers, icon-button rest color |
| `--accent` | `0.965 0.004 265` (52) | `#f2f3f6` | `0.255 0.006 265` (209) | `#212326` | The single hover/active wash across buttons, menus, combobox, nav tabs, masked-secret, etc. |
| `--accent-foreground` | `0.24 0.006 265` (53) | `#1e1f22` | = foreground (210) | `#fafafb` | Exactly one usage: the highlighted CommandPalette result (`CommandPalette.tsx:160`) |

#### Semantic status

| Token | Light (OKLCH) | Light hex | Dark (OKLCH) | Dark hex | Usage |
| --- | --- | --- | --- | --- | --- |
| `--destructive` | `0.52 0.2 25` (56) | `#c21725` | `0.665 0.19 25` (212) | `#f25855` | Destructive buttons; Badge `err`; Banner `error`; required marker; field error text; `aria-invalid` border; Toast error icon; sidebar `denied` token dot |
| `--destructive-foreground` | `0.985 0.005 25` (57) | `#fdf9f8` | `0.205 0.04 25` (213) | `#280e0c` | Destructive button / solid badge label |
| `--success` | `0.48 0.13 155` (58) | `#00723b` | `0.72 0.15 155` (214) | `#43c07a` | Badge `ok`; Toast success icon; copied check; sidebar `ok` token dot |
| `--success-foreground` | `0.985 0.005 155` (59) | `#f8fbf9` | `0.18 0.04 155` (215) | `#021709` | Solid success badge label |
| `--warning` | `0.52 0.11 70` (60) | `#8f5d14` | `0.8 0.13 82` (216) | `#e7b551` | Badge `warn`; Banner `warn`; PEM hint |
| `--warning-foreground` | `0.985 0.005 80` (61) | `#fcfaf6` | `0.24 0.04 82` (217) | `#291d07` | Solid warn badge label |
| `--info` | `0.5 0.15 255` (62) | `#1762b6` | `0.68 0.13 250` (218) | `#549de5` | Badge `info`; Banner `info`; Toast info icon; EmptyState `tone="info"` icon |
| `--info-foreground` | `0.985 0.005 250` (63) | `#f8fafd` | `0.17 0.04 250` (219) | `#021020` | Solid info badge label |

Deliberate hue note: light `--warning` is hue 70 while `--warning-foreground` is
hue 80; dark uses hue 82 for both (`DESIGN.md:62-63`, "amber 70 to 82").

#### Lines and focus

| Token | Light (OKLCH) | Light hex | Dark (OKLCH) | Dark hex | Usage |
| --- | --- | --- | --- | --- | --- |
| `--border` | `0.92 0.004 265` (66) | `#e3e4e7` | `0.27 0.006 265` (221) | `#252629` | Global `* { border-color: var(--border) }` hairline default (`index.css:8-10`) plus explicit borders |
| `--input` | `0.89 0.004 265` (67) | `#d9dbdd` | `0.3 0.006 265` (222) | `#2c2e31` | Every field border; Button `outline`; Checkbox; Switch OFF border |
| `--ring` | `0.55 0.15 255` (68) | `#2971c6` | `0.62 0.13 252` (223) | `#4589d2` | **Global focus ring only** (`index.css:29-32`). No `bg-ring` anywhere - the accent-blue-is-never-a-fill rule holding |

#### Chart family

Consumed only through literal Tailwind classes (`text-chart-1..5`,
`bg-chart-1..5`) in `chart.tsx`; dynamic `text-chart-${n}` is forbidden because
the Tailwind JIT would purge it (verified: no dynamic chart-class construction
exists). Contrast figures are declared in `DESIGN.md` (see 8.3).

| Token | Light (OKLCH) | Light hex | Dark (OKLCH) | Dark hex | Role |
| --- | --- | --- | --- | --- | --- |
| `--chart-1` | `0.52 0.15 255` (71) | `#1f68bc` | `0.66 0.14 252` (225) | `#4b95e5` | blue |
| `--chart-2` | `0.52 0.14 155` (72) | `#007f43` | `0.72 0.15 155` (226) | `#43c07a` | green |
| `--chart-3` | `0.6 0.12 70` (73) | `#ad721c` | `0.8 0.13 82` (227) | `#e7b551` | amber |
| `--chart-4` | `0.52 0.2 25` (74) | `#c21725` | `0.665 0.19 25` (228) | `#f25855` | red |
| `--chart-5` | `0.5 0.18 300` (75) | `#7541b8` | `0.62 0.16 300` (229) | `#966cd7` | violet |

#### Sidebar family

| Token | Light (OKLCH) | Light hex | Dark (OKLCH) | Dark hex | Usage |
| --- | --- | --- | --- | --- | --- |
| `--sidebar` | `0.975 0.003 265` (78) | `#f6f7f9` | `0.13 0.004 265` (231) | `#070709` | Rail surface (`Sidebar.tsx:143`); always the recessed surface (darker than background in dark, lighter in light) |
| `--sidebar-foreground` | `0.24 0.006 265` (79) | `#1e1f22` | `0.8 0.006 265` (232) | `#bcbec2` | Rail text |
| `--sidebar-primary` | `0.52 0.15 255` (80) | `#1f68bc` | `0.62 0.13 252` (233) | `#4589d2` | Brand snowflake (`:154`); search focus border (`:200`); **active-nav left inset bar** `before:bg-sidebar-primary` (`:263`) |
| `--sidebar-primary-foreground` | `0.985 0.001 265` (81) | `#fafafb` | identical value (234) | `#fafafb` | **The only color token with an identical value in both themes; no code usage found** |
| `--sidebar-accent` | `0.955 0.005 265` (82) | `#eef0f4` | `0.235 0.006 265` (235) | `#1d1e21` | Search fill (`/40`); collapse/close hover; active leaf fill; leaf hover (`/60`) |
| `--sidebar-accent-foreground` | `0.24 0.006 265` (83) | `#1e1f22` | `0.985 0.001 265` (236) | `#fafafb` | Active nav label |
| `--sidebar-border` | `0.91 0.004 265` (84) | `#e0e1e4` | `0.24 0.006 265` (237) | `#1e1f22` | Rail borders |
| `--sidebar-ring` | `0.55 0.15 255` (85) | `#2971c6` | `0.62 0.13 252` (238) | `#4589d2` | Mapped to Tailwind; **zero usage in app code** |

#### Alpha / tint conventions actually used

- Soft badge: `text-<tone> bg-<tone>/16 border-<tone>/32` (`badge.tsx:7-14`).
- Solid badge: `bg-<tone> text-<tone>-foreground` - the `solid` prop exists but
  **no call site passes it** (dead prop, `badge.tsx:27`).
- Banner: `border-<tone>/32 bg-<tone>/12 text-foreground` - a 12% tint, not the
  badge's 16% (`banner.tsx:8-16`).
- Modal scrim `bg-foreground/40`; table row hover `bg-muted/40`; sidebar leaf
  hover `bg-sidebar-accent/60`.
- Chart tooltip `bg-popover/95` plus `backdrop-blur-sm` (`chart.tsx:245`) - the
  only blur in the app, contradicting `DESIGN.md:300` ("never a blur").

### 1.3 Typography

Families (`tokens.css:97-100`). No font files ship; JetBrains Mono is a
progressive enhancement that renders only where locally installed.

| Token | Value |
| --- | --- |
| `--font-family-sans` | `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif` |
| `--font-family-mono` | `"JetBrains Mono", ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` |

Size / line-height scale (`tokens.css:103-118`). The token file states "13.5px
body for high dashboard density".

| Step | font-size | px | line-height | px | Role (token comment) | Weight prescribed (`DESIGN.md:141-150`) |
| --- | --- | --- | --- | --- | --- | --- |
| 2xs | `0.6875rem` | 11 | `1rem` | 16 | micro | 500, tracking 0.02em |
| xs | `0.75rem` | 12 | `1rem` | 16 | caption | 400 |
| sm | `0.8125rem` | 13 | `1.125rem` | 18 | secondary | 400 |
| base | `0.84375rem` | **13.5** | `1.25rem` | 20 | body | 400 |
| lg | `1rem` | 16 | `1.375rem` | 22 | emphasis | 500 |
| xl | `1.125rem` | 18 | `1.5rem` | 24 | section | 600 |
| 2xl | `1.3125rem` | 21 | `1.625rem` | 26 | page title | 600, tracking -0.01em |
| 3xl | `1.6875rem` | 27 | `2rem` | 32 | display, stat | 600, tracking -0.01em |

Weights: `--font-weight-regular: 400`, `--font-weight-medium: 500`,
`--font-weight-semibold: 600` (`tokens.css:120-122`). Note `--font-weight-regular`
is inert because Tailwind's key is `--font-weight-normal`.
Tracking: `--tracking-tight: -0.01em` (titles 2xl+), `--tracking-wide: 0.02em`
(tiny labels) (`tokens.css:124-125`).

Where typography is actually applied:

| Register | Class / rule | Site |
| --- | --- | --- |
| Global body | sans family, 13.5px / 20px, antialiased | `index.css:22-25` |
| Page title | `text-2xl font-semibold tracking-tight` (`h2`) | `page-header.tsx:29` |
| Card title | `text-lg font-semibold` (`h3`); ChartCard downgrades to `text-base` | `card.tsx:37`, `ChartCard.tsx:67` |
| Dialog / Sheet title | `text-lg font-semibold` (`h2`) | `dialog.tsx:50,119`, `sheet.tsx:49` |
| Settings sub-heading | `text-sm font-semibold` (`h4`) | `helpers.tsx:98` |
| Sidebar brand | `text-base font-semibold tracking-tight` (`h1`) | `Sidebar.tsx:158` |
| Table column header | `text-xs font-medium uppercase tracking-wide text-muted-foreground` | `table.tsx:79-80` |
| StatTile value | `font-mono text-2xl font-semibold` | `stat-tile.tsx:20` |
| Sidebar / command-palette group header | `text-2xs ... uppercase tracking-wide text-muted-foreground` | `Sidebar.tsx:226`, `CommandPalette.tsx:139` |
| Form label / Button / Badge | `text-sm font-medium` / `text-sm font-medium` / `text-xs font-medium` | `label.tsx:11`, `button.tsx:60`, `badge.tsx:37` |

Notes: `font-mono` is used for all telemetry (ids, keys, latency, cost, tokens,
versions), 52 sites app-wide. `text-2xs` (11px) is used at 15 render sites.
`text-xl` (18px) and `text-3xl` (27px) have **no usage in `components/ui`** -
`StatTile` uses `text-2xl`, not the `3xl` the spec calls the "one deliberately
large figure". Because `--tracking-*` / `--font-weight-*` are declared in an
unlayered `:root` block (which beats Tailwind's `@layer theme` defaults),
`tracking-tight`/`tracking-wide` resolve to -0.01em/0.02em and
`font-medium`/`font-semibold` to 500/600.

### 1.4 Spacing scale

`tokens.css:128-137`, base unit 4px.

| Token | Value | px |
| --- | --- | --- |
| `--space-1` | `0.25rem` | 4 |
| `--space-2` | `0.5rem` | 8 |
| `--space-3` | `0.75rem` | 12 |
| `--space-4` | `1rem` | 16 |
| `--space-5` | `1.25rem` | 20 |
| `--space-6` | `1.5rem` | 24 |
| `--space-8` | `2rem` | 32 |
| `--space-10` | `2.5rem` | 40 |
| `--space-12` | `3rem` | 48 |
| `--space-16` | `4rem` | 64 |

Critical usage fact: only `--space-2` (3 refs) and `--space-4` (1 ref) are
referenced anywhere outside the token file, and all four sit in the single
`.sr-only-focusable:focus-visible` rule (`index.css:142,143,150`). The other
eight `--space-*` tokens have **zero references**. Components use Tailwind's own
`--spacing`-derived utilities (`px-5`, `gap-3`, `py-2`), which coincidentally
share the 4px base but are not driven by these tokens - the `@theme inline`
block does not map `--space-*` onto `--spacing`. De-facto conventions
(`CONVENTIONS.md:145-152`): card padding `px-5 py-4`, section gaps
`gap-4`/`gap-5`, page-section spacing `mb-5`/`mb-6`.

### 1.5 Border radii

`tokens.css:140-145`. One family from a single 6px base.

| Token | Value | px | Role | Utility usage |
| --- | --- | --- | --- | --- |
| `--radius` | `0.375rem` | 6 | base | base only (not a Tailwind key) |
| `--radius-sm` | `calc(base - 2px)` | 4 | badges, small controls | `rounded-sm` (~16 sites) |
| `--radius-md` | `= base` | 6 | buttons, inputs | `rounded-md` (~56 sites) |
| `--radius-lg` | `calc(base + 2px)` | 8 | cards, panels | `rounded-lg` (~12 sites) |
| `--radius-xl` | `calc(base + 6px)` | 12 | dialogs, sheets | `rounded-xl` x4 (`dialog.tsx:44,114`, `CommandPalette.tsx:95`) |
| `--radius-full` | `9999px` | - | pills, switch | **0 direct refs**; `rounded-full` (8 sites) resolves to Tailwind's built-in `calc(infinity * 1px)` because `--radius-full` is deliberately absent from `@theme inline` |

One outlier: a bare `rounded` at `data-table.tsx:180` (Tailwind's default
0.25rem), outside the declared 6px family.

### 1.6 Shadows

| Token | Light | Dark | Usage |
| --- | --- | --- | --- |
| `--shadow-sm` | `0 1px 2px 0 oklch(0.2 0.01 265 / 0.06)` | `0 1px 2px 0 oklch(0.03 0.006 265 / 0.5)` | Card; all fields; Switch thumb; active tab / segment |
| `--shadow-md` | `0 2px 8px -1px .../0.1, 0 1px 2px 0 .../0.06` | `0 2px 8px -1px .../0.6, 0 1px 2px 0 .../0.5` | DropdownMenu, Combobox listbox, TimeRangePicker, ColumnPicker, chart tooltip, skip-link chip |
| `--shadow-lg` | `0 8px 24px -4px .../0.16, 0 2px 6px 0 .../0.08` | `0 10px 30px -5px .../0.7, 0 4px 8px -2px .../0.5` | Dialog, ConfirmDialog, Sheet, CommandPalette, Toast, VK token-reveal dialog |

`--shadow-lg` is the **only** shadow whose geometry (not just alpha) differs by
theme - the dark ramp is deeper. The self-referential mapping
`--shadow-sm: var(--shadow-sm)` etc. (`tokens.css:331-334`) is the shadcn-v4
`@theme inline` convention: the literal `var(...)` text is substituted so the
value re-resolves per theme at runtime.

### 1.7 Layout and control metrics

`tokens.css:148-170`.

| Token | Value | px | Where used |
| --- | --- | --- | --- |
| `--border-w` | `1px` | 1 | **0 refs** (components use Tailwind `border`) |
| `--ring-w` | `2px` | 2 | `index.css:30`; `table.tsx:25` |
| `--ring-offset` | `2px` | 2 | `index.css:31` |
| `--control-h-sm` | `1.875rem` | 30 | Button `sm`/`icon-sm`, dense rows |
| `--control-h` | `2.125rem` | 34 | Default control height (Button, Input, Select, Combobox, ...) |
| `--control-h-lg` | `2.625rem` | 42 | **0 refs** (Button has no `lg` size) |
| `--tap-target` | `2.75rem` | 44 | `.hit-target::after` (`index.css:87,88`) |
| `--sidebar-width` | `15rem` | 240 | `Sidebar.tsx:145,148` |
| `--sidebar-width-icon` | `3rem` | 48 | `Sidebar.tsx:148` |
| `--container-max` | `110rem` | 1760 | content wrapper (`App.tsx:315`); raised from 78rem so dense tables stop scrolling horizontally inside unused whitespace |
| `--measure-max` | `60rem` | 960 | `.measure` and `.field-grid > .field-wide` (`index.css:51,74`); caps prose and single-column forms so a label is not a screen from its input |
| `--gutter` | `1.5rem` | 24 | page gutter, `px-(--gutter)` on `<main>` (`App.tsx:311`); tightens to `1rem` at `<= 48rem` (`index.css:39-43`) |
| `--opacity-disabled` | `0.5` | - | **0 refs**; components hardcode `opacity-50` (value matches, token does not drive it) |

### 1.8 Motion

`tokens.css:172-180`. Motion is feedback-only; there is no decorative animation.

| Token | Value | Refs in code |
| --- | --- | --- |
| `--motion-fast` | `100ms` | ~21 (hover/focus/press feedback on Button, menus, tabs, toggles, ...) |
| `--motion-default` | `150ms` | 5 (Switch, Collapsible, sidebar drawer slide) |
| `--motion-slow` | `220ms` | **0 refs** |
| `--motion-spin` | `800ms` | 1 (`spinner.tsx:9`) |
| `--motion-ease-out` | `cubic-bezier(0.2,0,0,1)` | 0 direct (mapped to Tailwind `--ease-out`, unused) |
| `--motion-ease-in-out` | `cubic-bezier(0.4,0,0.2,1)` | 2 (the two keyframes) |
| `--motion-rise` | `-2px` | **0 refs** |
| `--motion-enter` | `8px` | **0 refs** |

Reduced motion (`tokens.css:250-258`) collapses fast/default/slow/rise/enter to
`0ms`/`0px`; `--motion-spin` is deliberately not collapsed (the spinner instead
carries `motion-reduce:animate-none`). Two keyframes exist app-wide:
`.skeleton-pulse` (live) and `.stream-pulse` (dead CSS - never applied; the live
indicator is a spinning lucide `RefreshCw`). **Overlays (Dialog, ConfirmDialog,
Sheet, CommandPalette) have no enter/exit animation at all** - they appear
instantly. The only overlay motion is the sidebar drawer slide.

### 1.9 Z-index layers

`tokens.css:182-186`. Consumers use the Tailwind arbitrary-variable form
`z-(--z-*)`.

| Token | Value | Sites (complete) |
| --- | --- | --- |
| `--z-sticky` | 20 | sticky `<thead>` (`data-table.tsx:142`); sticky provider config footer (`ProviderConfigPanel.tsx:370`) |
| `--z-overlay` | 40 | DropdownMenu panel, Combobox listbox, TimeRangePicker menu, ColumnPicker popover, mobile nav scrim |
| `--z-modal` | 50 | Dialog, ConfirmDialog, Sheet, CommandPalette, the whole sidebar `<aside>` (neutralised on md+ by `md:z-auto`), VK token-reveal alertdialog |
| `--z-toast` | 60 | Toast stack; focused skip-link chip |

### 1.10 Tailwind v4 `@theme inline` mapping

Block at `tokens.css:264-339`, loaded via `@import "tailwindcss"` then
`@import "./styles/tokens.css"` (`index.css:4-5`). **65 entries**, no config
file:

- **38 colors** (`:266-303`): `--color-X: var(--X)` for every surface, primary,
  supporting, semantic, line, `chart-1..5`, and sidebar token. This is what
  makes `bg-card`, `text-muted-foreground`, `border-input`, `text-chart-3`,
  `bg-success/16` resolve.
- **18 typography** (`:305-323`): `--font-sans`, `--font-mono`, and
  `--text-<step>` + `--text-<step>--line-height` pairs. `--text-2xs` is a custom
  step Tailwind does not ship.
- **4 radius** (`:325-329`): sm/md/lg/xl only; `--radius-full` intentionally
  absent.
- **3 shadows** (`:331-334`), self-referential.
- **2 easings** (`:336-338`), neither utility used.

Everything else (`--space-*`, `--font-weight-*`, `--tracking-*`, `--control-h*`,
`--tap-target`, `--sidebar-width*`, `--container-max`, `--measure-max`,
`--gutter`, `--motion-*`, `--z-*`, raw `--font-size-*`) is deliberately **not**
mapped and is reached through Tailwind v4's arbitrary-variable syntax
`utility-(--token)` (which compiles to `var(--token)`), e.g. `h-(--control-h)`,
`z-(--z-modal)`, `duration-(--motion-fast)`, `w-(--sidebar-width)`,
`px-(--gutter)`, `max-w-(--container-max)`.

### 1.11 Iconography

- **Library: `lucide-react ^1.25.0` only**, imported by name (never a `size`
  prop; sizing is by Tailwind class - `size-4` dominates). The `LucideIcon`
  type is the prop type for icon-valued props.
- **Documented owner-granted exception**: `components/ui/provider-logos.tsx`
  (601 lines) holds **28 hand-rolled inline-SVG brand marks** plus a shared
  `Svg` shell, a `ChipSvg` light-chip wrapper, and a `Monogram` helper. Its only
  exports are the `LogoProps` type, `providerLogo(key)` (`:591`, returns `null`
  for any `*-compatible` key), and `PROVIDER_LOGO_KEYS` (`:601`); the `LOGOS`
  map (`:530`) and the 21-entry `ALIASES` map (`:562`) are module-private.
  Marks bake in the brand's own colors (~60
  hardcoded hex literals), never `currentColor`; all are inline and
  same-origin - no `<img>`, no remote URL. This file is the only source of
  hardcoded color in `components/ui`.
- `ProviderIcon` resolution order (`provider-icon.tsx:101-146`): brand logo by
  explicit `logoKey`, then brand logo by `provider`, then a neutral lucide glyph
  from `PROVIDER_GLYPHS` (20 entries), then `Blocks` when `custom`, then an
  initials avatar. A matched brand logo renders on a plain tile; glyph/initials
  keep a bordered `bg-muted` tile.

---

## 2. Layout and responsive behavior

### 2.1 Shell

The shell is composed in `App.tsx:255-334` from three parts:

- **`App.tsx`** - the composition root: `ToastProvider` wraps a
  `flex h-screen overflow-hidden` outer div containing a skip link, a mobile
  scrim, the `Sidebar`, and a content column.
- **`Sidebar`** (`shell/Sidebar.tsx`) - the nav rail (brand, collapse toggle,
  search, grouped leaves, admin-token + theme footer), a sibling of the content
  column with its own scrollable `<nav>`.
- **`PageHeader`** (`ui/page-header.tsx`) - rendered as the first element of
  every view; its `h2` is the focus target on navigation.

The scroll container is `<main id="main" tabIndex={-1}>`
(`overflow-y-auto py-6 px-(--gutter)`, `App.tsx:311`), not the document - the
outer div is `h-screen overflow-hidden`. Content is centred and capped at
`--container-max` (110rem / 1760px). A remount key `key={view:authNonce}`
(`App.tsx:313`) forces a
full remount of the active view when the admin token changes, re-firing every
fetch. `AdminTokenDialog` and `CommandPalette` render outside the flex shell
(fixed). The only React portal in the app is `DropdownMenu`, which portals its
panel to `document.body` with fixed positioning so no `overflow` ancestor can
clip it; Dialog/Sheet/CommandPalette use plain `position: fixed` inline.

### 2.2 Grid and flex systems

There is no grid framework; layout is Tailwind flex/grid utilities.

- **Shell**: flex row (rail + content column), each column `flex-col`.
- **Master/detail**: `ui/two-pane.tsx` -
  `flex min-h-0 flex-col md:flex-row md:items-stretch`, rail width injected as a
  local `--rail-w` custom property seeded from `listWidth` and then driven by a
  draggable `role="separator"` handle between the panes (pointer drag +
  Arrow/Home/End keys, clamped to `minListWidth`/`maxListWidth`, persisted under
  `storageKey`). Used by **ProvidersView only**. The `aside` carries
  `overflow-hidden` (`two-pane.tsx`): without it, a rail row whose intrinsic
  content exceeds the current width paints its trailing badges outside the rail
  and on top of the detail pane. Callers pair it with `shrink-0` on the badge
  cluster, which turns a crowded row into a truncation problem instead of an
  overlap one; the resizer then lets the operator widen the rail to read the
  full content. Locked by `two-pane.overflow.test.tsx`.
- **Card grids**: `grid gap-4` + responsive `grid-cols-*` (dashboard, status,
  catalog, logs KPI rows).
- **Form grids**: the codified pattern is **`.field-grid`**
  (`index.css:64-69`, `CONVENTIONS.md:76-83`) -
  `repeat(auto-fit, minmax(min(100%, 16rem), 22rem))`, as many columns as fit
  with each capped at 22rem, plus `.field-wide` for fields that need the whole
  row. `CONVENTIONS.md:78-80` explicitly says "Do NOT go back to
  `sm:grid-cols-2`". Call sites use it: `AddCustomProviderForm.tsx`,
  `AddProviderForm.tsx:131`, `CachingPanel.tsx:163,196`,
  `SecurityPanel.tsx:134`, `ExtensionsView.tsx:339`.
- **Tables**: `ScrollContainer` (`table.tsx:13-33`) wraps every table in
  `w-full overflow-x-auto rounded-lg` with an optional inline `minWidth` -
  horizontal scroll rather than card reflow, a deliberate density trade-off.

### 2.3 Breakpoints (exact and exhaustive)

Tailwind v4 defaults, **not overridden anywhere** (no `--breakpoint-*`, no
config, no `screens` key): `sm` 640px, `md` 768px, `lg` 1024px, `xl` 1280px.
Exhaustive occurrence counts across `src/**/*.tsx`: **md 42, sm 18, lg 3, xl 6,
2xl 0.** `md` is the only structural breakpoint; `sm` is almost entirely
form-grid and filter-width tuning; `lg`/`xl` only widen dashboard/status card
grids.

| Prefix | Effect | Site |
| --- | --- | --- |
| `md:hidden` | mobile nav scrim and mobile top bar disappear at >=768px | `App.tsx:261,280` |
| `md:static md:z-auto md:translate-x-0 md:transition-[width]` | sidebar stops being an off-canvas drawer and becomes an in-flow column | `Sidebar.tsx:147` |
| `md:w-(--sidebar-width-icon)` / `md:w-(--sidebar-width)` | 3rem icon rail vs 15rem expanded, desktop only; below md the rail is always 15rem | `Sidebar.tsx:148` |
| `md:sr-only` | brand `h1`, leaf labels, admin-token label become screen-reader-only in the collapsed rail | `Sidebar.tsx:159,272,299` |
| `md:grid` / `md:hidden` | collapse toggle is desktop-only; mobile "Close navigation" X is mobile-only | `Sidebar.tsx:168,178` |
| `md:flex-row ...` | TwoPane stacks below md, side-by-side at md+ with a draggable rail; below md exactly one pane renders and the resizer is hidden | `two-pane.tsx` |
| `md:grid-cols-[18rem_1fr]` / `md:grid-cols-[14rem_1fr]` | zero-provider layout / logs facet rail go 2-column at md+ | `ProvidersView.tsx:673`, `LogsView.tsx:323` |
| `md:grid-cols-2 xl:grid-cols-3` | dashboard chart grids 1 -> 2 -> 3 columns | `DashboardView.tsx:217,...` |
| `md:grid-cols-3 xl:grid-cols-6` | status KPI tiles 2 -> 3 -> 6 columns (traffic row and the Runtime row) | `StatusView.tsx:241`, `StatusView.tsx:423` |
| `lg:grid-cols-4` / `sm:grid-cols-3 lg:grid-cols-5` | catalog KPI tiles / logs KPI row | `ModelCatalogView.tsx:195`, `LogsAnalytics.tsx:60` |

Every file in `components/ui/` **except `two-pane.tsx`** has zero responsive
behavior; they adapt via `max-w-*` + `w-full` + `flex-wrap` + `overflow-x-auto`,
never media queries. `Sheet` is `w-full max-w-[28rem]` (full-bleed only below
448px, no `sm:` class). `DataTable` density is preserved by horizontal scroll
plus per-view `minWidth` ("60rem" Logs/Virtual Keys, "52rem" Model Catalog/Teams,
"44rem" Customers, "36rem" Pricing).

### 2.4 Sidebar layout modes (four states)

| Mode | Trigger | Geometry |
| --- | --- | --- |
| Mobile drawer, closed | viewport < md, `mobileOpen === false` | `fixed inset-y-0 left-0 w-(--sidebar-width)` + `-translate-x-full`, `z-(--z-modal)` |
| Mobile drawer, open | hamburger sets `mobileNavOpen` | `translate-x-0`; scrim behind; scrim click or any `onNavigate` closes it |
| Desktop expanded | viewport >= md, `collapsed === false` | `md:static md:w-(--sidebar-width)` = 240px |
| Desktop icon rail | viewport >= md, `collapsed === true` | `md:w-(--sidebar-width-icon)` = 48px; brand/labels `md:sr-only`, all groups force-open, leaves gain `title={label}` |

Collapse state persists in `localStorage["frosty.sidebar"]` as
`"rail"`/`"expanded"` (read/write both try/caught). Rail vs expanded animates
via `md:transition-[width]`; the drawer slides via
`transition-transform duration-(--motion-default)`.

---

## 3. Component inventory

`apps/control-ui/src/components/ui/` holds **40 primitive source files** (39
`.tsx` + `use-modal.ts`), of which **16 have colocated tests and 24 do not**
(16 components across 17 test files: `two-pane` carries two). There is no
barrel/index file - every consumer imports by explicit
relative path, and all import `cn` from `../../lib/utils`.

### 3.1 Primitives (`src/components/ui/`)

| # | Component(s) | File | Purpose | Key props | Used by |
| --- | --- | --- | --- | --- | --- |
| 1 | `Badge` | `badge.tsx` | Status pill | `tone?` (default `muted`); `solid?` (never passed) | LogsTable, ProviderConfigPanel, SecurityPanel, facet-rail, provider-icon, lib/governance, and 5 views |
| 2 | `Banner`, `ErrorBanner` | `banner.tsx` | Page/card message | `tone: info/warn/error`, `action?`; `role="alert"` for error, `status` otherwise | App (401), AddProvider/Custom, ProviderConfigPanel, SecurityPanel, 12 views |
| 3 | `Button` | `button.tsx` | Primary control | `variant?` (6), `size?` (4), `isLoading?` (prepends Spinner) | 22 files incl. 10 views |
| 4 | `Card`, `CardHeader`, `CardTitle`, `CardContent` | `card.tsx` | Raised surface + slots | plain HTML attrs | ChartCard, LogsAnalytics, settings panels, stat-tile, 9 views |
| 5 | `Chart`, `ChartLegend` | `chart.tsx` | Dependency-free SVG chart | `type: line/bar`, `series`, `ariaLabel` (required), `unit?` | ChartCard, LogsAnalytics, lib/analytics, dashboard/adapters |
| 6 | `Checkbox` | `checkbox.tsx` | Native checkbox (`accent-primary`, no custom indicator) | `Omit<InputHTMLAttributes,"type">` | ColumnPicker, facet-rail, lib/governance |
| 7 | `Collapsible` | `collapsible.tsx` | Disclosure | `title`, `defaultOpen?`, controlled/uncontrolled | LogsFacetRail, CodeModeVfsPreview, facet-rail |
| 8 | `Combobox` | `combobox.tsx` | Searchable single-select | `options`, `value: string\|null`, `onChange`, `label` | dashboard/adapters, ProviderConfigPanel, CachingPanel, McpPanel, 3 views |
| 9 | `CopyButton` | `copy-button.tsx` | Clipboard copy, 2s confirm | `value`, `label?` | masked-secret, ConfigPanel, VirtualKeysView |
| 10 | `DataTable<T>` | `data-table.tsx` | Generic sortable/paginated table | `columns`, `rows`, `getRowId`, `caption` (required), `pageSize?`, `rowMenu?`, `stickyHeader?` | LogsTable, ProviderConfigPanel, 4 views |
| 11 | `Dialog`, `ConfirmDialog` | `dialog.tsx` | Modal / alert dialog | Dialog `role="dialog"` overlay-dismissible; ConfirmDialog `role="alertdialog"`, overlay does NOT dismiss, `destructive?` default true | AddProvider/Custom, AdminToken, 7 views |
| 12 | `DropdownMenu` | `dropdown-menu.tsx` | Kebab / row-actions menu | `items`, `label`, `align?`; panel portalled to `document.body` | LogsView, ProvidersView |
| 13 | `EmptyState` | `empty-state.tsx` | Zero-data placeholder | `icon`, `title`, `body`, `action?`, `tone?` | 7 views |
| 14 | `ExportButton<T>` | `export-button.tsx` | Client-side CSV download | `rows`, `columns`, `filename`; self-disables when empty | DashboardView, VirtualKeysView |
| 15 | `FacetRail` (+ `FacetSearch`, `FacetCheckbox`) | `facet-rail.tsx` | Collapsible checkbox facet groups | `groups`, `value`, `onChange` | LogsFacetRail |
| 16 | `Input`, `Textarea` | `input.tsx` | Text field primitives | plain attrs; shared `FIELD_CLASSES` incl. `aria-invalid:border-destructive` | 19 files |
| 17 | `KeyValueRows` | `key-value-rows.tsx` | Repeatable Name/Value editor | `value`, `onChange`, `valueInputType?` | ProviderConfigPanel |
| 18 | `Label`, `Field` | `label.tsx` | Label + control + hint/error stack | `Field{id,label,required?,error?,hint?}`; hint/error mutually exclusive | 17 files |
| 19 | `maskSecret`, `MaskedSecret`, `MaskedSecretCell` | `masked-secret.tsx` | Reveal/copy secret display | constant 10-dot mask so length never leaks | VirtualKeysView |
| 20 | `NavTabs`, `SubTabs`, `UnderlineTabs` | `nav-tabs.tsx` | View-level tab bars | `value`, `tabs`, `label`, `variant?` | ProviderConfigPanel, DashboardView, ExtensionsView, SettingsView |
| 21 | `NumberField` | `number-field.tsx` | Numeric config field | emits raw string (empty stays representable); `unit?` overlay | ProviderConfigPanel |
| 22 | `PageHeader` | `page-header.tsx` | Screen header + focus target | `title`, `subtitle?`, `actions?`; `h2 tabIndex={-1}` | **all 11 views** |
| 23 | `isLikelyPem`, `PemTextarea` | `pem-textarea.tsx` | Monospace PEM editor | non-blocking `aria-invalid` + `text-warning` hint | ProviderConfigPanel |
| 24 | `providerGlyph`, `initialsFrom`, `ProviderIcon`, `Avatar`, `CustomBadge` | `provider-icon.tsx` | Provider identity tile | `provider`, `logoKey?`, `custom?`, `size?` | AddProviderDialog, ProviderConfigPanel, ModelCatalogView, ProvidersView |
| 25 | `providerLogo`, `PROVIDER_LOGO_KEYS` (28 marks, module-private) | `provider-logos.tsx` | Full-color inline-SVG brand marks (owner-granted) | `LogoProps`; 21 aliases | `provider-icon.tsx` only |
| 26 | `SegmentedSelect<T>` | `segmented-select.tsx` | Inline 2-3 option radio group | `options`, `value`, `onChange`, `label`; arrows move and select | ProviderConfigPanel |
| 27 | `NativeSelect` | `select.tsx` | The only select in the app | `appearance-none` + `ChevronDown` overlay | AddCustom/AddProvider, lib/governance, ConfigPanel, ExtensionsView, TeamsView, VirtualKeysView |
| 28 | `Sheet` | `sheet.tsx` | Right-side edit panel | `open`, `onClose`, `title`; `w-full max-w-[28rem]` | ExtensionsView (edit MCP), VirtualKeysView (create/edit) |
| 29 | `Skeleton`, `TableSkeleton`, `TileSkeleton`, `PanelSkeleton` | `skeleton.tsx` | Loading placeholders | composites are `aria-hidden` | CodeModeVfsPreview, data-table, stat-tile, 8 views |
| 30 | `Spinner` | `spinner.tsx` | Loading glyph | lucide `LoaderCircle`, `animate-spin`, `aria-hidden` | **`button.tsx` only** (a bare spinner page is structurally impossible) |
| 31 | `StatTile` | `stat-tile.tsx` | Overview metric tile | `label`, `value`, `caption?`, `loading?`; value `font-mono text-2xl` | LogsAnalytics, ModelCatalogView, StatusView |
| 32 | `Switch` | `switch.tsx` | Boolean toggle | `role="switch"` on a `<button>` | AddCustom, ProviderConfigPanel, settings helpers, toggle-grid-item, 5 views |
| 33 | `ScrollContainer`, `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`, `TableCaption` | `table.tsx` | Presentational table primitives | `ScrollContainer` is `role="group"` + tabbable; real `<caption>` | data-table + 5 views hand-rolling tables |
| 34 | `Tabs`, `tabPanelProps` | `tabs.tsx` | Segmented tablist on a muted track | **`Tabs` is never rendered anywhere**; only `tabPanelProps` and the `TabItem` type are consumed | ProviderConfigPanel, DashboardView, SettingsView (via `tabPanelProps`) |
| 35 | `TagInput` | `tag-input.tsx` | Chip editor for string lists | Enter/`,`/blur commit; duplicates rejected | SecurityPanel |
| 36 | `TimeRangePicker`, `DEFAULT_TIME_RANGES` | `time-range-picker.tsx` | Range menu button | defaults `1h`/`24h`/`7d`; `role="menu"` + `menuitemradio` | DashboardView, LogsView |
| 37 | `ToastProvider`, `useToast`, ... | `toast.tsx` | Transient notifications | `success/error/info`; auto-dismiss 5000ms (6000ms with action); `useToast()` returns a no-op API outside a provider | App + AdminTokenDialog + 10 views |
| 38 | `ToggleGridItem` | `toggle-grid-item.tsx` | Labelled switch tile | `label`, `checked`, `onCheckedChange`, `onSettings?` | AddCustomProviderForm |
| 39 | `TwoPane` | `two-pane.tsx` | Master/detail layout; draggable rail (clips via `overflow-hidden`) | `list`, `detail`, `listWidth?`, `minListWidth?`, `maxListWidth?`, `storageKey?`, `listLabel?`, `detailLabel?`, `detailActiveOnMobile?`, `className?` | **ProvidersView only** |
| 40 | `useModal` (hook) | `use-modal.ts` | Focus trap + scroll lock | `useModal(open, onClose, dismissible, initialFocus?)`; capture-phase keydown; restores focus on cleanup | dialog (x2), sheet, CommandPalette, VK token reveal |

**Kit test coverage (16 components across 17 test files, of 40 source
files):** `collapsible`, `combobox`, `data-table`, `dropdown-menu`,
`export-button`, `facet-rail`, `key-value-rows`, `masked-secret`, `nav-tabs`,
`number-field`, `pem-textarea`, `provider-icon`, `segmented-select`,
`time-range-picker`, `toggle-grid-item`, `two-pane` (two files:
`two-pane.test.tsx` and `two-pane.overflow.test.tsx`). The 24 untested
include the entire focus-trap machinery (`use-modal`), `dialog`,
`sheet`, `button`, `input`, `toast`, `table`, and `chart`.

### 3.2 Composites (feature components)

| Component | Location | Purpose | Used by |
| --- | --- | --- | --- |
| `Sidebar` (+ `NavItem`) | `shell/Sidebar.tsx` | Nav rail: brand, collapse, search, grouped leaves, admin-token + theme footer | App |
| `CommandPalette` | `shell/CommandPalette.tsx` | Cmd/Ctrl-K overlay that navigates between views | App |
| `AdminTokenDialog` | `shell/AdminTokenDialog.tsx` | Enter / clear the admin bearer token | App |
| `ChartCard` | `dashboard/ChartCard.tsx` | Analytics card: title, filter slot, bar/line toggle, legend, x-ticks, auto-empty | DashboardView |
| `adapters` (13 exports) | `dashboard/adapters.ts` | Rollup -> ChartSeries / ComboboxOption / CsvColumn conversion | DashboardView |
| `LogsKpiRow`, `RequestVolumeCard` | `logs/LogsAnalytics.tsx` | Logs KPI tiles + collapsible request-volume chart | LogsView |
| `LogsTable` (+ `LiveBar`) | `logs/LogsTable.tsx` | Logs `DataTable` + the `aria-live` live-connection bar | LogsView |
| `LogsFacetRail` | `logs/LogsFacetRail.tsx` | Outcome facets, honest-empty facet shells | LogsView |
| `ColumnPicker` | `logs/ColumnPicker.tsx` | Disclosure of column checkboxes (last visible cannot be unchecked) | LogsView |
| `logs-model` (17 exports) | `logs/logs-model.ts` | Pure logs domain model (outcome, columns, windows, formatters) | LogsView + logs composites |
| `AddProviderDialog` | `providers/AddProviderDialog.tsx` | Vendor gallery: 27 filterable preset cards + Custom escape hatch | ProvidersView |
| `AddProviderForm` | `providers/AddProviderForm.tsx` | Create-provider form incl. Azure / Bedrock / Vertex branches | ProvidersView |
| `AddCustomProviderForm` | `providers/AddCustomProviderForm.tsx` | Bring-your-own provider (inline in the detail pane) + advisory request-type grid | ProvidersView |
| `ProviderConfigPanel` | `providers/ProviderConfigPanel.tsx` | 6-tab deep provider config, per-group diffing, sticky footer | ProvidersView |
| `SecretReenter` | `providers/SecretReenter.tsx` | Write-only secret field ("Configured" marker + Replace) | ProvidersView, ProviderConfigPanel, SecurityPanel |
| `constants` (17 exports) | `providers/constants.ts` | Provider taxonomy, **`PROVIDER_PRESETS` (27 presets)**, locked option lists | provider components |
| `SecurityPanel` | `settings/SecurityPanel.tsx` | Settings > Security | SettingsView |
| `CompatibilityPanel` | `settings/CompatibilityPanel.tsx` | Settings > Compatibility | SettingsView |
| `CachingPanel` | `settings/CachingPanel.tsx` | Settings > Caching: semantic-cache config plus the Operations block | SettingsView |
| `CacheOpsPanel` | `settings/CacheOpsPanel.tsx` | Cache invalidation ops (purge all / purge one entry), formerly the Cache view | CachingPanel |
| `ConfigPanel` | `settings/ConfigPanel.tsx` | Settings > Config: default provider, export/import/reload, formerly the Config view; owns its own load and error state | SettingsView |
| `PerformancePanel` | `settings/PerformancePanel.tsx` | Settings > Performance | SettingsView |
| `McpPanel` | `settings/McpPanel.tsx` | Settings > MCP incl. Code Mode binding preview | SettingsView |
| `CodeModeVfsPreview` | `settings/CodeModeVfsPreview.tsx` | Read-only VFS tree + per-file source viewer (React text only) | McpPanel |
| settings `helpers` (17 exports) | `settings/helpers.tsx` | Shared coercers, provenance (`SourceTag`/`EnvHint`), `PanelFooter`, `NumberCard` | all five settings panels |
| `lib/governance` (18 exports) | `lib/governance.tsx` | Shared budget / limit sub-forms and money formatters | TeamsView, CustomersView, VirtualKeysView |

### 3.3 Page-level components (views)

All 11 render `PageHeader` as their first element.

| View | File | Route |
| --- | --- | --- |
| `DashboardView` | `views/DashboardView.tsx` | `#/dashboard` |
| `LogsView` | `views/LogsView.tsx` | `#/logs` |
| `ProvidersView` | `views/ProvidersView.tsx` | `#/providers` (default) |
| `ModelCatalogView` | `views/ModelCatalogView.tsx` | `#/model-catalog` |
| `ExtensionsView` | `views/ExtensionsView.tsx` | `#/extensions` |
| `VirtualKeysView` | `views/VirtualKeysView.tsx` | `#/virtual-keys` |
| `TeamsView` | `views/TeamsView.tsx` | `#/teams` |
| `CustomersView` | `views/CustomersView.tsx` | `#/customers` |
| `PricingView` | `views/PricingView.tsx` | `#/pricing` |
| `SettingsView` | `views/SettingsView.tsx` | `#/settings`, `#/settings/<sub>` |
| `StatusView` | `views/StatusView.tsx` | `#/status` |

Cache and Config are no longer views. Cache invalidation is `Settings > Caching`
(the "Operations" block below the save footer,
`components/settings/CacheOpsPanel.tsx`); raw config export/import/reload is
`Settings > Config` (`components/settings/ConfigPanel.tsx`). The legacy hashes
`#/cache` and `#/config` are rewritten by `REDIRECTS` in `App.tsx:81-84`.

---

## 4. Screens and views

Data sources cite the `src/api.ts` client function and its exact endpoint.
`api.ts` exports **55 functions** (48 HTTP endpoint clients + 7 auth/transport
helpers), **1 class (`ApiError`)**, and **37 types/interfaces**. All view
transport goes through these clients - no `fetch` in views (verified by grep
over `views/` and `components/`). `ApiError.message` carries the gateway's
canonical `error.message` verbatim.

### 4.1 `#/dashboard` - Dashboard

- **Purpose**: analytics rollup over a selectable window. Renders explicit "not
  recorded yet" cards for dimensions the gateway does not track, rather than
  hiding them.
- **Header**: title `Dashboard`, no subtitle; actions = section-aware
  `ExportButton`, `TimeRangePicker`, and an icon button
  `aria-label="Reload analytics"`.
- **Sections** (`SubTabs`, pill): `overview` (default), `provider-usage`,
  `model-rankings`, `mcp-usage`, `user-rankings`. Time range `1h`/`24h`/`7d`,
  default `24h`, 12 buckets.
- **Data**: `getAnalytics(range)` -> `GET /api/analytics?window=<range>` (404 ->
  untracked empty rollup; any rejection degrades silently to `rollup = null`);
  `getStoredLogs({limit:500})` -> `GET /api/logs/stored?limit=500` (404 sets
  store off, else error banner); `ensureEurRate()` -> `GET /api/config`.
- **Cards**: Request Volume (bar), Token Usage (bar, with a flat-zero "Cached"
  series for legend parity), External/Local Cache Hit Rate (hardcoded empty),
  Cost (bar, EUR), Model Usage (bar), Latency (line, derived client-side from
  stored logs). Provider Usage: Provider Cost, Provider Token Usage, and a
  permanently empty Provider Latency. Model Rankings: two bar charts + a
  `DataTable` (Model / Provider / Requests / Tokens / Cost). MCP usage and User
  Rankings: permanently empty cards with section notes.
- **Actions**: change time range, switch section, per-card bar/line toggle
  (hidden when empty), per-card model/provider filter, export CSV, reload.

### 4.2 `#/providers` - Providers (default route)

- **Purpose**: manage provider accounts - create, key, enable, set default,
  refresh models, deep config, delete. The flagship view.
- **Header**: title `Providers`, subtitle "Accounts the gateway can route
  inference to"; action = an icon button
  `aria-label="Reload configuration"` (named to avoid colliding with the pinned
  nav name "Providers").
- **Data**: `getConfig()` -> `GET /api/config` (providers, defaultProvider,
  eurRate pushed into the currency module); `getProviderHealth()` ->
  `GET /api/providers/health` (fire-and-forget, never blocks the list).
- **Layout**: a `TwoPane` master/detail (left rail `ProviderList`, right pane)
  with a draggable divider (persisted rail width). A `mode` state machine
  (`add`/`custom`/`keys`/`config`); in `config` mode the whole
  two-pane is **replaced** by a full-width `ProviderConfigPanel`. Three body
  states: skeleton while loading, a two-cell zero-provider layout, and the
  normal two-pane.
- **Left rail**: each row is a button whose accessible name is the provider id,
  with a `ProviderIcon`, a traffic-light `Badge` (`disabled`/`no key`/`error`/
  `online`), a `CUSTOM` chip, a `default` star badge, and a hover/focus-revealed
  delete button. Below the list sit stacked `Add New Provider` (opens the
  gallery) and `Add Custom Provider` (opens the inline custom form) buttons.
- **Detail (ConfiguredKeys)**: a `DataTable` of API Key (dots / cloud
  credentials / no key), Weight (hardcoded `1`), Enabled (`Switch`); row kebab
  Replace API key / Make default / Refresh models / Delete provider.
- **Writes**: `createProvider` -> `POST /api/providers`; `updateProvider` ->
  `PUT /api/providers/:id`; `deleteProvider` -> `DELETE /api/providers/:id`;
  `refreshModels` -> `POST /api/providers/:id/refresh-models`;
  `setDefaultProvider` -> `PUT /api/config` `{defaultProvider}`. Every mutation
  runs through `run()` which sets `busy`, reloads on success, and on failure
  sets the page error banner plus an error toast.
- **Add gallery** (`AddProviderDialog`): 27 vendor presets as filterable cards
  (search matches displayName / key / type) plus a `Custom provider` button.

### 4.3 `#/model-catalog` - Model Catalog

- **Purpose**: read-mostly overview of configured providers, their advertised
  models, and 24h traffic/cost.
- **Header**: title `Model Catalog`, subtitle "Overview of all configured
  providers, models, and usage." No header actions.
- **Data**: `getCatalog()` -> `GET /api/catalog` (404 normalises to an empty
  catalog); `ensureEurRate()` first so money renders converted on first paint.
- **KPI tiles** (`lg:grid-cols-4`): Total Providers, Total Models, Total
  Requests (24h), Total Cost (24h, EUR at 4 dp).
- **Table**: `DataTable` "Model catalog by provider", `minWidth="52rem"`,
  columns Provider / Models (first 6 chips then `+N more`) / Total Traffic (24h)
  / Total Cost (24h). A row click opens `ProviderModelsDialog`.
- **Actions**: a provider `Combobox` filter and a per-row refresh button ->
  `POST /api/providers/:id/refresh-models` then a catalog reload (row-refresh
  failures surface only as a toast, never the page error state).
- **Model dialog** (`ProviderModelsDialog`): clicking a provider row opens a
  compact toggle grid of every model the provider advertises
  (`GET /api/providers/:id/available-models`, read-only) unioned with the
  currently-enabled set. Each tile is an on/off `Switch`; Save persists the
  enabled subset via `updateProvider` `{models}` (the set the gateway routes
  on). A search box plus Enable/Disable-all act on the filtered list; provider
  types without live listing degrade to editing their stored models.
- **Empty / error**: zero providers -> `EmptyState tone="info"`; a genuine
  transport error -> `Banner tone="error"`.

### 4.4 `#/extensions` - Extensions

- **Purpose**: register / sync MCP servers, inspect synced tools, list plugins.
- **Header**: title `Extensions`, subtitle "MCP servers, synced tools, and
  plugins"; action = an outline `Sync all` -> `POST /api/mcp/sync`.
- **Tabs** (`UnderlineTabs`): `mcp-servers` (default), `tools`, `plugins`. Card
  ids `#mcp-servers`/`#tools`/`#plugins` are in-page anchors the router
  deliberately ignores.
- **Data**: `getMCPClients()` `GET /api/mcp/clients`; `getMCPTools()`
  `GET /api/mcp/tools`; `getPlugins()` `GET /api/plugins`; `getMCPHealth()`
  `GET /api/mcp/health` polled every 30s.
- **MCP servers table** (raw `Table` primitives): ID / URL / Transport / Tools /
  Health (tone badge + `xN` failure superscript) / Last sync / Actions (Sync,
  Edit, Remove). Remove offers an **Undo** toast that re-creates the client,
  suppressed when unrestorable data (headers / command / url credentials) was
  stored.
- **Add form** (`sm:grid-cols-2`): ID (required), URL (required, `type="url"`),
  Transport (`http-sse` default / `streamable-http` / `auto`), plus an Advanced
  disclosure (timeout + repeatable password header rows). Submits
  `POST /api/mcp/clients`.
- **Edit sheet**: URL, Transport (disabled for `stdio` clients), Enabled,
  timeout, headers. Stored header values are never prefilled - saving replaces
  the whole set. Saves via `PUT /api/mcp/clients/:id`; remove via
  `DELETE /api/mcp/clients/:id`; per-row sync via
  `POST /api/mcp/clients/:id/sync`.
- **Tools tab**: Tool / Server / Description / Side effects (`read-only` vs
  `needs confirmation`). **Plugins tab**: a plain `<ul>` of names, or "No
  plugins loaded."

### 4.5 `#/logs` - Logs

- **Purpose**: faceted request-log console over two sources (live SSE stream and
  the durable stored-log history).
- **Header**: title `Logs`, subtitle "Live request stream and stored history";
  actions = a `Live` toggle button (`aria-pressed`, disabled when the store is
  off) and an icon `Refresh` button.
- **Source probe**: `getStoredLogs({limit:1})` -> `GET /api/logs/stored?limit=1`;
  a 404 sets store off, forces Live on, and shows an info banner reading
  "Stored logs are off. Set FROSTY_LOG_STORE=pg on the gateway..."
  (`LogsView.tsx:313-315`). The copy names `pg`, the live "on" value, matching
  the Postgres-backed store; the rest of the Logs copy was de-KV-ified earlier
  (`LogsView.tsx:81-82`, `:405`).
- **Live source**: `readLogStream` -> `GET /api/logs/stream` using
  fetch + ReadableStream SSE (EventSource is forbidden because it cannot carry
  the admin bearer header). Ring buffer capped at 500, duplicate-suppressed,
  exponential-backoff reconnect. State `connecting`/`streaming`/`disconnected`
  rendered by the `aria-live` `LiveBar`.
- **Stored source**: `getStoredLogs({q, limit:500})` ->
  `GET /api/logs/stored?q=...&limit=500`, debounced 300ms.
- **Facets** (`LogsFacetRail`): only Outcome is live (Success / Error /
  Processing / Cancelled with counts); "Models" is a disabled input with "Not
  recorded yet"; 12 further groups are honest-empty disclosures.
- **Toolbar**: search input, `TimeRangePicker` (default `1h`), `ColumnPicker`,
  and a "More actions" `DropdownMenu` whose only item is Clear stored logs
  (destructive, disabled while Live or when the store is off) ->
  `DELETE /api/logs/stored`, behind a `ConfirmDialog` naming the exact entry
  count.
- **Table**: `DataTable` "Request logs", `pageSize={25}`, Time desc,
  `minWidth="60rem"`. Columns Time / Type / Provider / Model / Message /
  Latency / Tokens / Status; Type/Provider/Model/Tokens render `N/A`
  `title="Not recorded"`. There is **no row-detail drawer or payload
  inspector** anywhere in the UI.

### 4.6 `#/virtual-keys` - Virtual Keys

- **Purpose**: create / edit / delete virtual keys with scope, budget, and rate
  limits. The largest view.
- **Header**: title `Virtual Keys`, subtitle "Manage virtual keys, their
  permissions, budgets, and rate limits."; actions = `ExportButton`
  (`virtual-keys.csv`) and `Add Virtual Key`.
- **Data** (all via `Promise.allSettled`): `getVirtualKeys()`
  `GET /api/virtual-keys` (the only failure that sets the error banner);
  `getTeams()` `GET /api/teams`; `getCustomers()` `GET /api/customers`;
  `getConfig()` `GET /api/config` (provider picker only).
- **Filters**: name search, customer `Combobox`, team `Combobox`.
- **Table**: `DataTable` "Virtual key list", `pageSize={8}`, `minWidth="60rem"`.
  Columns Name / Assigned To / Key (`MaskedSecretCell` reveal + copy) / Budget /
  Rate Limits / Status (deliberately non-sortable). Row actions Edit / Delete.
- **Create/Edit sheet** (`Sheet` -> `VKForm`): Name, Description, Active switch,
  Provider Configurations (a `Combobox` that adds removable provider chips),
  Allowed models (an `all` sentinel means unrestricted), Budget (Max Budget EUR
  + Max Requests), Rate Limiting (tokens + reset period, requests + reset
  period). `POST /api/virtual-keys` / `PUT /api/virtual-keys/:id`.
- **Token reveal**: the create response carries the full token once; it is held
  in state only and shown in a **non-dismissible** `role="alertdialog"` with a
  `Copy token` and a **Done** button that nulls the state and fires the created
  toast.
- **Delete**: `ConfirmDialog` with a special last-key warning about reopening
  inference to unauthenticated traffic. `DELETE /api/virtual-keys/:id`.

### 4.7 `#/teams` - Teams

- **Header**: title `Teams`, subtitle "Shared budgets across virtual keys";
  actions = an outline `Refresh` + `New team`.
- **Data**: `getTeams()`, `getCustomers()`, `getVirtualKeys()` (per-team key
  count), `ensureEurRate()`.
- **Table** (raw `Table`, `minWidth="52rem"`): Name / Status / Customer / Keys /
  Budget / Used / Actions; a dangling `customerId` renders warning-coloured.
- **Dialog** (`TeamDialog`): Name, Enabled, Customer `NativeSelect`, shared
  `BudgetField`. Delete confirm is reference-aware (counts virtual keys).
- **Writes**: `POST /api/teams`, `PUT /api/teams/:id`, `DELETE /api/teams/:id`.

### 4.8 `#/customers` - Customers

- **Header**: title `Customers`, subtitle "Top-level budget rollups above
  teams"; actions = an outline `Refresh` + `New customer`.
- **Data**: `getCustomers()`, `getTeams()` (team count), `ensureEurRate()`.
- **Table** (raw `Table`, `minWidth="44rem"`): Name / Status / Teams / Budget /
  Used / Actions.
- **Dialog** (`CustomerDialog`): Name, Enabled, `BudgetField`. Delete confirm
  counts referencing teams.
- **Writes**: `POST /api/customers`, `PUT /api/customers/:id`,
  `DELETE /api/customers/:id`.

### 4.9 `#/pricing` - Pricing

- **Header**: title `Pricing`, subtitle "Per-model token prices in EUR per
  million tokens"; the header action is the primary `Save pricing` button
  (`disabled` unless `dirty && valid && !busy`).
- **Data**: `getPricing()` -> `GET /api/pricing`; `putPricing()` ->
  `PUT /api/pricing`. Stored values are canonical USD; rows are shown/edited in
  EUR (`usdToEur` on load, `eurToUsd` on save).
- **Editable grid** (raw `Table`, `minWidth="36rem"`): Model / Input EUR/MTok /
  Output EUR/MTok / remove. Live validity: >=1 row, non-empty trimmed model ids,
  non-negative finite numbers, no duplicate ids; duplicates set `aria-invalid`.
  Removing previously-saved models triggers a `ConfirmDialog`.

### 4.10 `#/settings` and `#/settings/<sub>` - Settings

- **Header**: title `Settings`, subtitle "Gateway security, compatibility,
  caching, performance, MCP, and raw configuration" (`SettingsView.tsx:177`). No
  header actions - the primary action is each panel's `Save changes` footer,
  while the Config panel and the Caching panel's Operations block carry their
  own buttons and act immediately.
- **Sub-tabs** (`UnderlineTabs`, six entries, `SettingsView.tsx:22-29`):
  `security` (default), `compatibility`, `caching`, `performance`, `mcp`,
  `config`. `subFromHash()` reads `parts[1]`, validates it against `SUB_TABS`,
  and falls back to `security`; `select()` writes
  `history.replaceState(..., "#/settings/" + next)`.
- **Data**: `getSettings()` -> `GET /api/settings` (shape
  `{settings:{group:{values,sources}}, enforcement}`). Save is per-group and
  diff-only: `putSettings({[group]: values})` -> `PUT /api/settings` (groups are
  flat at the root); an empty diff returns early.
- **Panels** (feature composites): Security (password protect, auth toggles,
  four `TagInput` lists); Compatibility (four conversion switches); Caching
  (semantic cache config + embedding provider/model, TTL, threshold, and the
  `CacheOpsPanel` Operations block below its save footer); Performance (Initial
  Pool Size, Max Request Body Size); MCP (agent depth, tool timeouts, Code Mode
  binding preview, external base URLs); Config (raw export / import / reload,
  self-loading).
- **Provenance UI**: `SourceTag` renders an `env` or `override` badge (nothing
  for `default`); `EnvHint` adds advisory copy. Env-sourced fields are **not
  disabled** - the hint is advisory only. The `enforcement` map is fetched and
  typed but never rendered.

#### Settings > Caching, Operations block

`CachingPanel` renders the semantic-cache configuration form and its
`PanelFooter`, then a divided "Operations" region holding `CacheOpsPanel`
(`CachingPanel.tsx:325-340`).

- **Purge everything**: a destructive `Purge cache` button behind a
  `ConfirmDialog` -> `clearCache()` `DELETE /api/cache` (a no-op when
  `FROSTY_CACHE` is unset).
- **Purge one entry**: a `Request JSON` textarea (`.measure`, `font-mono`, live
  JSON validation, 2 MB cap) -> `deleteCacheEntry(body)`
  `DELETE /api/cache/by-key`; the result toast distinguishes "Cache entry
  deleted" from "No matching cache entry".
- These act immediately and are not part of the settings save above. There is
  still **no cache browsing, statistics, or hit-rate UI**.

#### Settings > Config (`#/settings/config`)

No `PageHeader` of its own - it is a panel inside the Settings view. Unlike the
other five panels it loads its own data and is not gated on the settings tree,
so a failing `/api/settings` cannot leave it on a permanent skeleton
(`SettingsView.tsx:188-193`).

- **Default provider card**: a `NativeSelect` + Save -> `setDefaultProvider()`
  `PUT /api/config`.
- **Store-off detection**: `isStoreOff` - a 400 mentioning "No persistent config
  store" replaces the Export/Import/Reload cards with an info banner pointing at
  `FROSTY_PG_URL`. The gateway raises that 400 only when `ctx.config` is absent
  (`routes/admin.ts`), which `createDefaultContext()` never produces, so in a
  normally booted gateway this branch is unreachable.
- **Export card**: `Redacted` vs `Include secrets` radio. Secrets mode is gated
  behind an "Export secrets?" confirm; `Download` fetches
  `exportConfig(true)` -> `GET /api/config/export?include_secrets=true` and keeps
  the secret-bearing body in a local const, never React state. `Preview` is
  disabled in secrets mode and always fetches the redacted export.
- **Import card**: `importConfig()` -> `POST /api/config/import`; validated on
  every keystroke (2 MB cap, JSON validity, `Missing config.providers` check);
  the `ConfirmDialog` names exact provider counts. **Reload card**:
  `reloadConfig()` -> `POST /api/config/reload` behind a non-destructive confirm.

### 4.11 `#/status` - Status

- **Header**: title `Status`, subtitle "Process topology, saturation, limits,
  and live traffic" (`StatusView.tsx:209`); action = a `Refresh` icon button.
  Polls every 10s (`:173`).
- **Data** (`Promise.allSettled` over **eight** calls): `getHealth()`
  `GET /healthz`; `getVersion()` `GET /api/version`; `getConfig()`
  `GET /api/config`; `getMCPClients()` `GET /api/mcp/clients`; `getLogs(500)`
  `GET /api/logs?limit=500`; `getVirtualKeys()` `GET /api/virtual-keys`;
  `getModels()` `GET /v1/models`; `getRuntime()` `GET /api/runtime`
  (`StatusView.tsx:87-96`).
- **Six traffic KPI tiles** (`md:grid-cols-3 xl:grid-cols-6`): Total requests,
  Error rate, Avg duration, Providers, MCP servers, Virtual keys - all derived
  from the in-memory log buffer (max 500, resets on gateway restart).
- **Runtime section** (`StatusView.tsx:291`, defined `:414-614`) - eight further
  `StatTile`s in their own `md:grid-cols-3 xl:grid-cols-6` row:
  - **Worker processes**, captioned with the platform limit when
    `configured !== effective` (the platform refused to fan out), otherwise the
    worker index.
  - **Connections open**, with peak.
  - **Longest open** (oldest live connection).
  - **Avg lifetime** over the last 1000 completed connections, plus max.
  - **Dispatching** - handlers executing, explicitly excluding streaming.
  - **Rate-limited keys** as `keysWithLimits/totalKeys`.
  - **DB connections** as the estimated fleet total, captioned with the pool
    size per process.
  - **Uptime** for this process.
- **Per-process honesty paragraph**: with more than one effective worker it
  states that connection counts and lifetimes are measured per process and that
  a per-window rate limit admits up to N times its stated value, while budgets
  are unaffected because they use shared counters (`:517-528`). With a single
  worker it prints `workers.reason` verbatim (`:529-533`).
- **Rate limits card** (only when `rateLimit.windows` is non-empty): Virtual key
  / Max requests / Window, mono, numerics right-aligned, caption "Per-key
  request windows, enforced per process".
- **Shared state card**: the PostgreSQL target with credentials stripped; a
  cross-process invalidation badge reading `listening` or `not active` (with the
  "other workers keep cached entries until TTL" caveat when inactive); and the
  response-cache mode badge plus this process's local entry count and a
  shared-tier marker (`:597-608`).
- **Gateway health card**: tone badge + `gateway v<version> on Deno <deno>` + a
  `checked HH:MM:SS` stamp. **Model catalog card**: uses `/v1/models`; on a 401
  (governance requires a virtual key) it falls back to the configured models
  with an explanatory line.
- **Network failure**: a `TypeError` from `/healthz` sets `netError` and renders
  an error `Banner` with a `Retry` action instead of the cards (`:222-239`).

---

## 5. Navigation and information architecture

### 5.1 Sitemap

```
/  (any non-matching hash resolves here)
|
+-- Overview
|   +-- #/dashboard       Dashboard
|   |     sections (SubTabs, no URL): overview | provider-usage |
|   |                                 model-rankings | mcp-usage | user-rankings
|   +-- #/logs            Logs   (Live / Stored is a Button, not a route)
|   +-- #/status          Status
|
+-- Gateway
|   +-- #/providers       Providers   <== DEFAULT ROUTE
|   |     modes (no URL): add | keys | config (config replaces the two-pane)
|   |     config tabs (UnderlineTabs, no URL): Network | Proxy | Performance |
|   |                                          Governance | Beta Headers | Debugging
|   +-- #/model-catalog   Model Catalog
|   +-- #/extensions      Extensions
|         tabs (UnderlineTabs, no URL): mcp-servers | tools | plugins
|
+-- Governance
|   +-- #/virtual-keys    Virtual keys
|   +-- #/teams           Teams
|   +-- #/customers       Customers
|   +-- #/pricing         Pricing
|
+-- System
    +-- #/settings        Settings
        +-- #/settings/security        (default sub-route)
        +-- #/settings/compatibility
        +-- #/settings/caching         (includes cache purge operations)
        +-- #/settings/performance
        +-- #/settings/mcp
        +-- #/settings/config

Legacy, rewritten in place by REDIRECTS (App.tsx:81-84):
    #/cache   -> #/settings/caching
    #/config  -> #/settings/config
```

**11 routes + 6 settings sub-routes = 17 addressable URLs, across 4 nav
groups,** plus two legacy hashes (`#/cache`, `#/config`) that redirect rather
than resolve. Overlays are routeless: `AdminTokenDialog`, `CommandPalette`,
`AddProviderDialog`, the VK create/edit `Sheet`, the
VK token-reveal alertdialog, the Extensions edit `Sheet`, and every
`ConfirmDialog`.

### 5.2 Router mechanism

No router library - a hand-rolled hash router in `App.tsx`.

| Step | Behavior | Evidence |
| --- | --- | --- |
| Legacy rewrite | `applyRedirect(hash)` replaceState-rewrites `#/cache` / `#/config` before routing | `App.tsx:81-122` |
| Route-key extraction | `baseSegment(hash)` strips `#`/`/`, takes `split("/")[0]` | `App.tsx:96-99` |
| Route resolution | `hashToView` returns the base segment if it is in `IDS`, else `"providers"` | `App.tsx:101-104` |
| Live updates | a `hashchange` listener sets the view only when the base segment is a known id; unknown or in-page anchors are ignored | `App.tsx:197-210` |
| Programmatic nav | `navigate(id)` sets state, closes the mobile drawer, then `history.replaceState(null, "", "#/" + id)` | `App.tsx:212-220` |
| View rendering | `renderView(id)` is a `switch`; `default:` renders `<ProvidersView/>` | `App.tsx:124-149` |

The canonical URL form is `#/<key>`. **The default route is Providers**, encoded
twice (`hashToView` fallback and `renderView` default). Because both App and
Settings only ever call `replaceState` - there is **no `pushState` anywhere** -
browser Back/Forward does not traverse view history.

### 5.3 Nav model

Source of truth is `NAV` at `App.tsx:35-72`; groups are derived first-seen by
`lib/nav.ts`, so the order is Overview, Gateway, Governance, System.

| # | Group | id | Label (verbatim) | Icon |
| --- | --- | --- | --- | --- |
| 1 | Overview | `dashboard` | `Dashboard` | `LayoutDashboard` |
| 2 | Overview | `logs` | `Logs` | `ScrollText` |
| 3 | Overview | `status` | `Status` | `Activity` |
| 4 | Gateway | `providers` | `Providers` | `Plug` |
| 5 | Gateway | `model-catalog` | `Model Catalog` | `Boxes` |
| 6 | Gateway | `extensions` | `Extensions` | `Puzzle` |
| 7 | Governance | `virtual-keys` | `Virtual keys` | `KeyRound` |
| 8 | Governance | `teams` | `Teams` | `Users` |
| 9 | Governance | `customers` | `Customers` | `Building2` |
| 10 | Governance | `pricing` | `Pricing` | `CircleDollarSign` |
| 11 | System | `settings` | `Settings` | `SlidersHorizontal` |

`DatabaseZap` and `FileCog`, the icons for the retired Cache and Config leaves,
are no longer imported anywhere.

Label casing is intentionally mixed (`Virtual keys` lowercase k vs `Model
Catalog` title case); the Virtual Keys view's own `PageHeader` title is
`Virtual Keys` (capital K), so nav label and page title differ for that route.
Nav grouping matches `CONVENTIONS.md:156-159` exactly: Logs and Status both sit
in Overview, the contract's stated rationale being that Status answers "is the
gateway healthy right now".

### 5.4 Navigation patterns

1. **Persistent grouped sidebar** (primary): `<nav aria-label="Sections">` with
   collapsible group headers, roving `tabIndex` over visible leaves,
   `aria-current="page"` on the active leaf, and a left accent bar via a
   `before:` pseudo-element.
2. **Sidebar search box** (placeholder `Search... (Ctrl K)`): filters through
   `filterNav` (case-insensitive on label OR group); no matches renders "No
   matching views."
3. **Command palette (Cmd/Ctrl-K)**: a global `keydown` toggles it; it searches
   the same `NAV` with the same `filterNav` (`items={NAV}`, `App.tsx:330`), and
   `onSelect(id)` is `navigate` - so it can **only navigate between the 11
   views**; there are no commands, actions, or resource search.
4. **View-level tabs**: `SubTabs` (Dashboard), `UnderlineTabs` (Settings,
   Extensions, provider config). Only Settings mirrors its tab into the URL.
5. **Master/detail**: `TwoPane` in Providers only.
6. **Mobile drawer**: hamburger opens the off-canvas sidebar; scrim, X, or any
   leaf selection closes it.

### 5.5 Route guards and redirects

**There is no authentication route guard and no login screen.** Unknown or
garbage hashes resolve to Providers as a render fallback and the URL is left
alone; an unknown `hashchange` does nothing; `#/settings/<invalid>` falls back
to `security`.

Two legacy hashes are the exception: `#/cache` and `#/config` are rewritten in
place to `#/settings/caching` and `#/settings/config` by `applyRedirect`
(`App.tsx:111-122`), using `replaceState` so Back does not bounce between the
old hash and its replacement. It runs on boot (`:153`) and on every `hashchange`
(`:202`). Only a BARE legacy hash redirects - `#/cache/anything` was never a
minted route, so rewriting it would invent a destination (`App.tsx:90-93`,
locked by `App.nav.test.tsx`).

**Auth is a banner, not a guard**: a 401 on an admin surface sets a module
singleton to `denied` (`api.ts`), and the app renders a red `Banner` with a
`Set token` action above `<main>`; views keep rendering their own error/empty
states underneath. `AdminTokenDialog` is never auto-opened. Saving or clearing
the token bumps `authNonce`, which changes the content wrapper key and remounts
the active view.

### 5.6 Primary user flows

**Set the admin token** (prerequisite for everything). A 401 renders the red
banner. Click **Set token** (or the sidebar **Admin token** button) -> type into
a single `type="password"` field -> **Save token** writes
`sessionStorage["frosty.admin-token"]`, resets auth to `unknown`, toasts "Admin
token saved", and closes. `onTokenChange` bumps `authNonce` so the active view
remounts and refetches. The token is sent as `Authorization: Bearer` on every
`/api` and `/metrics` request and dies with the tab.

**Add a provider.** Providers -> **Add New Provider** -> `AddProviderDialog`
gallery (27 presets, optionally searched) -> pick a preset -> the right pane
renders `AddProviderForm` prefilled with `{id, type, baseUrl}` -> enter the API
key plus type-specific fields (Azure endpoint + version + deployment/model name;
Bedrock region + keys; Vertex project + service-account JSON) -> submit ->
`POST /api/providers` -> toast + list reload + the new provider selected in
`keys` mode. The **Add Custom Provider** flow renders the inline
`AddCustomProviderForm` in the detail pane (Name, Base Format, Base URL, Is
Keyless?, and an advisory request-type grid that is never sent).

**Deep provider configuration.** From `ConfiguredKeys` click **Edit Provider
Config** -> `ProviderConfigPanel` replaces the two-pane, with six `UnderlineTabs`
(Network, Proxy, Performance, Governance, Beta Headers, Debugging). Each group is
diffed by a deterministic `JSON.stringify` signature and only dirty groups enter
the patch (because the gateway PUT shallow-merges at the top level, re-sending an
unchanged group would wipe its redacted secrets). Live "at-risk" warn banners
fire while editing. A sticky footer holds **Remove configuration** and **Save
configuration** -> `PUT /api/providers/:id`.

**Create a virtual key.** Virtual Keys -> **Add Virtual Key** -> `Sheet` in
`create` mode -> Name, Description, Active -> add providers one at a time via the
`Combobox` -> Allowed models (default `All models`) -> optional Budget and rate
limits -> **Create** -> `POST /api/virtual-keys` -> the one-time token opens in a
non-dismissible reveal dialog with `Copy token` and **Done**.

**Inspect a log.** Logs opens in **Live** mode; the SSE stream connects and
`LiveBar` announces connection state. To search history, toggle **Live** off
(only when the KV probe succeeded); the stored query runs debounced with a
server-side `q` param. Narrow with free text, the `TimeRangePicker`, and the
Outcome checkboxes; adjust visible columns via **Choose columns**; sort by Time
or Latency, 25 rows a page. There is no per-row payload inspector.

**Change a gateway setting.** Settings -> pick a sub-tab (hash updates to
`#/settings/<sub>`) -> edit fields -> `Save changes` is disabled until the
computed diff is non-empty -> Save -> `PUT /api/settings` with only the changed
group -> the full tree is re-read plus a "Changes saved" toast.

**Explore / invalidate cache.** The only cache-facing surfaces are Settings >
Caching - the semantic-cache configuration form plus the Operations block below
its save footer (purge everything behind a confirm, or purge one entry by
pasting the exact request JSON) - and the Dashboard's two permanently empty
hit-rate cards. Status > Shared state additionally shows the response-cache mode
and this process's local entry count (`StatusView.tsx:597-608`). There is still
**no cache key browser, entry listing, or hit/miss statistics view**.

---

## 6. Interaction states

### 6.1 Loading

Skeletons over a bare spinner page, enforced structurally: `Spinner` has exactly
one importer, `button.tsx`, so it is unreachable except inside a button.

| Mechanism | Site |
| --- | --- |
| `Skeleton` / `TableSkeleton` / `TileSkeleton` / `PanelSkeleton` (composites `aria-hidden`) | `skeleton.tsx` |
| `DataTable loading` (one row of `TableSkeleton`) | `data-table.tsx:204-211` |
| `StatTile loading` / `ChartCard loading` | `stat-tile.tsx:15`, `ChartCard.tsx:105` |
| Settings `LoadingPanel` (four `Skeleton` bars) | `SettingsView.tsx:199-210` |
| `Button isLoading` (disables + prepends `Spinner`) | `button.tsx:36,57,70` |
| `ConfirmDialog pending` (disables Cancel, `isLoading` on Confirm) | `dialog.tsx:125,131` |

### 6.2 Empty

`EmptyState` (dashed block with icon / title / body / optional action);
`DataTable` empty row (default "No results."); `ChartCard` auto-empty ("No data
available" + optional note - an all-zero window never renders a misleading flat
line, and the toggle is hidden); `Combobox`/`FacetRail` "No matches.";
sidebar/palette "No matching views." The shared analytics empty string **"No
data available"** is used at five render sites.

### 6.3 Error

`Banner tone="error"` (`role="alert"`); `ErrorBanner({message})`; field error
text `text-destructive` with `id={id}-error`; `aria-invalid:border-destructive`
on every input; `PemTextarea` non-blocking `text-warning` hint; inline
`<p role="alert" class="text-destructive">` (`ConfigPanel`, `CacheOpsPanel`);
Toast
`tone="error"`; the app-level 401 banner with a "Set token" action. Error
banners quote the gateway's `error.message` verbatim via `ApiError.message`.

### 6.4 Success / confirmation

`ToastProvider` + `useToast().success/error/info`; auto-dismiss 5000ms (6000ms
with an action); container `aria-live="polite"`, fixed bottom-right, tone-colored
icon only on `bg-popover` / `shadow-lg`. `CopyButton` shows a 2s "Copied" state;
`MaskedSecretCell` copy flips its `aria-label` to "Copied" with a `text-success`
check. `useToast()` returns a no-op API outside a provider so views render
standalone in tests.

### 6.5 Destructive confirmation

Every destructive action is `ConfirmDialog`-gated, and the body always names the
concrete blast radius (exact stored-entry counts on Logs; the last-key
governance warning on Virtual Keys; reference counts on Teams/Customers; exact
provider counts on Config import; a plaintext-secret warning on Config export;
priced-model counts on Pricing). `ConfirmDialog` defaults to `destructive={true}`
and its overlay click does not dismiss.

### 6.6 Form validation

There is no shared validation library; every form hand-rolls its checks. Two
patterns coexist:

- **Banner-at-the-bottom, submit-time, first-failure-wins** for the dialogs and
  the two big forms: `AddProviderForm`, `AddCustomProviderForm`, `VKForm`,
  `TeamDialog`, `CustomerDialog`.
- **Inline, live, per-field** for `PricingView` (every keystroke), `ConfigPanel`
  import (every keystroke), `CacheOpsPanel` purge-one (live), and `BudgetField`
  (Teams/Customers).

`ProviderConfigPanel` has **no field validation** - only live "at-risk" warn
banners; nothing blocks Save. Settings panels have no validation - Save is
disabled until the diff is non-empty. A notable gap: clearing a numeric settings
field to blank produces no diff, so a numeric setting can be changed but **not
unset** from the UI.

### 6.7 Honest-empty / advisory UI

Large parts of the analytics and logs surface are deliberately "honest empty":
they render explicit "not recorded yet" copy rather than hiding. Examples: the
Dashboard cache-hit-rate cards, Provider Latency, MCP usage, and User Rankings;

The Logs Type/Provider/Model/Tokens columns are **no longer** in this category -
decision-log item 56 wired the telemetry enrichment that populates them, and the
Models/Provider/Type facet groups became live filters. Those cells still render
`N/A` on a row that carries no value (a health probe has no model), which is
row-level honesty rather than a missing data source; the Cost facet group says
"No filter yet" instead of "Not recorded yet" because cost IS recorded per entry
and only the range control is unbuilt. Remaining honest-empty examples:
the 10 honest-empty Logs facet groups; the Providers "Weight" column (hardcoded
`1`); the
Add Custom Provider request-type grid (advisory, never sent); the provider-config
"Proxy Type" (advisory); the Settings "Code Mode Binding Level" (preview-only,
never persisted). No UI is gated on a build-time flag or a browser-read env var;
every "off" state is either a server response (404, `tracked:false`, empty list)
or hardcoded.

---

## 7. Theming

**Light and dark are both fully supported, and a user-facing theme switcher DOES
exist** - it is the second button in the sidebar footer (an icon button labelled
`Switch to {light|dark} theme`, rendering lucide `Moon` when dark and `Sun` when
light, `Sidebar.tsx:308-322`).

| Step | Evidence |
| --- | --- |
| Default class on the document | `index.html:2` - `<html lang="en" class="dark">` |
| Pre-paint resolution (blocking inline script) | `index.html:7-22`: reads `localStorage["frosty.theme"]`; if unset, `dark = !matchMedia("(prefers-color-scheme: light)").matches` (dark unless the OS explicitly asks for light; `no-preference` stays dark); toggles `.dark` and sets `documentElement.dataset.theme`, all in try/catch |
| React state seeded from the DOM | `App.tsx:168-170` |
| Toggle handler | `App.tsx:234-247` - flips state, toggles `.dark`, sets `dataset.theme`, persists to `localStorage` in try/catch |
| CSS mechanism | Light values are the `:root` base; dark is a `.dark` override; `color-scheme` per theme so native widgets follow |
| `data-theme` attribute | set on `<html>` but **no CSS keys off `[data-theme]`** - it is informational/hook-only; the `.dark` class is the sole styling switch |

Token mapping across themes: 38 color tokens + 3 shadow tokens are re-declared
under `.dark`; every other token (typography, spacing, radius, motion, z-index,
control metrics) is theme-independent. Light->dark inverts luminance while
holding hue (neutrals stay hue 265; semantic hues stay red 25 / green 155 /
amber 70->82 / blue 250-255 / violet 300). `--primary` is the clearest
inversion (near-black in light, near-white in dark). `--sidebar` is always the
recessed surface. `--sidebar-primary-foreground` is the only color token with an
identical value in both themes. Alpha-composited surfaces (`bg-<tone>/16`, etc.)
re-resolve automatically because they composite the theme-current token.

**There is no "system / auto" tri-state.** Once the user clicks the toggle the
stored value wins forever; there is no "follow system" option and no `matchMedia`
change listener after boot. The theme key `frosty.theme` lives in localStorage
(persists across tabs), whereas the admin token `frosty.admin-token` lives in
sessionStorage (dies with the tab) and the sidebar collapse state
`frosty.sidebar` in localStorage.

---

## 8. Accessibility

### 8.1 Implemented global measures

| Measure | Evidence |
| --- | --- |
| Visible focus ring on every focusable element: `2px solid var(--ring)` at 2px offset | `index.css:29-32` |
| 44px minimum hit-area helper `.hit-target` (a centred `max(100%, var(--tap-target))` pseudo-element); 34 applications across 24 files | `index.css:77-90` |
| Skip link `<a href="#main">Skip to content</a>` -> `<main id="main" tabIndex={-1}>` | `App.tsx:258,308-311` |
| Heading focus on nav change: `#main h2` is focused on every view change except first mount | `App.tsx:186-195`, `page-header.tsx:26-32` |
| `lang="en"` + viewport meta | `index.html:2,5` |
| Reduced motion honoured globally (tokens to 0, keyframes off, spinner `motion-reduce:animate-none`, `reduceMotion()` guard) | `tokens.css:250-258`, `index.css:124-129`, `spinner.tsx:11`, `LogsTable.tsx:189` |
| Semantic landmarks: `<main>`, `<nav aria-label="Sections">`, `<aside>`/`<section>` with `aria-label` | `App.tsx:308`, `Sidebar.tsx:206-207`, `two-pane.tsx:44-56` |
| Semantic headings h1-h4 (brand / page title / dialog / card / settings sub-section) | `Sidebar.tsx:156`, `page-header.tsx:26`, `dialog.tsx:50`, `card.tsx:36`, `helpers.tsx:98` |
| Real table semantics: `thead`/`tbody`/`th scope="col"`/real `<caption>` | `table.tsx:35-102` |
| Native `label htmlFor` associations | `label.tsx:9,33`, `facet-rail.tsx:150`, `number-field.tsx:50` |

Per-component ARIA is thorough: Banner `role="alert"`/`status`; Dialog
`role="dialog"` + `aria-modal` + `aria-labelledby`; ConfirmDialog
`role="alertdialog"`; Sheet + `useModal` provide a capture-phase focus trap,
scroll lock, and focus restoration; DropdownMenu / Combobox / TimeRangePicker
carry full menu/listbox/combobox ARIA with roving `tabIndex` and keyboard
handling; DataTable exposes `aria-sort`; Tabs/NavTabs/SegmentedSelect use
tablist/radiogroup roles; Switch is `role="switch"`; Chart is `role="img"` +
`ariaLabel`; the log `LiveBar` is `aria-live="polite"`. A **pinned
accessible-name contract** (`CONVENTIONS.md:172-175`) keeps the nav leaves
`Providers`, `Status`, `Logs`, `Extensions` uniquely matchable - visible in four
deliberate accommodations (`aria-label="Reload configuration"`, the non-sortable
Virtual Keys "Status" column, the "Providers" -> "Provider" facet relabel, and
the "Command menu" palette input name).

### 8.2 Contrast evidence (asserted, not code-verified)

`DESIGN.md:333-450` publishes a computed contrast audit - 22 text/UI pairs, 5
chart marks, and 5 soft badges per theme - claiming "0 failures across 64
checked pairs (both themes)". Representative dark/light figures: `--foreground`
on `--background` 18.84:1 / 17.59:1 (AAA); `--muted-foreground` on `--muted`
6.52:1 / 6.04:1 (AA); `--ring` on `--background` 5.41:1 / 4.76:1 (AA). Weakest
declared margins are the dark soft-destructive badge at 4.64:1 and the light
accent link at 4.76:1. **These numbers are prose only** - no OKLCH-to-sRGB
converter, contrast function, fixture, or test exists in the repo to recompute
them, so contrast is UNVERIFIED from code.

### 8.3 Known accessibility gaps (found in review)

| # | Gap | Evidence |
| --- | --- | --- |
| A1 | **Tab-panel `aria-labelledby` is dangling.** `tabPanelProps(v)` emits `aria-labelledby="tab-${v}"` but `NavTabs` buttons carry `id="navtab-${v}"`. Every panel using `tabPanelProps` is paired with `NavTabs` (Settings, ProviderConfigPanel, Dashboard), so the reverse link is broken app-wide (`aria-controls` -> `panel-${v}` does match) | `tabs.tsx:73` vs `nav-tabs.tsx:61` |
| A2 | **Menu-item focus indicator suppressed.** DropdownMenu and TimeRangePicker items set `outline-none` and rely on `focus-visible:bg-accent`; in dark, `--accent` on `--popover` is a very low-contrast wash | `dropdown-menu.tsx:251,253`, `time-range-picker.tsx:172,174` |
| A3 | **Loading is silent to assistive tech.** All skeleton composites are `aria-hidden` and no `aria-busy`, `role="status"`, or `role="progressbar"` exists anywhere | `skeleton.tsx:21,43,53`; grep |
| A4 | **`Field` does not wire `aria-describedby`/`aria-invalid`.** It renders `#{id}-hint`/`#{id}-error` and defers association to each caller | `label.tsx:27,42-51` |
| A5 | **`aria-controls` targets are often absent.** Inactive tabs reference `panel-${v}` ids for panels that are conditionally unmounted | `tabs.tsx:47`, `nav-tabs.tsx:63` |
| A6 | **`Combobox` has no `<label for>`** and does not restore focus after a mouse selection; it relies on `aria-label` | `combobox.tsx:88-95,148` |
| A7 | **Overlapping `hit-target` boxes.** `.hit-target::after` is a 44px box with no `z-index`; adjacent 28px icon buttons at `gap-2` (8px) produce overlapping hit areas, and the later DOM sibling wins the gap (read off the CSS, not observed) | `index.css:82-90`, `masked-secret.tsx:100,128` |
| A8 | **`ScrollContainer` is an unconditional tab stop** (`tabIndex={0}`) on every table, even with nothing to scroll (a deliberate documented trade-off) | `table.tsx:22` |
| A9 | **Programmatic focus is visually silent.** The `PageHeader` h2 that `App.tsx` focuses on every nav change carries `outline-none`; `<main>` (the skip-link target) also carries `outline-none` | `page-header.tsx:29`, `App.tsx:194,311` |
| A10 | **`TagInput` input has no `aria-label` and commits on blur;** its remove-chip button lacks `hit-target` | `tag-input.tsx:46-53,56-64` |
| A11 | **`Checkbox` relies on `accent-primary` only** (native mark), so the checked-state contrast is the browser's, uncovered by the audit | `checkbox.tsx:13` |
| A12 | **Nested live regions in the toast stack** (container `aria-live="polite"` plus each toast's own `role="alert"`/`status`) may double-announce (read off markup) | `toast.tsx:101,109` |
| A13 | **`ChartCard` bar/line toggle buttons have no `hit-target`** - a 28px `grid size-7` target, below the 44px minimum | `ChartCard.tsx:150-161` |
| A14 | **`ProviderIcon`/`Avatar` tiles carry no `hit-target`** (though they are decorative `role="img"`, not controls) | `provider-icon.tsx:119-165` |
| A15 | **Chart data is image-only.** `Chart` exposes only `role="img"` + `ariaLabel`; values, axes, tooltip, and legend markers are all `aria-hidden`, with no table fallback or textual summary | `chart.tsx:123,141-143,225-227` |
| A16 | **No disclosure semantics on the Logs rail toggle.** "Hide filters" / "Show filters" are plain buttons that conditionally mount/unmount the rail without `aria-expanded` | `LogsView.tsx:301-323` |

---

## Notes on divergences and what could not be verified

- The shipped app **does not use shadcn/ui or Radix**; every primitive is
  hand-written on `clsx` + `tailwind-merge` + `lucide-react`, despite
  `DESIGN.md`'s shadcn install instructions. `DESIGN.md` also prescribes overlay
  enter animations, toast semantic-left-borders, xl dialog titles, and 3xl stat
  values that the code does not implement (it uses no overlay animation, uniform
  toast borders, `text-lg` titles, and `text-2xl` stats).
- The provider-logos file used to carry 28 em dashes (U+2014) inside its own
  comments/JSDoc, contradicting the "zero em/en dashes" house rule; they have
  been replaced with plain hyphens and the file is now clean. No lint rule
  enforcing that rule was found in the SPA's `deno.jsonc` or the root
  `deno.jsonc`, so machine enforcement is still unverified - the rule holds by
  review only.
- Document title, sidebar `h1`, and mobile bar all read **"Klanker Gateway
  Manager"** (`index.html:6`, `Sidebar.tsx:162`, `App.tsx:290`), while
  `DESIGN.md:16` names the surface "Frosty Control Plane" - naming is
  inconsistent between the design doc and the shipped shell.
- Rendered appearance was not observed in a browser; Tailwind v4 layer ordering,
  `@theme inline` substitution, and the unlayered `:root` block beating
  `@layer theme` for `--tracking-*`/`--font-weight-*` are reasoned from CSS
  cascade rules. Tailwind's default breakpoint values were not read from
  `node_modules` (they are the documented v4 defaults; no override exists here).
- The separate `tests/browser/` Playwright harness (outside `deno task test`,
  manual-only) was not read; any visual-regression or automated a11y assertions
  there are unaccounted for.

### Related

- [DESIGN.md](DESIGN.md) - the declared design source of truth (register,
  dials, contrast audit) that this document reconciles against the shipped code.
- [tokens.css](tokens.css) - the canonical token mirror in this folder;
  the app consumes `apps/control-ui/src/styles/tokens.css`.
- [../../apps/control-ui/CONVENTIONS.md](../../apps/control-ui/CONVENTIONS.md) -
  the binding SPA contract.
- [../concepts/architectural-overview.md](../concepts/architectural-overview.md)
  - how the same-origin SPA fits the gateway (one process, or N under
  `FROSTY_WORKERS`).
- [../reference/environment-variables.md](../reference/environment-variables.md)
  - the `FROSTY_*` knobs the UI surfaces (`FROSTY_LOG_STORE`, `FROSTY_PG_URL`,
  `FROSTY_CACHE`, `FROSTY_EUR_RATE`, and the `x-frosty-cache-*` headers).
