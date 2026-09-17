'use client'

// Themes panel — the theme engine console. Swatch cards render a mini
// preview strip from a local palette map of the [data-sd-theme] CSS var
// blocks in globals.css; clicking applies the theme immediately via
// document.documentElement.dataset.sdTheme (the same mechanism the
// header quick-switch uses) and persists through the themes bridge.

import { toast } from 'sonner'
import { Check, Palette } from 'lucide-react'
import { useBridgeAction, useBridgeQuery } from '@/lib/sysdeck/client'
import { applySdTheme } from '@/lib/sysdeck/theme'
import { ErrorCard, HintCard, Mono, PanelHeader, PanelSkeleton, StatCard } from '@/components/sysdeck/ui'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
// panel mounts its own (only one panel is live at a time, so no duplicates)

// ── bridge shapes ────────────────────────────────────────────────────

interface ThemeMeta {
  id: string
  name: string
  description: string
}

// ── local palette map (mirrors globals.css [data-sd-theme] blocks) ───

const PALETTES: Record<string, string[]> = {
  // [background, card, primary, muted, foreground]
  midnight: ['#1e1e1e', '#2a2f38', '#3fc9b0', '#8a8f98', '#f0f0f0'],
  carbon: ['#0b0b0b', '#141414', '#5cb5aa', '#6f6f6f', '#e6e6e6'],
  phosphor: ['#0f1f12', '#17301f', '#38d984', '#7fa383', '#b9f5c9'],
  amber: ['#1f1405', '#2a1d09', '#f2a53d', '#a88d5f', '#f5d9a8'],
  paper: ['#f5f5f4', '#ffffff', '#147d75', '#737373', '#333333'],
  arctic: ['#eef2f5', '#ffffff', '#4ea8dd', '#7d8fa0', '#3a4653'],
}

// ── panel ────────────────────────────────────────────────────────────

export default function ThemesPanel() {
  const q = useBridgeQuery<{ themes: ThemeMeta[]; active: string }>('themes', 'list')
  const action = useBridgeAction()

  const data = q.data?.data
  const active = data?.active ?? 'midnight'

  async function applyTheme(t: ThemeMeta) {
    const previous = active
    // applySdTheme is the one decision point: dataset key + tailwind dark
    // class + light-theme mapping stay in sync with the shell quick-switch.
    applySdTheme(t.id)
    const res = await action('themes', 'setActive', { theme: t.id })
    if (res.ok) {
      // mirror for the login screen (the bridge is session-gated; the
      // pre-auth login screen reads localStorage)
      try {
        localStorage.setItem('sd_theme', t.id)
      } catch {
        /* non-fatal */
      }
      toast.success(`theme switched — ${t.name}`, {
        description: 'the whole suite re-themes live; persisted through the themes bridge (ThemeSetting)',
      })
    } else {
      // the bridge refused the id — the DOM follows the persisted truth
      applySdTheme(previous)
      toast.error('setActive failed', { description: res.error })
    }
  }

  if (q.isLoading && !q.data) return <PanelSkeleton lines={2} />
  if (q.data && !q.data.ok) return <ErrorCard error={q.data.error ?? 'themes.list failed'} />

  return (
    <div className="space-y-4 pb-2">
      <PanelHeader
        title="Themes"
        subtitle="theme engine — live-switch the whole suite between console themes"
        source="live"
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Themes" value={data?.themes?.length ?? '—'} icon={<Palette className="h-4 w-4" aria-hidden />} hint="console palettes in the registry" />
        <StatCard label="Active" value={<span className="capitalize">{active}</span>} hint="html[data-sd-theme]" />
        <StatCard label="Persistence" value="ThemeSetting" hint="themes bridge · key 'active'" />
        <StatCard label="Scope" value="suite-wide" hint="sidebar, panels, footer, charts" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(data?.themes ?? []).map((t) => {
          const isActive = t.id === active
          const palette = PALETTES[t.id] ?? ['#666', '#888', '#3fc9b0', '#999', '#eee']
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => void applyTheme(t)}
              aria-pressed={isActive}
              aria-label={`Apply theme ${t.name}`}
              className={cn(
                'group rounded-xl border bg-card p-4 text-left transition-all hover:border-primary/50',
                isActive ? 'border-primary/60 ring-2 ring-primary/30' : 'border-border',
              )}
            >
              {/* mini preview strip */}
              <div className="flex h-7 overflow-hidden rounded-md ring-1 ring-border/60" aria-hidden>
                {palette.map((c, i) => (
                  <span key={i} className="h-full flex-1" style={{ background: c }} />
                ))}
              </div>

              <div className="mt-3 flex items-center justify-between gap-2">
                <p className="flex items-center gap-2 font-semibold">
                  {t.name}
                  {isActive ? (
                    <span className="flex items-center gap-1 text-primary">
                      <Check className="h-3.5 w-3.5" aria-hidden />
                      <Mono>active</Mono>
                    </span>
                  ) : null}
                </p>
                {isActive ? (
                  <Badge variant="outline" className="border-primary/40 font-mono text-[10px] text-primary">
                    LIVE
                  </Badge>
                ) : (
                  <span className="font-mono text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                    click to apply
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
              <p className="mt-2 font-mono text-[10px] text-muted-foreground">[data-sd-theme='{t.id}']</p>
            </button>
          )
        })}
      </div>

      <HintCard title="How the engine works">
        <p>
          Every theme is a <span className="font-mono text-xs">[data-sd-theme]</span> block of CSS variables in{' '}
          <span className="font-mono text-xs">globals.css</span> — the ported cockpit edition palette registry. Switching
          rewrites <span className="font-mono text-xs">html[data-sd-theme]</span>, so the sidebar, panels, footer ticker
          and recharts colors re-skin instantly with no reload.
        </p>
        <p>
          The header quick-switch (moon icon) uses the same <span className="font-mono text-xs">themes.setActive</span>{' '}
          bridge command — this panel and the header stay in sync through the persisted{' '}
          <span className="font-mono text-xs">ThemeSetting</span> row.
        </p>
      </HintCard>
    </div>
  )
}
