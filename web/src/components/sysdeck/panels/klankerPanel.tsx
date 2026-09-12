'use client'

import { useState } from 'react'

// AI Gateway panel — klanker-gate ("Frosty Deno") LLM gateway client.
//
// UPSTREAM ATTRIBUTION: this panel is a client of klanker-gate, the
// "Frosty Deno" LLM gateway by TykoDev (https://github.com/TykoDev/
// klanker-gate, Apache-2.0) — vendored unmodified at /klanker-gate in
// the master tarball. klanker-gate is NOT SysDeck code and none of it
// is contained here (credit: klanker-gate/ATTRIBUTION.md + the
// cockpit THIRD_PARTY.md); SysDeck adds only the Arch packaging.
//
// LIVE like the other service-client panels: every command fetches the
// real gateway server-side (KLANKER_URL, 1.5s timeout, bearer admin
// token when configured). An unreachable gateway returns the honest
// offline answer with wiring guidance — empty tables, never a seeded
// fallback. All calls go through the suite's bridge client
// (POST /api/bridge), never a direct fetch.
// Upstream money convention: integer micro-USD everywhere, displayed
// here as USD by /1e6.

import {
  Activity,
  Check,
  Coins,
  Copy,
  Globe,
  KeyRound,
  Server,
  Timer,
  WifiOff,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import { useBridgeQuery } from '@/lib/sysdeck/client'
import {
  DataTable,
  ErrorCard,
  KV,
  Mono,
  PanelCard,
  PanelHeader,
  PanelSkeleton,
  SourceBadge,
  StatCard,
} from '@/components/sysdeck/ui'
import { TableCell } from '@/components/ui/table'

// ── bridge shapes ────────────────────────────────────────────────────

interface KlankerStatus {
  ok: boolean
  offline?: boolean
  status: string
  version: string
  denoVersion: string
  uptimeSeconds: number | null
  gatewayUrl: string
  reason?: string
  checkedAt?: string
}

interface KlankerSummary {
  providers: number
  vkeys: number
  requests24h: number
  spend24hUsd: number
  cacheHitRate: number | null
  avgLatencyMs: number
}

interface KlankerProvider {
  id: string
  name: string
  kind: string
  models: number
  status: string
  latencyMs: number | null
  note?: string | null
}

interface KlankerModel {
  id: string
  provider: string
  ownedBy: string
}

interface KlankerVKey {
  id: string
  label: string
  team: string | null
  scope: string
  requests24h: number
  tokens24h: number | null
  costMicroUsd: number
  rateLimitPerMin: number | null
  budgetUsd: number | null
  state: string
}

interface KlankerLog {
  ts: string
  model: string
  provider: string
  vkey: string | null
  tokensIn: number
  tokensOut: number
  costMicroUsd: number
  latencyMs: number | null
  status: number | null
  cacheHit: boolean | null
  surface: string
}

interface KlankerRuntime {
  workers: { configured: number; effective: number; index: number | null; reusePortSupported: boolean; platform: string; reason: string }
  concurrency: { active: number; peak: number; total: number; completed: number; dispatching: number; peakDispatching: number; since: string; scope: string }
  rateLimit: { enforced: boolean; keysWithLimits: number; totalKeys: number; scope: string }
  postgres: { poolSize: number; estimatedFleetConnections: number; target: string; listenerActive: boolean }
  cache: { mode: string; sharedTier: boolean; localEntries: number }
  process: { uptimeSeconds: number | null; denoVersion: string; v8Version: string }
  gatewayUrl: string
}

// ── helpers ──────────────────────────────────────────────────────────

/** micro-USD (the upstream repo-wide unit) → `$X.XXXX` display. */
function fmtUsd(micro: number): string {
  const usd = micro / 1_000_000
  return usd === 0 ? '$0' : `$${usd.toFixed(4)}`
}

function fmtUptime(s: number): string {
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}

const PROVIDER_STATUS_DOT: Record<string, string> = {
  ok: 'bg-emerald-500',
  error: 'bg-red-500',
  disabled: 'bg-amber-500',
  unknown: 'bg-zinc-500',
}

function httpCls(status: number | null): string {
  if (status === null) return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'
  if (status >= 500) return 'bg-red-500/15 text-red-500 border-red-500/30'
  if (status >= 400) return 'bg-amber-500/15 text-amber-500 border-amber-500/30'
  return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
}

// ── local stack (probed wiring aid) ─────────────────────────────

interface LocalBackendView {
  id: string
  name: string
  providerType: string
  baseUrl: string
  auth: string
  caps: string
  envWiring?: string
  note: string
  reachable: boolean
  latencyMs: number | null
}

interface KlankerLocalStack {
  ok: boolean
  backends: LocalBackendView[]
  count: number
  reachable: number
  gatewayUrl: string
  adminRegisterExample: string
  note?: string
}

/** Small copy-to-clipboard code block (env/curl wiring examples). */
function CopyBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      toast.success('Copied to clipboard')
      setTimeout(() => setCopied(false), 1600)
    } catch {
      toast.error('Clipboard unavailable — select the text manually')
    }
  }
  return (
    <div className="rounded-lg border border-border/70 bg-muted/40">
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1 rounded border border-border/70 bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          aria-label={copied ? 'Copied' : `Copy ${label} to clipboard`}
        >
          {copied ? <Check className="h-3 w-3 text-emerald-400" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="sd-scroll max-h-40 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground">{code}</pre>
    </div>
  )
}

export default function KlankerPanel() {
  const statusQ = useBridgeQuery<KlankerStatus>('klanker', 'status', undefined, { refetchInterval: 5000 })
  const summaryQ = useBridgeQuery<KlankerSummary>('klanker', 'summary', undefined, { refetchInterval: 5000 })
  const logsQ = useBridgeQuery<{ logs: KlankerLog[]; count: number; limit: number }>('klanker', 'logs', { limit: 40 }, { refetchInterval: 5000 })
  const providersQ = useBridgeQuery<{ providers: KlankerProvider[]; count: number }>('klanker', 'providers', undefined, { refetchInterval: 10000 })
  const vkeysQ = useBridgeQuery<{ vkeys: KlankerVKey[]; count: number }>('klanker', 'vkeys', undefined, { refetchInterval: 10000 })
  const modelsQ = useBridgeQuery<{ models: KlankerModel[]; count: number }>('klanker', 'models', undefined, { refetchInterval: 30000 })
  const runtimeQ = useBridgeQuery<KlankerRuntime>('klanker', 'runtime', undefined, { refetchInterval: 10000 })
  const localstackQ = useBridgeQuery<KlankerLocalStack>('klanker', 'localstack', undefined, { refetchInterval: 30000 })
  const localstack = localstackQ.data?.data

  if (statusQ.isLoading && !statusQ.data) {
    return (
      <div>
        <PanelHeader title="AI Gateway" subtitle="klanker-gate · frosty deno — local stack (ollama · llama.cpp · koboldcpp) + providers, vkeys, spend & runtime" />
        <PanelSkeleton lines={4} />
      </div>
    )
  }

  if (statusQ.data && !statusQ.data.ok) {
    return (
      <div>
        <PanelHeader title="AI Gateway" subtitle="klanker-gate · frosty deno — local stack (ollama · llama.cpp · koboldcpp) + providers, vkeys, spend & runtime" />
        <ErrorCard error={statusQ.data.error ?? 'klanker.status failed'} />
      </div>
    )
  }

  const st = statusQ.data?.data
  const s = summaryQ.data?.data
  const rt = runtimeQ.data?.data
  const providers = providersQ.data?.data?.providers ?? []
  const vkeys = vkeysQ.data?.data?.vkeys ?? []
  const models = modelsQ.data?.data?.models ?? []
  const logs = logsQ.data?.data?.logs ?? []
  const logLimit = logsQ.data?.data?.limit ?? 25

  const isOffline = st?.offline === true || st?.ok === false
  const gatewayUrl = st?.gatewayUrl ?? 'http://127.0.0.1:8080'
  const activeKeys = vkeys.filter((v) => v.state === 'active').length
  const cacheRate = s?.cacheHitRate ?? null

  return (
    <div className="space-y-4 pb-2">
      <PanelHeader
        title="AI Gateway"
        subtitle="klanker-gate · frosty deno — local stack (ollama · llama.cpp · koboldcpp) + providers, vkeys, spend & runtime"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SourceBadge source={isOffline ? 'unavailable' : 'live'} />
            <span
              className="inline-flex items-center gap-1.5 rounded border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
              title="gateway base URL (KLANKER_URL env override)"
            >
              <Globe className="h-3 w-3" aria-hidden />
              {gatewayUrl}
              {st?.version ? ` · v${st.version}` : ''}
            </span>
            <span
              className="inline-flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground"
              title="auto-refresh: status/summary/logs every 5s, fleet tables every 10s"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden />
              5s
            </span>
          </div>
        }
      />

      {/* offline notice */}
      {isOffline ? (
        <div role="status" className="rounded-md border border-amber-500/40 bg-amber-500/[0.04] p-3">
          <p className="flex items-center gap-2 text-sm font-semibold text-amber-500">
            <WifiOff className="h-4 w-4" aria-hidden />
            gateway offline — honest empty tables
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            the bridge probes <Mono>{gatewayUrl}/healthz</Mono> with a 1.5s timeout and got no answer, so the tables below
            are empty — nothing is fabricated. On a host running the gateway, set{' '}
            <Mono>KLANKER_URL</Mono> (plus <Mono>KLANKER_ADMIN_TOKEN</Mono> when it runs with{' '}
            <Mono>FROSTY_ADMIN_TOKEN</Mono>) and this panel fills with live providers, keys, requests and spend
            automatically{st?.reason ? ` (${st.reason})` : ''}.
          </p>
        </div>
      ) : null}

      {/* stat grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="providers" value={s?.providers ?? '—'} icon={<Server className="h-4 w-4" aria-hidden />} hint={`${models.length} models routed`} />
        <StatCard label="virtual keys" value={s?.vkeys ?? '—'} icon={<KeyRound className="h-4 w-4" aria-hidden />} hint={`${activeKeys} active`} />
        <StatCard label="requests · 24h" value={s?.requests24h ?? '—'} icon={<Activity className="h-4 w-4" aria-hidden />} hint="analytics window" />
        <StatCard
          label="spend · 24h"
          value={s ? `$${s.spend24hUsd.toFixed(4)}` : '—'}
          icon={<Coins className="h-4 w-4" aria-hidden />}
          hint="µUSD upstream → USD"
        />
        <StatCard
          label="cache hit rate"
          value={cacheRate === null ? '—' : `${cacheRate}%`}
          icon={<Zap className="h-4 w-4" aria-hidden />}
          tone={cacheRate !== null && cacheRate >= 15 ? 'good' : 'default'}
          hint="semantic cache replays"
        />
        <StatCard label="avg latency" value={s?.avgLatencyMs ?? '—'} unit="ms" icon={<Timer className="h-4 w-4" aria-hidden />} hint="mean over the window" />
      </div>

      {/* runtime topology */}
      {runtimeQ.data && !runtimeQ.data.ok ? (
        <ErrorCard error={runtimeQ.data.error ?? 'klanker.runtime failed'} />
      ) : (
        <PanelCard
          title="Runtime topology"
          actions={<Mono>{rt ? `${rt.workers.effective}/${rt.workers.configured} workers · cache ${rt.cache.mode}` : '…'}</Mono>}
        >
          <div className="grid gap-x-8 sm:grid-cols-2">
            <div>
              <KV k="workers" v={rt ? `${rt.workers.effective} effective / ${rt.workers.configured} configured` : '—'} />
              <KV k="platform" v={rt ? `${rt.workers.platform}${rt.workers.reusePortSupported ? ' · reusePort' : ' · no reusePort'}` : '—'} />
              <KV k="cache" v={rt ? `${rt.cache.mode}${rt.cache.sharedTier ? ' · shared L2' : ''} · ${rt.cache.localEntries} local entries` : '—'} />
              <KV k="concurrency" v={rt ? `${rt.concurrency.active} active / ${rt.concurrency.peak} peak / ${rt.concurrency.total} total` : '—'} />
            </div>
            <div>
              <KV k="postgres pool" v={rt ? `${rt.postgres.poolSize} per worker · ${rt.postgres.estimatedFleetConnections} fleet conns` : '—'} />
              <KV k="pg target" v={rt?.postgres.target ?? '—'} />
              <KV k="listener" v={rt ? (rt.postgres.listenerActive ? 'active (cross-process invalidation)' : 'inactive') : '—'} />
              <KV k="process" v={rt ? `${rt.process.denoVersion}${rt.process.uptimeSeconds !== null ? ` · up ${fmtUptime(rt.process.uptimeSeconds)}` : ''}` : '—'} />
            </div>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            worker topology spreads the port with <Mono>SO_REUSEPORT</Mono> — upstream supports it on Linux/darwin only;
            other platforms collapse to a single process ({rt?.workers.reason || 'n/a'}). Rate limits:{' '}
            {rt?.rateLimit.enforced
              ? `${rt.rateLimit.keysWithLimits}/${rt.rateLimit.totalKeys} keys limited, ${rt.rateLimit.scope}-wide budgets`
              : 'no key carries a rate-limit policy'}.
          </p>
        </PanelCard>
      )}

      {/* providers */}
      {providersQ.data && !providersQ.data.ok ? (
        <ErrorCard error={providersQ.data.error ?? 'klanker.providers failed'} />
      ) : (
        <PanelCard title="Providers" actions={<Mono>{providers.length} accounts · {models.length} models</Mono>}>
          <DataTable
            rows={providers}
            headers={['Provider', 'Kind', 'Models', 'Status', 'Latency']}
            keyOf={(p) => p.id}
            maxH="20rem"
            empty="no provider accounts configured — add one via POST /api/providers"
            renderRow={(p) => (
              <>
                <TableCell className="max-w-56 font-mono text-xs font-medium">
                  {p.name}
                  {p.note ? (
                    <span className="block truncate text-[10px] font-normal text-muted-foreground" title={p.note}>
                      {p.note}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground">{p.kind}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{p.models}</TableCell>
                <TableCell>
                  <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    <span
                      className={`h-2 w-2 rounded-full ${PROVIDER_STATUS_DOT[p.status] ?? 'bg-zinc-500'} ${p.status === 'error' ? 'animate-pulse' : ''}`}
                      aria-hidden
                    />
                    {p.status}
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{p.latencyMs !== null ? `${p.latencyMs} ms` : '—'}</TableCell>
              </>
            )}
          />
          {models.length > 0 ? (
            <div className="mt-3">
              <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                model catalog — account-prefixed ids ({models.length})
              </p>
              <div className="sd-scroll flex max-h-24 flex-wrap gap-1 overflow-y-auto">
                {models.map((m) => (
                  <span
                    key={m.id}
                    className="rounded border border-border/70 bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                    title={`owned by ${m.ownedBy}`}
                  >
                    {m.id}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </PanelCard>
      )}

      {/* local stack wiring — the gateway is not SaaS-only */}
      {localstackQ.data && !localstackQ.data.ok ? (
        <ErrorCard error={localstackQ.data.error ?? 'klanker.localstack failed'} />
      ) : (
        <PanelCard
          title="Local stack wiring"
          actions={
            <Mono>
              {localstack ? `${localstack.reachable}/${localstack.count} reachable` : 'probing…'} · 30s poll
            </Mono>
          }
        >
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
            klanker-gate is <span className="font-semibold text-foreground">not SaaS-only</span>: ollama, LM Studio and
            SGLang are native <span className="font-semibold text-foreground">keyless</span> provider types, and llama.cpp
            (llama-server), KoboldCpp and vLLM plug in through the generic <Mono>openai-compatible</Mono> type — your
            entire inference stack can run local, with zero API keys and zero marginal cost. The rows below are{' '}
            <span className="font-semibold text-foreground">live probes</span> of each backend's{' '}
            <Mono>/v1/models</Mono> surface from this host (400ms timeout).
          </p>
          <DataTable
            rows={localstack?.backends ?? []}
            headers={['Backend', 'Provider type', 'Base URL (probed)', 'Status', 'Capabilities']}
            keyOf={(b) => b.id}
            maxH="18rem"
            empty="no local backends cataloged"
            renderRow={(b) => (
              <>
                <TableCell className="font-mono text-xs font-medium" title={b.note}>
                  {b.name}
                </TableCell>
                <TableCell>
                  <span className="rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {b.providerType}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground">{b.baseUrl}</TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    <span
                      className={`h-2 w-2 rounded-full ${b.reachable ? 'bg-emerald-400' : 'bg-zinc-600'} ${b.reachable ? '' : 'opacity-70'}`}
                      aria-hidden
                    />
                    {b.reachable ? `up · ${b.latencyMs}ms` : 'offline'}
                  </span>
                </TableCell>
                <TableCell className="text-[11px] text-muted-foreground">{b.caps}</TableCell>
              </>
            )}
          />
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <CopyBlock
              label="env wiring — gateway .env (ollama · lmstudio · one openai-compatible)"
              code={(localstack?.backends ?? [])
                .filter((b) => b.envWiring)
                .map((b) => b.envWiring)
                .join('\n')}
            />
            <CopyBlock
              label="admin API — register llama.cpp / koboldcpp as separate accounts"
              code={localstack?.adminRegisterExample ?? ''}
            />
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            Env registers one account per provider type; to run llama.cpp <em>and</em> koboldcpp (and vLLM) side by side,
            register each with <Mono>POST /api/providers</Mono> as above, then{' '}
            <Mono>POST /api/providers/:id/refresh-models</Mono> auto-discovers its catalog. Port note: llama-server
            defaults to <Mono>:8080</Mono> — the gateway's own port — so run it elsewhere (8081 here) or move the
            gateway.
          </p>
        </PanelCard>
      )}

      {/* virtual keys */}
      {vkeysQ.data && !vkeysQ.data.ok ? (
        <ErrorCard error={vkeysQ.data.error ?? 'klanker.vkeys failed'} />
      ) : (
        <PanelCard title="Virtual keys" actions={<Mono>{vkeys.length} keys · {activeKeys} active</Mono>}>
          <DataTable
            rows={vkeys}
            headers={['Label', 'Team', 'Requests 24h', 'Tokens 24h', 'Rate limit', 'State']}
            keyOf={(v) => v.id}
            maxH="20rem"
            empty="no virtual keys — traffic runs keyless (unmetered)"
            renderRow={(v) => (
              <>
                <TableCell className="max-w-48 font-mono text-xs font-medium" title={`${v.scope}${v.budgetUsd !== null ? ` · budget $${v.budgetUsd}` : ''}`}>
                  {v.label}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{v.team ?? '—'}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{v.requests24h.toLocaleString('en-US')}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {v.tokens24h !== null ? v.tokens24h.toLocaleString('en-US') : '—'}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {v.rateLimitPerMin !== null ? `${v.rateLimitPerMin}/min` : '—'}
                </TableCell>
                <TableCell>
                  <span
                    className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${
                      v.state === 'active'
                        ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                        : 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'
                    }`}
                  >
                    {v.state}
                  </span>
                </TableCell>
              </>
            )}
          />
        </PanelCard>
      )}

      {/* request log */}
      {logsQ.data && !logsQ.data.ok ? (
        <ErrorCard error={logsQ.data.error ?? 'klanker.logs failed'} />
      ) : (
        <PanelCard title="Request log" actions={<Mono>{logs.length} newest · limit {logLimit}</Mono>}>
          <DataTable
            rows={logs}
            headers={['Time', 'Model', 'Provider', 'Tokens in/out', 'Cost', 'Latency', 'HTTP', 'Cache']}
            keyOf={(l, i) => `${l.ts}-${i}`}
            maxH="24rem"
            empty="no requests in the log window"
            renderRow={(l) => (
              <>
                <TableCell className="whitespace-nowrap font-mono text-[11px] text-muted-foreground" title={`${l.ts} UTC`}>
                  {l.ts.slice(11, 19)}
                </TableCell>
                <TableCell className="max-w-52 truncate font-mono text-xs" title={`${l.model} · surface ${l.surface} · ${l.vkey ?? 'keyless'}`}>
                  {l.model}
                </TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground">{l.provider}</TableCell>
                <TableCell className="whitespace-nowrap text-right font-mono text-xs tabular-nums">
                  {l.tokensIn.toLocaleString('en-US')} / {l.tokensOut.toLocaleString('en-US')}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{fmtUsd(l.costMicroUsd)}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{l.latencyMs !== null ? `${l.latencyMs} ms` : '—'}</TableCell>
                <TableCell>
                  <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${httpCls(l.status)}`}>
                    {l.status ?? '—'}
                  </span>
                </TableCell>
                <TableCell>
                  {l.cacheHit === true ? (
                    <span className="rounded border border-teal-500/30 bg-teal-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-teal-400">
                      hit
                    </span>
                  ) : (
                    <span className="font-mono text-[10px] text-muted-foreground">·</span>
                  )}
                </TableCell>
              </>
            )}
          />
        </PanelCard>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">
        LIVE: every command fetches the gateway server-side (<Mono>KLANKER_URL</Mono>, 1.5s timeout,{' '}
        <Mono>Bearer</Mono> admin token when configured — the token never reaches this page). An unreachable gateway
        leaves the tables honestly empty; a running one fills them automatically. Costs are integer micro-USD
        upstream (the repo-wide convention), displayed as USD by /1e6. Live per-key usage counters are lifetime totals
        upstream; the 24h aggregates come from <Mono>/api/analytics</Mono>.
      </p>

      {/* upstream attribution — klanker-gate is not SysDeck code */}
      <p className="border border-border/60 rounded-lg bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        <span className="font-semibold text-foreground">Upstream project:</span>{' '}
        <a
          href="https://github.com/TykoDev/klanker-gate"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-teal-400 underline decoration-teal-400/40 underline-offset-2 hover:decoration-teal-400"
        >
          klanker-gate
        </a>{' '}
        — the “Frosty Deno” LLM gateway by <span className="font-semibold text-foreground">TykoDev</span> ·
        Apache-2.0 · vendored unmodified in the master tarball (SysDeck adds only the <Mono>arch/</Mono> packaging).
        This panel is a REST client of the gateway and contains no upstream code.
      </p>
    </div>
  )
}
