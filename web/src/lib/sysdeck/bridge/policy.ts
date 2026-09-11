// SysDeck bridge — policy (demo polkit-style rule registry)
// Port of bridge/policy.py semantics: the cockpit edition enforced
// org.sysdeck.* actions through polkit (the operator was prompted via
// cockpit's superuser channel for org.sysdeck.policy.modify). No
// polkit daemon exists here, so the web edition manages the same
// polkit-style allow/deny rules as a seeded PolicyRule registry with
// scope/subject/effect/priority semantics and full audit history.
import { db } from '@/lib/db'
import { ok, fail } from './shared'

const SOURCE = 'demo' as const
const NOTE = 'polkit not present in sandbox — demo policy rule registry (polkit-style scopes/subjects)'

function failE(error: string) {
  return { ...fail(error), source: SOURCE }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'policy', action, detail } })
}

// ── the org.sysdeck.* scope catalog ─────────────────────────────────

const SCOPES: { scope: string; description: string }[] = [
  { scope: 'org.sysdeck.policy.modify', description: 'modify the policy rule set itself (create/update/delete/toggle rules)' },
  { scope: 'org.sysdeck.builder.modify', description: 'create/modify image build profiles and run builds' },
  { scope: 'org.sysdeck.firewall.apply', description: 'activate firewall rulesets (kernel-level filter changes)' },
  { scope: 'org.sysdeck.packages.manage', description: 'install or remove system packages (apt/dpkg)' },
  { scope: 'org.sysdeck.fester.modify', description: 'modify Fester build policies, pipelines and node assignment' },
  { scope: 'org.sysdeck.hwalert.block', description: 'block/unblock hardware devices and manage the device whitelist' },
  { scope: 'org.sysdeck.modules3p.modify', description: 'install/uninstall third-party cockpit modules' },
  { scope: 'org.sysdeck.vault.manage', description: 'lock/unlock LUKS vault entries and create key backups' },
  { scope: 'org.sysdeck.db.manage', description: 'start/stop database instances and trigger backups' },
  { scope: 'org.sysdeck.containers.manage', description: 'start/stop/freeze/delete containers and VMs' },
  { scope: 'org.sysdeck.mesh.manage', description: 'scale Kubernetes deployments (pod count changes)' },
  { scope: 'org.sysdeck.monitoring.manage', description: 'reconfigure the Prometheus/Grafana monitoring stack' },
]

// ── lazy seed ───────────────────────────────────────────────────────

const SEED_RULES = [
  { scope: 'org.sysdeck.builder.modify', subject: 'unix-user:jeremy', effect: 'allow', priority: 50, note: 'primary operator — full builder access' },
  { scope: 'org.sysdeck.firewall.apply', subject: 'unix-user:jeremy', effect: 'allow', priority: 50, note: 'ruleset activation requires the operator' },
  { scope: 'org.sysdeck.packages.manage', subject: 'unix-user:nobody', effect: 'deny', priority: 60, note: 'explicit deny — nobody must never install packages' },
  { scope: 'org.sysdeck.fester.modify', subject: 'group:wheel', effect: 'allow', priority: 40, note: 'wheel members may tune Fester pipelines' },
  { scope: 'org.sysdeck.hwalert.block', subject: 'unix-user:jeremy', effect: 'allow', priority: 50, note: 'device blocking is a destructive action' },
  { scope: 'org.sysdeck.modules3p.modify', subject: 'unix-user:jeremy', effect: 'allow', priority: 50, note: 'license acceptance is operator-only by design' },
]

async function ensureSeeded(): Promise<void> {
  const count = await db.policyRule.count()
  if (count > 0) return
  await db.policyRule.createMany({ data: SEED_RULES })
  await audit('seed', `seeded ${SEED_RULES.length} polkit-style policy rules (org.sysdeck.* scopes)`)
}

// ── validation helpers ──────────────────────────────────────────────

function validScope(scope: string): boolean {
  return /^org\.sysdeck\.[a-z0-9-]+\.[a-z0-9-]+$/.test(scope)
}

function validSubject(subject: string): boolean {
  return /^(unix-user|group|netgroup|user):[a-zA-Z0-9._-]+$/.test(subject)
}

// ── commands ────────────────────────────────────────────────────────

export const commands = {
  rules: async () => {
    await ensureSeeded()
    const rules = await db.policyRule.findMany({ orderBy: [{ priority: 'desc' }, { scope: 'asc' }] })
    return ok({ rules, count: rules.length }, SOURCE, NOTE)
  },

  scopes: async () => {
    await ensureSeeded()
    return ok({ scopes: SCOPES, count: SCOPES.length }, SOURCE, NOTE)
  },

  create: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const scope = String(args.scope ?? '').trim()
    const subject = String(args.subject ?? '').trim()
    const effect = String(args.effect ?? 'allow').trim().toLowerCase()
    const priority = Number.isInteger(args.priority) ? Number(args.priority) : 50
    const note = args.note ? String(args.note).trim() : null
    if (!scope) return failE('scope is required (e.g. org.sysdeck.builder.modify)')
    if (!validScope(scope)) return failE(`invalid scope '${scope}' — must look like org.sysdeck.<module>.<action>`)
    if (!SCOPES.some((s) => s.scope === scope)) return failE(`unknown scope '${scope}' — call policy.scopes for the catalog`)
    if (!subject) return failE('subject is required (unix-user:<name> or group:<name>)')
    if (!validSubject(subject)) return failE(`invalid subject '${subject}' — expected unix-user:<name> or group:<name>`)
    if (!['allow', 'deny'].includes(effect)) return failE('effect must be allow or deny')
    if (priority < 0 || priority > 100) return failE('priority must be 0-100')
    const row = await db.policyRule.create({ data: { scope, subject, effect, priority, note } })
    await audit('policy.create', `${effect} ${scope} for ${subject} (priority ${priority})`)
    return ok({ rule: row }, SOURCE)
  },

  update: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '').trim()
    if (!id) return failE('id is required')
    const rule = await db.policyRule.findUnique({ where: { id } })
    if (!rule) return failE('rule not found')
    const data: { effect?: string; priority?: number; subject?: string; note?: string | null; enabled?: boolean } = {}
    if (args.effect !== undefined) {
      const effect = String(args.effect).trim().toLowerCase()
      if (!['allow', 'deny'].includes(effect)) return failE('effect must be allow or deny')
      data.effect = effect
    }
    if (args.priority !== undefined) {
      const priority = Number(args.priority)
      if (!Number.isInteger(priority) || priority < 0 || priority > 100) return failE('priority must be an integer 0-100')
      data.priority = priority
    }
    if (args.subject !== undefined) {
      const subject = String(args.subject).trim()
      if (!validSubject(subject)) return failE(`invalid subject '${subject}' — expected unix-user:<name> or group:<name>`)
      data.subject = subject
    }
    if (args.note !== undefined) data.note = args.note === null ? null : String(args.note).trim()
    if (Object.keys(data).length === 0) return failE('nothing to update — pass effect, priority, subject and/or note')
    const row = await db.policyRule.update({ where: { id }, data })
    await audit('policy.update', `rule ${rule.scope} ${rule.subject}: ${Object.entries(data).map(([k, v]) => `${k}=${v}`).join(', ')}`)
    return ok({ rule: row }, SOURCE)
  },

  delete: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '').trim()
    if (!id) return failE('id is required')
    const rule = await db.policyRule.findUnique({ where: { id } })
    if (!rule) return failE('rule not found')
    await db.policyRule.delete({ where: { id } })
    await audit('policy.delete', `removed ${rule.effect} ${rule.scope} for ${rule.subject}`)
    return ok({ deleted: { id, scope: rule.scope, subject: rule.subject } }, SOURCE)
  },

  toggle: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '').trim()
    if (!id) return failE('id is required')
    const rule = await db.policyRule.findUnique({ where: { id } })
    if (!rule) return failE('rule not found')
    const row = await db.policyRule.update({ where: { id }, data: { enabled: !rule.enabled } })
    await audit('policy.toggle', `${rule.scope} ${rule.subject} → ${row.enabled ? 'enabled' : 'disabled'}`)
    return ok({ rule: row, enabled: row.enabled }, SOURCE)
  },

  audit: async () => {
    await ensureSeeded()
    const rows = await db.auditLog.findMany({
      where: { OR: [{ module: 'policy' }, { action: { contains: 'policy' } }] },
      orderBy: { ts: 'desc' },
      take: 50,
    })
    return ok({ entries: rows, count: rows.length }, SOURCE, 'AuditLog rows filtered module=policy OR action contains "policy"')
  },
}
