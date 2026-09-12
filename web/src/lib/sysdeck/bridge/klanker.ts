// SysDeck bridge — klanker (AI Gateway / klanker-gate, "Frosty Deno")
//
// UPSTREAM ATTRIBUTION: klanker-gate is NOT SysDeck code — it is the
// "Frosty Deno" LLM gateway by TykoDev
// (https://github.com/TykoDev/klanker-gate, Apache-2.0), vendored
// unmodified at /klanker-gate in the master tarball (SysDeck adds only
// its arch/ packaging). This module is a REST *client* of the gateway
// and contains zero upstream code. Full credit notes:
// klanker-gate/ATTRIBUTION.md + the cockpit THIRD_PARTY.md.
//
// Integrates the vendored klanker-gate LLM gateway (a Deno 2 OpenAI-
// compatible gateway, normally http://127.0.0.1:8080): provider
// accounts, virtual keys, request logs, spend and runtime topology.
// Every command is a LIVE fetch from KLANKER_URL (Bearer
// KLANKER_ADMIN_TOKEN when set — the token value is never echoed into
// any response or note). When the gateway is not running, the honest
// offline answer is returned with the operator wiring guidance — no
// seeded dataset, no fabricated topology.
import { ok, fail } from './shared'

const DEFAULT_BASE = 'http://127.0.0.1:8080'

function gatewayUrl(): string {
  const raw = process.env.KLANKER_URL || DEFAULT_BASE
  return raw.replace(/\/+$/, '')
}

function liveNote(): string {
  return `live fetch from ${gatewayUrl()} (1.5s timeout)`
}

function offlineNote(): string {
  return `klanker-gate at ${gatewayUrl()} did not answer within the 1.5s probe — start the gateway (deno task start in klanker-gate, needs PostgreSQL) and set KLANKER_URL (and KLANKER_ADMIN_TOKEN when the gateway runs with FROSTY_ADMIN_TOKEN); this panel shows zero rows until the real gateway answers`
}

function offline(summary: string) {
  return { ...fail(`${summary} — ${offlineNote()}`), source: 'live' as const }
}

/**
 * Fetch JSON from the gateway with a short timeout. Returns null on ANY
 * failure (timeout, refused, non-2xx, bad JSON). The admin token only
 * ever travels in the Authorization header — it is never included in
 * errors, notes or logged output.
 */
async function klankerFetch<T>(path: string, timeoutMs = 1500): Promise<T | null> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = process.env.KLANKER_ADMIN_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${gatewayUrl()}${path}`, {
      headers,
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ── local AI stack catalog + probes ─────────────────────────────────
// The gateway is NOT SaaS-only: ollama / lmstudio / sglang are native
// keyless provider types, and llama.cpp (llama-server) / koboldcpp /
// vLLM / TGI / any OpenAI-wire server plug in through the generic
// `openai-compatible` type (baseUrl + optional key). The catalog mirrors
// upstream packages/contracts/src/provider-registry.ts capabilities and
// packages/providers/src/openai_compat.ts default ports.

interface LocalBackend {
  id: string
  name: string
  providerType: string
  baseUrl: string
  auth: string
  caps: string
  envWiring?: string
  note: string
}

const LOCAL_BACKENDS: LocalBackend[] = [
  {
    id: 'ollama',
    name: 'Ollama',
    providerType: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    auth: 'none',
    caps: 'streaming · tools · embeddings',
    envWiring: 'OLLAMA_BASE_URL=http://127.0.0.1:11434/v1\nOLLAMA_MODELS=qwen3:14b,llama3.1:8b,nomic-embed-text',
    note: 'native provider type — keyless local daemon',
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp (llama-server)',
    providerType: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8081/v1',
    auth: 'key optional',
    caps: 'streaming · tools',
    note: 'llama-server DEFAULTS TO :8080 — the same port the gateway listens on. Run it on another port (8081 here) or move the gateway',
  },
  {
    id: 'koboldcpp',
    name: 'KoboldCpp',
    providerType: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:5001/v1',
    auth: 'key optional',
    caps: 'streaming · tools',
    note: 'koboldcpp serves the OpenAI wire on its main port',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    providerType: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    auth: 'none',
    caps: 'streaming · tools · embeddings',
    envWiring: 'LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1',
    note: 'native provider type',
  },
  {
    id: 'sglang',
    name: 'SGLang',
    providerType: 'sgl',
    baseUrl: 'http://127.0.0.1:30000/v1',
    auth: 'none',
    caps: 'streaming · tools · embeddings',
    note: 'native provider type — self-hosted serving framework',
  },
  {
    id: 'vllm',
    name: 'vLLM',
    providerType: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8000/v1',
    auth: 'key optional',
    caps: 'streaming · tools',
    note: 'via the generic openai-compatible account',
  },
]

/** Probe one local backend's OpenAI-compat /models surface. 400ms
 * timeout — a probe never blocks the panel for long, and an offline
 * daemon simply reports reachable:false. */
async function probeLocalBackend(base: string): Promise<{ reachable: boolean; latencyMs: number | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 400)
  const t0 = Date.now()
  try {
    const res = await fetch(`${base}/models`, { signal: controller.signal, cache: 'no-store' })
    return { reachable: res.ok, latencyMs: Date.now() - t0 }
  } catch {
    return { reachable: false, latencyMs: null }
  } finally {
    clearTimeout(timer)
  }
}

// ── upstream response shapes (klanker-gate apps/gateway routes) ─────

interface UpHealthz {
  status?: string
  version?: string
  timestamp?: string
}

interface UpVersion {
  version?: string
  deno?: string
}

interface UpProviderPublic {
  id: string
  type?: string
  models?: string[]
  enabled?: boolean
}

interface UpProviderHealthEntry {
  id: string
  status?: 'ok' | 'error' | 'unknown' | 'disabled'
  lastError?: string
  checkedAt?: string
}

interface UpVirtualKey {
  id: string
  name: string
  enabled?: boolean
  rateLimit?: { maxRequests: number; windowMs: number }
  budget?: { maxCostUsd?: number }
  allowedProviders?: string[]
  allowedModels?: string[]
  usedRequests?: number
  usedCostUsd?: number
  teamId?: string
}

interface UpLogEntry {
  ts: string
  level?: string
  message?: string
  path?: string
  status?: number
  durationMs?: number
  provider?: string
  model?: string
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  costMicroUsd?: number
}

interface UpLogStats {
  total?: number
  avgLatencyMs?: number
  costMicroUsd?: number
}

interface UpAnalytics {
  totals?: {
    requests?: number
    costUsd?: number
    cacheHits?: number
    cacheMisses?: number
  }
}

interface UpModelsList {
  data?: Array<{ id: string; object?: string; owned_by?: string }>
}

interface UpRuntime {
  workers?: { configured?: number; effective?: number; index?: number | null; reusePortSupported?: boolean; platform?: string; reason?: string }
  concurrency?: Record<string, unknown>
  rateLimit?: { enforced?: boolean; keysWithLimits?: number; totalKeys?: number; scope?: string; windows?: Array<{ keyId: string; maxRequests?: number; windowMs?: number }> }
  postgres?: { poolSize?: number; estimatedFleetConnections?: number; target?: string; listenerActive?: boolean }
  cache?: { mode?: string; sharedTier?: boolean; localEntries?: number }
  process?: { uptimeSeconds?: number; denoVersion?: string; v8Version?: string }
}

// ── normalized views ─────────────────────────────────────────────────

export interface RuntimeView {
  workers: { configured: number; effective: number; index: number | null; reusePortSupported: boolean; platform: string; reason: string }
  concurrency: { active: number; peak: number; total: number; completed: number; avgLifetimeMs: number; maxLifetimeMs: number; longestOpenMs: number; dispatching: number; peakDispatching: number; since: string; scope: string }
  rateLimit: { enforced: boolean; keysWithLimits: number; totalKeys: number; scope: string; windows: Array<{ keyId: string; maxRequests?: number; windowMs: number }> }
  postgres: { poolSize: number; estimatedFleetConnections: number; target: string; listenerActive: boolean }
  cache: { mode: string; sharedTier: boolean; localEntries: number }
  process: { uptimeSeconds: number | null; denoVersion: string; v8Version: string }
  gatewayUrl: string
}

// ── live mappers ─────────────────────────────────────────────────────

function surfaceFromPath(path?: string): string {
  if (!path) return '—'
  if (path.startsWith('/anthropic')) return 'anthropic'
  if (path.startsWith('/genai') || path.startsWith('/v1beta')) return 'gemini'
  if (path.startsWith('/openrouter')) return 'openrouter'
  if (path.startsWith('/cohere')) return 'cohere'
  if (path.startsWith('/openai') || path.startsWith('/v1')) return 'openai'
  if (path.startsWith('/api/')) return 'admin'
  return 'other'
}

function num(v: unknown, dflt = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

function normalizeRuntime(r: UpRuntime): RuntimeView {
  const c = r.concurrency ?? {}
  const w = r.workers ?? {}
  return {
    workers: {
      configured: num(w.configured, 1),
      effective: num(w.effective, 1),
      index: w.index ?? null,
      reusePortSupported: Boolean(w.reusePortSupported),
      platform: String(w.platform ?? 'unknown'),
      reason: String(w.reason ?? ''),
    },
    concurrency: {
      active: num(c.active),
      peak: num(c.peak),
      total: num(c.total),
      completed: num(c.completed),
      avgLifetimeMs: num(c.avgLifetimeMs),
      maxLifetimeMs: num(c.maxLifetimeMs),
      longestOpenMs: num(c.longestOpenMs),
      dispatching: num(c.dispatching),
      peakDispatching: num(c.peakDispatching),
      since: String(c.since ?? ''),
      scope: 'per-process',
    },
    rateLimit: {
      enforced: Boolean(r.rateLimit?.enforced),
      keysWithLimits: num(r.rateLimit?.keysWithLimits),
      totalKeys: num(r.rateLimit?.totalKeys),
      scope: String(r.rateLimit?.scope ?? 'per-process'),
      windows: (r.rateLimit?.windows ?? []).map((w2) => ({ keyId: String(w2.keyId), maxRequests: w2.maxRequests, windowMs: num(w2.windowMs) })),
    },
    postgres: {
      poolSize: num(r.postgres?.poolSize),
      estimatedFleetConnections: num(r.postgres?.estimatedFleetConnections),
      target: String(r.postgres?.target ?? 'not configured'),
      listenerActive: Boolean(r.postgres?.listenerActive),
    },
    cache: {
      mode: String(r.cache?.mode ?? 'off'),
      sharedTier: Boolean(r.cache?.sharedTier),
      localEntries: num(r.cache?.localEntries),
    },
    process: {
      uptimeSeconds: r.process?.uptimeSeconds ?? null,
      denoVersion: String(r.process?.denoVersion ?? 'unknown'),
      v8Version: String(r.process?.v8Version ?? 'unknown'),
    },
    gatewayUrl: gatewayUrl(),
  }
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  status: async () => {
    const [health, version] = await Promise.all([
      klankerFetch<UpHealthz>('/healthz'),
      klankerFetch<UpVersion>('/api/version'),
    ])
    if (health && (health.status === 'ok' || version)) {
      // gateway answered — best-effort uptime from /api/runtime
      const runtime = await klankerFetch<UpRuntime>('/api/runtime')
      return ok(
        {
          ok: health.status === 'ok',
          status: health.status ?? 'unknown',
          version: health.version ?? version?.version ?? 'unknown',
          denoVersion: version?.deno ?? 'unknown',
          uptimeSeconds: runtime?.process?.uptimeSeconds ?? null,
          gatewayUrl: gatewayUrl(),
          checkedAt: health.timestamp ?? new Date().toISOString(),
        },
        'live',
        liveNote() + ' — GET /healthz + /api/version (+ /api/runtime for uptime)',
      )
    }
    return ok(
      {
        ok: false,
        offline: true,
        status: 'offline',
        version: null,
        denoVersion: null,
        uptimeSeconds: null,
        gatewayUrl: gatewayUrl(),
        reason: 'no answer on /healthz within the 1.5s probe',
      },
      'live',
      offlineNote(),
    )
  },

  summary: async () => {
    const [analytics, stats, providers, vkeys] = await Promise.all([
      klankerFetch<UpAnalytics>('/api/analytics?window=24h'),
      klankerFetch<UpLogStats>('/api/logs/stats'),
      klankerFetch<{ providers?: UpProviderPublic[] }>('/api/providers'),
      klankerFetch<{ virtualKeys?: UpVirtualKey[] }>('/api/virtual-keys'),
    ])
    if (analytics && stats && Array.isArray(providers?.providers) && Array.isArray(vkeys?.virtualKeys)) {
      const t = analytics.totals ?? {}
      const hits = num(t.cacheHits)
      const misses = num(t.cacheMisses)
      return ok(
        {
          providers: providers?.providers?.length ?? 0,
          vkeys: vkeys?.virtualKeys?.length ?? 0,
          requests24h: num(t.requests, num(stats.total)),
          spend24hUsd: num(t.costUsd, num(stats.costMicroUsd) / 1_000_000),
          cacheHitRate: hits + misses > 0 ? Math.round((hits / (hits + misses)) * 1000) / 10 : null,
          avgLatencyMs: Math.round(num(stats.avgLatencyMs)),
        },
        'live',
        liveNote() + ' — window 24h (/api/analytics + /api/logs/stats)',
      )
    }
    return offline('gateway unreachable — no analytics window available')
  },

  providers: async () => {
    const [list, health] = await Promise.all([
      klankerFetch<{ providers?: UpProviderPublic[] }>('/api/providers'),
      klankerFetch<{ health?: UpProviderHealthEntry[] }>('/api/providers/health'),
    ])
    if (Array.isArray(list?.providers)) {
      const byId = new Map((health?.health ?? []).map((h) => [h.id, h]))
      const rows = (list?.providers ?? []).map((p) => {
        const h = byId.get(p.id)
        const status = p.enabled === false ? 'disabled' : h?.status ?? 'unknown'
        return {
          id: p.id,
          name: p.id,
          kind: p.type ?? 'unknown',
          models: p.models?.length ?? 0,
          status,
          latencyMs: null,
          note: h?.lastError ?? null,
        }
      })
      return ok(
        { providers: rows, count: rows.length },
        'live',
        liveNote() + ' — upstream /api/providers/health reports reachability, not per-provider latency',
      )
    }
    return ok({ providers: [], count: 0 }, 'live', offlineNote())
  },

  models: async () => {
    const res = await klankerFetch<UpModelsList>('/v1/models')
    if (Array.isArray(res?.data)) {
      const rows = (res?.data ?? []).map((m) => ({
        id: m.id,
        provider: m.owned_by ?? m.id.split('/')[0] ?? 'unknown',
        ownedBy: m.owned_by ?? 'unknown',
      }))
      rows.sort((a, b) => a.id.localeCompare(b.id))
      return ok({ models: rows, count: rows.length }, 'live', liveNote() + ' — ids are account-prefixed (account/model)')
    }
    return ok({ models: [], count: 0 }, 'live', offlineNote())
  },

  vkeys: async () => {
    const res = await klankerFetch<{ virtualKeys?: UpVirtualKey[] }>('/api/virtual-keys')
    if (Array.isArray(res?.virtualKeys)) {
      const rows = (res?.virtualKeys ?? []).map((k) => {
        const scoped = (k.allowedProviders?.length ?? 0) + (k.allowedModels?.length ?? 0) > 0
        const perMin =
          k.rateLimit && k.rateLimit.windowMs > 0
            ? Math.round((k.rateLimit.maxRequests * 60_000) / k.rateLimit.windowMs)
            : null
        return {
          id: k.id,
          label: k.name,
          team: k.teamId ?? null,
          scope: scoped ? 'scoped' : 'unrestricted',
          requests24h: k.usedRequests ?? 0, // upstream exposes lifetime counters
          tokens24h: null,
          costMicroUsd: Math.round((k.usedCostUsd ?? 0) * 1_000_000),
          rateLimitPerMin: perMin,
          budgetUsd: k.budget?.maxCostUsd ?? null,
          state: k.enabled === false ? 'disabled' : 'active',
        }
      })
      return ok({ vkeys: rows, count: rows.length }, 'live', liveNote() + ' — usage counters are lifetime totals upstream, not 24h')
    }
    return ok({ vkeys: [], count: 0 }, 'live', offlineNote())
  },

  logs: async (args: Record<string, unknown>) => {
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 25))
    const res = await klankerFetch<{ logs?: UpLogEntry[] }>(`/api/logs?limit=${limit}`)
    if (Array.isArray(res?.logs)) {
      const rows = (res?.logs ?? []).map((e) => ({
        ts: e.ts,
        model: e.model ?? '—',
        provider: e.provider ?? '—',
        vkey: null,
        tokensIn: e.promptTokens ?? 0,
        tokensOut: e.completionTokens ?? 0,
        costMicroUsd: e.costMicroUsd ?? 0,
        latencyMs: e.durationMs ?? null,
        status: e.status ?? null,
        cacheHit: null,
        surface: surfaceFromPath(e.path),
      }))
      return ok({ logs: rows, count: rows.length, limit }, 'live', liveNote() + ` — live ring buffer, newest first (limit ${limit})`)
    }
    return ok({ logs: [], count: 0, limit }, 'live', offlineNote())
  },

  localstack: async () => {
    // Always LIVE (the probes run from this host regardless of gateway
    // state): each backend's OpenAI-compat /models surface gets a 400ms
    // GET; green = that local daemon answered on this machine. This is
    // the wiring aid for an all-local inference stack — the same ports
    // the gateway's provider accounts point at.
    const backends = await Promise.all(
      LOCAL_BACKENDS.map(async (b) => {
        const probe = await probeLocalBackend(b.baseUrl)
        return { ...b, reachable: probe.reachable, latencyMs: probe.latencyMs }
      }),
    )
    const reachable = backends.filter((b) => b.reachable).length
    const auth = "-H 'Authorization: Bearer $KLANKER_ADMIN_TOKEN' -H 'content-type: application/json'"
    const adminRegisterExample = [
      `curl -s ${gatewayUrl()}/api/providers ${auth} -d '{"id":"llama-server","type":"openai-compatible","baseUrl":"http://127.0.0.1:8081/v1","enabled":true,"models":["qwen2.5-coder-7b"]}'`,
      `curl -s ${gatewayUrl()}/api/providers ${auth} -d '{"id":"koboldcpp","type":"openai-compatible","baseUrl":"http://127.0.0.1:5001/v1","enabled":true,"models":["mistral-nemo-12b"]}'`,
      `# auto-discover the model catalog after registering:`,
      `curl -s -X POST ${gatewayUrl()}/api/providers/llama-server/refresh-models -H 'Authorization: Bearer $KLANKER_ADMIN_TOKEN'`,
    ].join('\n')
    return ok(
      {
        backends,
        count: backends.length,
        reachable,
        gatewayUrl: gatewayUrl(),
        adminRegisterExample,
      },
      'live',
      `probed from the web-console host (400ms timeout each): ${reachable}/${backends.length} local backends answered /v1/models. ollama + lmstudio + sglang register via env; llama.cpp + koboldcpp + vllm register as openai-compatible accounts (env registers ONE such account — use POST /api/providers for several). Port note: llama-server defaults to :8080, the gateway's own port`,
    )
  },

  runtime: async () => {
    const r = await klankerFetch<UpRuntime>('/api/runtime')
    if (r) {
      return ok(normalizeRuntime(r), 'live', liveNote() + ' — workers topology, cache tier and pg pool as served by the gateway')
    }
    return offline('gateway unreachable — no runtime topology available')
  },
}
