# Control UI conventions (flagship contract)

Shared build patterns every control-ui view follows. Set by the Providers
flagship pass; later views (Model Catalog, Settings, Logs, MCP, Governance,
Dashboard) must match. When in doubt, read `ProvidersView.tsx` and its
`components/providers/*` for a worked example.

Design system is **ds-r2** (dense neutral-monochrome dark console). Tokens live
in `src/styles/tokens.css` - do not hand-edit component CSS to diverge; consume
the Tailwind token classes.

## Taste hard-rules (non-negotiable, from `taste.md`)

- **Zero em/en dashes** anywhere. Plain hyphen only. (deno lint + review check.)
- **One cool-blue accent** (`ring`, links, active-nav indicator) - never a fill.
  Primary is a monochrome emphasis surface, not a chromatic color.
- **Monochrome-first.** Status/semantic color (success/warning/destructive/info)
  is a functional vocabulary only; never decorative.
- **Dual-theme AA** in both light and dark. Every text/surface pair is
  contrast-checked.
- **6px radius family**, one system. `rounded-sm|md|lg|xl` map to 4/6/8/12px.
- **44px min hit area** (`hit-target` class), **2px focus ring @ 2px offset**
  (global `:focus-visible`), **full keyboard path** on every control.
- **lucide-react icons only**; no hand-rolled decorative SVG, no glow, no
  glassmorphism. Elevation via borders + surface steps.
- **Motion is feedback-only** (`--motion-fast|default|slow`); reduced-motion
  collapses to 0. No decorative animation.
- **Same-origin only.** No external CDN/script/font/style/image origins.
- **Frosty identity.** Own brand, `sk-`/`vk-` prefixes; never the reference
  product's name, logos, or hues.

## Page structure

- Every view opens with `<PageHeader title subtitle actions>`. The title is an
  `h2` and the focus target on nav change (do not add a second `h2`).
- Primary actions go in `PageHeader actions` (right cluster). Destructive or
  bulk actions live inside the relevant card/panel, not the header.
- **Keep a destructive operation away from a Save button.** When a panel mixes
  configuration edits with immediate-effect operations, the operations go below
  the panel's save footer behind a divider, in their own labelled block - see
  `CacheOpsPanel` mounted under `CachingPanel`'s `PanelFooter`
  (`CachingPanel.tsx:322-340`), so a destructive purge is never adjacent to the
  Save button that applies configuration edits.
- Content max width is `--container-max` (110rem / 1760px; the app shell applies
  it). Page gutters use `--gutter`, which tightens from 24px to 16px at <= 48rem
  so a tablet does not spend a quarter of its width on padding. Tables and
  dashboards may use the full width; anything text-heavy takes `.measure`
  instead.
- Errors: `<Banner tone="error">` quoting the gateway's `error.message` verbatim
  (`ApiError.message`). Info/warn use `tone="info"|"warn"`.
- Loading: `TableSkeleton` / `TileSkeleton` / `Skeleton`, never a bare spinner
  page.

## Tabs: SubTabs vs UnderlineTabs vs Tabs

- **`SubTabs`** (pill row) - dashboard-style section switcher across a wide
  surface (e.g. Overview / Provider Usage / Model Rankings).
- **`UnderlineTabs`** - configuration panels and settings sub-navigation
  (Providers config Network/Proxy/...; Settings Security/Compatibility/...).
  This is the "sub-page within a view" bar.
- **`Tabs`** (segmented, on a muted track) - available for a small
  binary/ternary local switch inside a card, but currently unused: no view
  renders `<Tabs>`. Only `tabPanelProps(value)` and the `TabItem` type are
  consumed today. Logs Live/Stored is a `Button` with `aria-pressed`, not a Tabs
  instance. Reach for `Tabs` only when a real segmented switch appears;
  otherwise prefer `SubTabs` / `UnderlineTabs`.
- Always pass a unique `label`; spread `tabPanelProps(value)` on the matching
  panel container for the `role="tabpanel"` wiring.

## Tables: `DataTable`

Use `DataTable<T>` for every resource list. Never hand-roll `<table>` sorting.

- `columns`: `{ key, header, cell, sortValue?, align?, width? }`. Provide
  `sortValue` to make a column sortable; `headerLabel` when `header` is not
  plain text.
- `rowMenu`: return a `<DropdownMenu>` for per-row actions (Edit / Make default
  / Delete). Keep row action clusters out of cells; the kebab is the pattern.
- `pageSize`: set to enable the "Showing X-Y of Z" footer + prev/next.
- `caption` is required (labels the scroll region + screen readers).
- `empty`: pass a node; default copy is "No results." Prefer the shared empty
  string **"No data available"** for analytics-style empties (see EmptyState).

## Forms

- Field grid: **`.field-grid`** (index.css). It is
  `repeat(auto-fit, minmax(min(100%, 16rem), 22rem))` - as many columns as fit,
  each capped at 22rem. Do NOT go back to `sm:grid-cols-2`: that sized every
  field to half the container, so one "ID" input was 350px in a wide pane and
  560px at the current container width. The 22rem cap is the point - a field
  stops growing at a width appropriate to its content and leftover space stays
  empty. Use **`.field-wide`** (a direct child of `.field-grid`) for fields that
  genuinely need the row: JSON blobs, PEM, long descriptions.
- Wrap prose and single-column form panels in **`.measure`** (`--measure-max`,
  60rem). Raising `--container-max` to 110rem means an uncapped label-control
  pair can span 1760px, which puts the label a screen away from its input.
- **`Field`** (`label` + control + hint/error) for text inputs (`Input`,
  `Textarea`, `NativeSelect`). `NativeSelect` is the only select for plain
  option lists (G9).
- **`NumberField`** for numeric config (unit suffix + help). Emits a raw string
  so empty stays representable; parse with a `numOrUndef` helper on save.
- **`KeyValueRows`** for repeatable Name/Value editors (extra headers).
- **`PemTextarea`** for PEM/cert blobs (non-blocking validity hint).
- **`SegmentedSelect`** for inline 2-3 option choices (beta-header override
  default/enabled/disabled).
- **`Combobox`** for searchable single-select (reset periods, model/customer
  filters).
- **`ToggleGridItem`** for a labelled switch tile in a responsive grid.
- **`Switch`** for a lone boolean; wrap with a label + description row.

## Secrets (never render values)

The server returns **redacted** views: secrets become `hasX` presence markers
(`hasApiKey`, `hasCloudCredentials`, `hasProxy`, `hasProxyPassword`,
`hasCaCert`). The raw value never reaches the browser.

- Show a **marker** ("Configured" + `••••••••`) plus a **Replace** affordance
  that reveals an input to submit a _new_ secret. Use
  `components/providers/SecretReenter` for single-line secrets; `PemTextarea`
  (with a "Configured" badge) for `caCertPem`.
- Blank input = keep the current server value where possible.
- `MaskedSecretCell` (reveal + copy) is for values the browser legitimately
  holds once - e.g. a freshly minted `vk-` token in a create response - never
  for a redacted-at-rest secret you cannot actually reveal.
- **Gateway PUT is a shallow top-level merge** (`{...existing, ...patch}`). A
  nested group you send _replaces_ the stored group, dropping any redacted
  secret it contains. So: diff each config group against its loaded state and
  send only changed groups (see `ProviderConfigPanel`), and warn when a save
  would clear a stored secret the operator did not re-enter.

## Status pills (`Badge`)

- `tone="muted"` for neutral labels (CUSTOM, default, counts). Prefer muted to
  stay monochrome.
- `tone="ok|warn|err|info"` only for genuine status semantics (enabled, missing
  key, error, read-only). Soft variant by default; `solid` sparingly.
- Key presence in lists: plain `"set"` / `"missing"` micro-text (muted /
  warning), not a loud pill.

## Empty states

- `<EmptyState icon title body />`; use `tone="info"` for "feature off / coming
  later" notices. Standard analytics empty copy is **"No data available"** to
  match the reference.

## Fixed-width rails must clip

Any fixed-width flex rail (`TwoPane`'s `aside`) needs `overflow-hidden`, and any
badge/marker cluster inside a flex row needs `shrink-0`. Without both, a row
whose intrinsic content exceeds the rail paints its trailing badges OUTSIDE the
rail and on top of the neighbouring pane - the Providers overlap bug. The
combination makes a crowded row a truncation problem instead of an overlap one.
Locked by `two-pane.overflow.test.tsx`.

## Density & spacing

- Body 13.5px (`text-base`), secondary `text-sm`, micro labels `text-2xs`
  uppercase tracking-wide muted. Mono (`font-mono`) for all telemetry: ids,
  keys, latency, cost, tokens, versions.
- Control heights: `--control-h` (34px) default, `--control-h-sm` (30px) dense.
- Card padding `px-5 py-4`; section gaps `gap-4`/`gap-5`; page section spacing
  `mb-5`/`mb-6`.

## Navigation & routing

- The IA is grouped: **Overview** (Dashboard, Logs, Status) / **Gateway**
  (Providers, Model Catalog, Extensions) / **Governance** (Virtual keys, Teams,
  Customers, Pricing) / **System** (Settings).
- **Status is an Overview leaf**, not System: it answers "is the gateway healthy
  right now", which sits with Dashboard and Logs rather than with configuration.
- **Cache and Config are Settings tabs**, not views. `#/cache` and `#/config`
  are kept alive by `REDIRECTS` in `App.tsx`, which `history.replaceState`s them
  onto `#/settings/caching` and `#/settings/config`. When you fold a view into a
  tab, add the redirect - a bookmark that lands on the fallback view reads as a
  broken link, not as a reorganization.
- Hash router in `App.tsx` keys off the **first** hash segment (`baseSegment`),
  so a view owning sub-pages uses `#/<view>/<sub>` and manages its own sub-nav +
  `history.replaceState` (see `SettingsView`). Add a view by extending `NAV` +
  `renderView`; the sidebar, search, and Cmd/Ctrl-K palette pick it up
  automatically.
- **Pinned browser contract:** keep nav leaves matchable by accessible name
  `Providers`, `Status`, `Logs`, `Extensions` (unique). Do not introduce sibling
  elements whose accessible name _contains_ a pinned token (avoid a button named
  "Refresh providers" - collides with "Providers"; keep aria labels distinctive,
  e.g. "Reload configuration").

## api.ts client (Phase 3b endpoints, already wired)

`src/api.ts` owns the transport, types, and endpoint clients. Consume these; do
not add `fetch` calls in views.

- `getCatalog(): CatalogView` - `GET /api/catalog` (Model Catalog).
- `getSettings(): SettingsView` / `putSettings(update): SettingsView` -
  `/api/settings`. Each group has `{ values, sources }`; `sources[field]` is
  `default|env|override` (drive a provenance pill) and `enforcement["g.field"]`
  is whether the gateway enforces it.
- `getCodeModeVfs(binding): CodeModeVfsView` - `GET /api/mcp/codemode/vfs`.
- `getRuntime(): RuntimeView` - `GET /api/runtime` (Status > Runtime). Process
  topology, saturation, and limit state. Two of its numbers are **per-process**
  (`concurrency.*` and per-window `rateLimit`), and the UI must label them as
  such on the tile itself, not only in a footnote: under `FROSTY_WORKERS=N` an
  unqualified "12 in flight" reads as fleet-wide and under-reports load by a
  factor of N. Budgets are unaffected - those run on shared atomic counters.
  Render `workers.reason` verbatim; it is the gateway's own explanation of why
  fan-out did or did not happen.
- Providers: `getConfig`, `createProvider`, `updateProvider`, `deleteProvider`,
  `refreshModels`, `setDefaultProvider`.

All clients normalize partial/malformed bodies and (catalog) treat a 404 as
"feature off", so consumers stay total.
