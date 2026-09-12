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
// The gateway CANNOT run in this sandbox (no Deno runtime, no
// PostgreSQL), so every command is LIVE-FIRST: a short 1.5s probe of
// KLANKER_URL (Bearer KLANKER_ADMIN_TOKEN when set — the token value
// is never echoed into any response or note) and, on any failure, a
// seeded demo dataset (KlankerProvider / KlankerVKey /
// KlankerLogEntry rows). On a host where the gateway actually runs,
// the same calls flip the panel to source:'live' automatically.
import { db } from '@/lib/db'
import { ok } from './shared'

const DEMO_VERSION = '0.9.0' // klanker-gate apps/gateway/context.ts VERSION
const DEFAULT_BASE = 'http://127.0.0.1:8080'

function gatewayUrl(): string {
  const raw = process.env.KLANKER_URL || DEFAULT_BASE
  return raw.replace(/\/+$/, '')
}

function liveNote(): string {
  return `live fetch from ${gatewayUrl()} (1.5s timeout)`
}

function demoNote(): string {
  return `klanker-gate at ${gatewayUrl()} did not answer within the 1.5s probe — this sandbox has no Deno runtime or PostgreSQL, so a seeded demo dataset is shown. Set KLANKER_URL (and KLANKER_ADMIN_TOKEN when the gateway runs with FROSTY_ADMIN_TOKEN) on a real gateway host and this panel goes live`
}

/**
 * Fetch JSON from the gateway with a short timeout. Returns null on ANY
 * failure (timeout, refused, non-2xx, bad JSON) so callers fall back to
 * demo data. The admin token only ever travels in the Authorization
 * header — it is never included in errors, notes or logged output.
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

// ── normalized views returned to the panel (live + demo share them) ──

export interface RuntimeView {
  workers: { configured: number; effective: number; index: number | null; reusePortSupported: boolean; platform: string; reason: string }
  concurrency: { active: number; peak: number; total: number; completed: number; avgLifetimeMs: number; maxLifetimeMs: number; longestOpenMs: number; dispatching: number; peakDispatching: number; since: string; scope: string }
  rateLimit: { enforced: boolean; keysWithLimits: number; totalKeys: number; scope: string; windows: Array<{ keyId: string; maxRequests?: number; windowMs: number }> }
  postgres: { poolSize: number; estimatedFleetConnections: number; target: string; listenerActive: boolean }
  cache: { mode: string; sharedTier: boolean; localEntries: number }
  process: { uptimeSeconds: number | null; denoVersion: string; v8Version: string }
  gatewayUrl: string
}

// ── demo seed (v2 — LOCAL-STACK-FIRST: ollama + llama.cpp + koboldcpp
// + lmstudio + sglang + one groq contrast row; mirrors an operator
// whose inference is entirely local with a single cloud fallback) ────

const SEED_VERSION = 2

const PROVIDER_MODEL_CATALOG: Record<string, string[]> = {
  ollama: ['qwen3:14b', 'llama3.1:8b', 'nomic-embed-text'],
  'llama-server': ['qwen2.5-coder-7b', 'llama-3.1-8b-instruct'],
  koboldcpp: ['mistral-nemo-12b'],
  lmstudio: ['qwen2.5-14b-instruct'],
  sglang: ['deepseek-r1-distill-32b'],
  groq: ['llama-3.3-70b-versatile'],
}

const PROVIDER_SEEDS = [
  { name: 'ollama', kind: 'ollama', models: 3, status: 'ok', latencyMs: 41, note: 'local daemon 127.0.0.1:11434 — native provider type, no api key, zero marginal cost' },
  { name: 'llama-server', kind: 'openai-compatible', models: 2, status: 'ok', latencyMs: 63, note: 'llama.cpp llama-server on 127.0.0.1:8081 — generic openai-compatible account, no key' },
  { name: 'koboldcpp', kind: 'openai-compatible', models: 1, status: 'ok', latencyMs: 71, note: 'koboldcpp on 127.0.0.1:5001 — serves the OpenAI wire on its main port' },
  { name: 'lmstudio', kind: 'lmstudio', models: 1, status: 'ok', latencyMs: 55, note: 'lm studio on 127.0.0.1:1234 — native provider type' },
  { name: 'sglang', kind: 'sgl', models: 1, status: 'ok', latencyMs: 82, note: 'sglang on 127.0.0.1:30000 — native provider type' },
  { name: 'groq', kind: 'groq', models: 1, status: 'ok', latencyMs: 118, note: 'the one cloud fallback — llama-3.3-70b for burst overflow' },
]

const VKEY_SEEDS = [
  { label: 'local-agent', team: 'personal', scope: 'ollama + llama-server + koboldcpp', requests24h: 0, tokens24h: 0, costMicroUsd: 0, rateLimitPerMin: 120, budgetUsd: null, state: 'active' },
  { label: 'coding-assistant', team: 'personal', scope: 'scoped: qwen2.5-coder-7b', requests24h: 0, tokens24h: 0, costMicroUsd: 0, rateLimitPerMin: 60, budgetUsd: null, state: 'active' },
  { label: 'batch-embed', team: 'personal', scope: 'scoped: nomic-embed-text', requests24h: 0, tokens24h: 0, costMicroUsd: 0, rateLimitPerMin: 30, budgetUsd: null, state: 'active' },
  { label: 'cloud-overflow', team: 'personal', scope: 'groq only (fallback tier)', requests24h: 0, tokens24h: 0, costMicroUsd: 0, rateLimitPerMin: 30, budgetUsd: 5, state: 'active' },
  { label: 'legacy-ops', team: 'ops', scope: 'unrestricted', requests24h: 0, tokens24h: 0, costMicroUsd: 0, rateLimitPerMin: null, budgetUsd: null, state: 'disabled' },
]

// demo model pool — in/out rates in µUSD PER TOKEN (the repo-wide unit
// is integer micro-USD; e.g. gpt-4o = $2.50/1M in = 2.5 µUSD/token).
interface DemoModel {
  id: string
  provider: string
  surface: string
  inRate: number
  outRate: number
}

const DEMO_MODELS: DemoModel[] = [
  { id: 'qwen3:14b', provider: 'ollama', surface: 'openai', inRate: 0, outRate: 0 },
  { id: 'llama3.1:8b', provider: 'ollama', surface: 'openai', inRate: 0, outRate: 0 },
  { id: 'nomic-embed-text', provider: 'ollama', surface: 'openai', inRate: 0, outRate: 0 },
  { id: 'qwen2.5-coder-7b', provider: 'llama-server', surface: 'openai', inRate: 0, outRate: 0 },
  { id: 'mistral-nemo-12b', provider: 'koboldcpp', surface: 'openai', inRate: 0, outRate: 0 },
  { id: 'qwen2.5-14b-instruct', provider: 'lmstudio', surface: 'openai', inRate: 0, outRate: 0 },
  { id: 'deepseek-r1-distill-32b', provider: 'sglang', surface: 'openai', inRate: 0, outRate: 0 },
  { id: 'llama-3.3-70b-versatile', provider: 'groq', surface: 'openai', inRate: 0.059, outRate: 0.079 },
]

/** Deterministic PRNG so a re-seed reproduces the same 24h window. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

const OLLAMA_MAIN_MODEL = DEMO_MODELS.find((m) => m.id === 'qwen3:14b')
const GROQ_MODEL = DEMO_MODELS.find((m) => m.provider === 'groq')
const CACHE_MODEL = OLLAMA_MAIN_MODEL

const ACTIVE_VK_LABELS = VKEY_SEEDS.filter((v) => v.state === 'active').map((v) => v.label)

interface DemoLogRow {
  ts: Date
  model: string
  provider: string
  vkey: string | null
  tokensIn: number
  tokensOut: number
  costMicroUsd: number
  latencyMs: number
  status: number
  cacheHit: boolean
  surface: string
}

function buildDemoLogs(): DemoLogRow[] {
  const rand = lcg(0x5eed)
  const rows: DemoLogRow[] = []
  for (let i = 0; i < 40; i++) {
    // a 6-entry semantic-cache HIT streak on the ollama main model mid-day
    const streak = i >= 12 && i <= 17
    const m = streak
      ? CACHE_MODEL
      : i === 21
        ? DEMO_MODELS.find((x) => x.provider === 'koboldcpp') // 502 — koboldcpp restarted mid-request
        : i === 33
          ? GROQ_MODEL // 429 — burst overflow hit the cloud fallback's rate limit
          : DEMO_MODELS[i % DEMO_MODELS.length]
    if (!m) continue
    const tokensIn = streak ? 300 + Math.floor(rand() * 400) : 600 + Math.floor(rand() * 3600)
    const tokensOut = streak ? 80 + Math.floor(rand() * 240) : 250 + Math.floor(rand() * 1350)
    let costMicroUsd = Math.round(tokensIn * m.inRate + tokensOut * m.outRate)
    if (streak) costMicroUsd = m.inRate + m.outRate > 0 ? Math.max(1, Math.floor(costMicroUsd / 8)) : 0 // ~87% cheaper replay (0 for unmetered local models)
    // local backends answer in tens-of-ms; the 429 cloud overflow takes longer
    const latencyMs = i === 33 ? 640 + Math.floor(rand() * 320) : streak ? 25 + Math.floor(rand() * 60) : 50 + Math.floor(rand() * 450)
    const status = i === 21 ? 502 : i === 33 ? 429 : 200
    const vkey = i === 33 ? 'cloud-overflow' : i % 5 === 3 ? null : ACTIVE_VK_LABELS[i % ACTIVE_VK_LABELS.length] ?? null
    const ts = new Date(Date.now() - (40 - i) * 2_100_000 - Math.floor(rand() * 90_000))
    rows.push({ ts, model: m.id, provider: m.provider, vkey, tokensIn, tokensOut, costMicroUsd, latencyMs, status, cacheHit: streak, surface: m.surface })
  }
  return rows
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'klanker', action, detail } })
}

async function ensureSeeded(): Promise<void> {
  // v2 migration: the seed became LOCAL-STACK-FIRST (ollama + llama.cpp +
  // koboldcpp + lmstudio + sglang + one groq contrast row). Wipe + reseed
  // once, then the count()===0 guards below own inserts (concurrency-safe:
  // each table guarded, races degrade to no-ops).
  const version = await db.sdKv.findUnique({ where: { key: 'klanker.seed.version' } })
  if (version?.value !== String(SEED_VERSION)) {
    try {
      await db.klankerLogEntry.deleteMany()
      await db.klankerVKey.deleteMany()
      await db.klankerProvider.deleteMany()
      await db.sdKv.upsert({
        where: { key: 'klanker.seed.version' },
        update: { value: String(SEED_VERSION) },
        create: { key: 'klanker.seed.version', value: String(SEED_VERSION) },
      })
      await audit('seed', `klanker demo dataset re-seeded to v${SEED_VERSION} (local-stack-first: ${PROVIDER_SEEDS.length} providers, ${VKEY_SEEDS.length} vkeys)`)
    } catch {
      /* concurrent migration won */
    }
  }
  if ((await db.klankerProvider.count()) === 0) {
    try {
      await db.klankerProvider.createMany({ data: PROVIDER_SEEDS })
    } catch {
      /* concurrent seed won */
    }
  }
  const logs = buildDemoLogs()
  if ((await db.klankerVKey.count()) === 0) {
    try {
      await db.klankerVKey.createMany({
        data: VKEY_SEEDS.map((v) => {
          const mine = logs.filter((l) => l.vkey === v.label)
          return {
            ...v,
            requests24h: mine.length,
            tokens24h: mine.reduce((s, l) => s + l.tokensIn + l.tokensOut, 0),
            costMicroUsd: mine.reduce((s, l) => s + l.costMicroUsd, 0),
          }
        }),
      })
    } catch {
      /* concurrent seed won */
    }
  }
  if ((await db.klankerLogEntry.count()) === 0) {
    try {
      await db.klankerLogEntry.createMany({ data: logs })
    } catch {
      /* concurrent seed won */
    }
  }
  const seeded = await db.sdKv.findUnique({ where: { key: 'klanker.seeded' } })
  if (!seeded) {
    try {
      await db.sdKv.create({
        data: {
          key: 'klanker.seeded',
          value: `demo dataset: ${PROVIDER_SEEDS.length} providers, ${VKEY_SEEDS.length} vkeys, ${logs.length} log entries (gateway offline)`,
        },
      })
      await audit('seed', `seeded klanker demo dataset — ${PROVIDER_SEEDS.length} providers, ${VKEY_SEEDS.length} virtual keys, ${logs.length} log entries over the last 24h`)
    } catch {
      /* concurrent seed won */
    }
  }
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

// ── demo views ───────────────────────────────────────────────────────

async function demoRuntime(): Promise<RuntimeView> {
  const vkeys = await db.klankerVKey.findMany()
  const windows = vkeys
    .filter((k) => k.rateLimitPerMin !== null)
    .map((k) => ({ keyId: k.id, maxRequests: k.rateLimitPerMin ?? undefined, windowMs: 60_000 }))
  const [cacheHits, requests] = await Promise.all([
    db.klankerLogEntry.count({ where: { cacheHit: true } }),
    db.klankerLogEntry.count(),
  ])
  return {
    workers: {
      configured: 4,
      effective: 4,
      index: null,
      reusePortSupported: true,
      platform: 'linux',
      reason: 'FROSTY_WORKERS=4 — reusePort is supported on linux, so 4 worker processes share the port',
    },
    concurrency: {
      active: 3,
      peak: 11,
      total: requests,
      completed: requests,
      avgLifetimeMs: 870,
      maxLifetimeMs: 2210,
      longestOpenMs: 1400,
      dispatching: 1,
      peakDispatching: 4,
      since: new Date(Date.now() - 21_600_000).toISOString(),
      scope: 'per-process',
    },
    rateLimit: {
      enforced: windows.length > 0,
      keysWithLimits: windows.length,
      totalKeys: vkeys.length,
      scope: 'fleet',
      windows,
    },
    postgres: {
      poolSize: 10,
      estimatedFleetConnections: 44, // 4 workers × (pool 10 + 1 LISTEN)
      target: '127.0.0.1:5432/klanker',
      listenerActive: true,
    },
    cache: {
      mode: 'semantic',
      sharedTier: true,
      localEntries: cacheHits + 2,
    },
    process: {
      uptimeSeconds: null,
      denoVersion: 'not running — seeded',
      v8Version: '—',
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
    await ensureSeeded()
    return ok(
      {
        ok: false,
        offline: true,
        status: 'offline',
        version: `${DEMO_VERSION} (seeded)`,
        denoVersion: 'not running in this sandbox',
        uptimeSeconds: null,
        gatewayUrl: gatewayUrl(),
        reason: 'no answer on /healthz within the 1.5s probe',
      },
      'demo',
      demoNote(),
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
    await ensureSeeded()
    const cutoff = new Date(Date.now() - 86_400_000)
    const [providerCount, vkeyCount, rows] = await Promise.all([
      db.klankerProvider.count(),
      db.klankerVKey.count(),
      db.klankerLogEntry.findMany({ where: { ts: { gte: cutoff } } }),
    ])
    const spendMicro = rows.reduce((s, r) => s + r.costMicroUsd, 0)
    const hits = rows.filter((r) => r.cacheHit).length
    return ok(
      {
        providers: providerCount,
        vkeys: vkeyCount,
        requests24h: rows.length,
        spend24hUsd: spendMicro / 1_000_000,
        cacheHitRate: rows.length > 0 ? Math.round((hits / rows.length) * 1000) / 10 : null,
        avgLatencyMs: rows.length > 0 ? Math.round(rows.reduce((s, r) => s + r.latencyMs, 0) / rows.length) : 0,
      },
      'demo',
      demoNote(),
    )
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
    await ensureSeeded()
    const rows = await db.klankerProvider.findMany({ orderBy: { name: 'asc' } })
    return ok({ providers: rows, count: rows.length }, 'demo', demoNote())
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
    await ensureSeeded()
    const providers = await db.klankerProvider.findMany({ orderBy: { name: 'asc' } })
    const rows = providers.flatMap((p) =>
      (PROVIDER_MODEL_CATALOG[p.name] ?? []).map((m) => ({ id: `${p.name}/${m}`, provider: p.name, ownedBy: p.name })),
    )
    return ok({ models: rows, count: rows.length }, 'demo', demoNote() + ' — derived from the seeded provider accounts')
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
    await ensureSeeded()
    const rows = await db.klankerVKey.findMany({ orderBy: { label: 'asc' } })
    return ok({ vkeys: rows, count: rows.length }, 'demo', demoNote())
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
    await ensureSeeded()
    const rows = await db.klankerLogEntry.findMany({ orderBy: { ts: 'desc' }, take: limit })
    return ok(
      {
        logs: rows.map((r) => ({
          ts: r.ts.toISOString(),
          model: r.model,
          provider: r.provider,
          vkey: r.vkey,
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
          costMicroUsd: r.costMicroUsd,
          latencyMs: r.latencyMs,
          status: r.status,
          cacheHit: r.cacheHit,
          surface: r.surface,
        })),
        count: rows.length,
        limit,
      },
      'demo',
      demoNote(),
    )
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
    await ensureSeeded()
    return ok(
      await demoRuntime(),
      'demo',
      demoNote() + ' — plausible seeded topology: 4 reusePort workers, semantic cache with a shared L2, pg pool 10×4',
    )
  },
}
