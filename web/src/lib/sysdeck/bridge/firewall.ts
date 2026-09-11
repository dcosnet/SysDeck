// SysDeck bridge — firewall (demo ruleset registry)
// Port of bridge/firewall.py semantics (2710 lines): the cockpit edition
// shipped executable templates in firewall/templates/*.sh (public-webserver,
// vps-webserver, ai-llm, remote-admin, no-services, cilium, sysdeck-fw)
// and managed nftables/iptables rulesets. No nft/iptables binary exists
// in this sandbox, so the web edition ports the TEMPLATE TOPOLOGIES
// verbatim from the tarball headers into a static catalog, and manages
// a seeded FwRuleset/FwRule registry. `apply --dryRun` returns the exact
// nft script that WOULD be applied (realistic `nft list ruleset` syntax).
import { db } from '@/lib/db'
import { ok, fail } from './shared'

const SOURCE = 'demo' as const
const NOTE = 'nft/iptables not present in sandbox — demo ruleset registry; template topologies ported verbatim from firewall/templates/*.sh (v0.0.47/v0.0.44)'

function failE(error: string) {
  return { ...fail(error), source: SOURCE }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'firewall', action, detail } })
}

// ── template catalog (real topologies from the tarball) ─────────────

interface TemplatePort {
  port: number
  proto: 'tcp' | 'udp'
  dir: 'in' | 'loopback' | 'blocked'
  comment: string
}

interface Template {
  id: string
  name: string
  description: string
  backend: string
  ports: TemplatePort[]
  rules: { chain: string; action: string; proto: string; port?: string; source?: string; comment: string }[]
}

const TEMPLATES: Template[] = [
  {
    id: 'public-webserver',
    name: 'Public Web Server',
    description:
      'Public server variant for a web stack. Varnish (80) is the public cache front, Caddy HTTPS (443) public; Caddy HTTP backend (8080) and MariaDB (3306) are loopback-only and never exposed. SSH rate-limited with auto-ban. Caddy admin API (2019) loopback-only.',
    backend: 'nftables',
    ports: [
      { port: 22, proto: 'tcp', dir: 'in', comment: 'SSH — public, rate-limited (4 new conns/min) + brute-force auto-ban set' },
      { port: 80, proto: 'tcp', dir: 'in', comment: 'Varnish cache frontend — public (ACME http-01 + redirect to :443)' },
      { port: 443, proto: 'tcp', dir: 'in', comment: 'Caddy HTTPS — public, terminates TLS' },
      { port: 8080, proto: 'tcp', dir: 'loopback', comment: 'Caddy HTTP backend — loopback only (Varnish cache-miss target)' },
      { port: 3306, proto: 'tcp', dir: 'blocked', comment: 'MariaDB — dropped, never exposed (defense in depth)' },
      { port: 2019, proto: 'tcp', dir: 'loopback', comment: 'Caddy admin API — loopback only' },
    ],
    rules: [
      { chain: 'INPUT', action: 'accept', proto: 'tcp', comment: 'ct state established,related' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', source: '127.0.0.1/8', comment: 'loopback' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '80', comment: 'varnish cache front (public)' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '443', comment: 'caddy https (public)' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '8080', source: '127.0.0.1', comment: 'caddy HTTP backend (loopback)' },
      { chain: 'INPUT', action: 'drop', proto: 'tcp', port: '8080', comment: 'caddy backend — drop non-loopback' },
      { chain: 'INPUT', action: 'drop', proto: 'tcp', port: '3306', comment: 'mariadb never exposed' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '9090', source: '192.168.1.0/24', comment: 'cockpit admin CIDR' },
    ],
  },
  {
    id: 'vps-webserver',
    name: 'VPS Web Server',
    description:
      'Service-aware firewall for VPS web servers. Auto-detects SSH, Caddy, Varnish, Forgejo and adapts. When Varnish is detected the DEFAULT topology is cache-front-of-origin: Varnish on :80 (public), Caddy HTTP backend :8080 loopback-only, Caddy HTTPS :443 public. Aggressive SSH rate limiting when pubkey-only auth is detected.',
    backend: 'nftables',
    ports: [
      { port: 22, proto: 'tcp', dir: 'in', comment: 'SSH — rate-limited, aggressive when pubkey-only auth detected' },
      { port: 80, proto: 'tcp', dir: 'in', comment: 'Varnish (public) when detected — otherwise Caddy HTTP' },
      { port: 443, proto: 'tcp', dir: 'in', comment: 'Caddy HTTPS — public' },
      { port: 8080, proto: 'tcp', dir: 'loopback', comment: 'Caddy HTTP backend — loopback-only when Varnish is detected' },
      { port: 3000, proto: 'tcp', dir: 'in', comment: 'Forgejo HTTP (only when forgejo is installed/detected)' },
    ],
    rules: [
      { chain: 'INPUT', action: 'accept', proto: 'tcp', comment: 'ct state established,related' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', source: '127.0.0.1/8', comment: 'loopback' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '22', comment: 'ssh (rate-limited)' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '80', comment: 'varnish / caddy http (public)' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '443', comment: 'caddy https (public)' },
      { chain: 'INPUT', action: 'drop', proto: 'tcp', port: '8080', comment: 'caddy backend — loopback only when varnish detected' },
      { chain: 'INPUT', action: 'drop', proto: 'tcp', comment: 'default drop' },
    ],
  },
  {
    id: 'ai-llm',
    name: 'AI LLM Stack',
    description:
      'Public server variant for self-hosted AI LLM stacks: Ollama (11434), OpenWebUI (3000), Hermes (8000), Odysseus (8001) and SSH (22). All four AI service ports are public per the v0.0.44 directive (the operator reaches them over VPN/trusted network); SSH is rate-limited with auto-ban.',
    backend: 'nftables',
    ports: [
      { port: 22, proto: 'tcp', dir: 'in', comment: 'SSH — rate-limited with auto-ban' },
      { port: 11434, proto: 'tcp', dir: 'in', comment: 'Ollama API — public per user directive (set OLLAMA_HOST to loopback to restrict)' },
      { port: 3000, proto: 'tcp', dir: 'in', comment: 'OpenWebUI — public per user directive' },
      { port: 8000, proto: 'tcp', dir: 'in', comment: 'Hermes function-calling gateway — public per user directive' },
      { port: 8001, proto: 'tcp', dir: 'in', comment: 'Odysseus agent runtime — public per user directive' },
    ],
    rules: [
      { chain: 'INPUT', action: 'accept', proto: 'tcp', comment: 'ct state established,related' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', source: '127.0.0.1/8', comment: 'loopback' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '22', comment: 'ssh (rate-limited)' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '11434', comment: 'ollama api (public)' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '3000', comment: 'openwebui (public)' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '8000', comment: 'hermes (public)' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '8001', comment: 'odysseus (public)' },
      { chain: 'INPUT', action: 'drop', proto: 'tcp', comment: 'default drop' },
    ],
  },
  {
    id: 'remote-admin',
    name: 'Remote Admin',
    description:
      'Public server variant for remote administration: the box is reachable on two admin ports only — SSH (22) and Cockpit (9090), both with aggressive rate limiting (4/min ssh, 10/min cockpit), port-scan detection and SSH brute-force auto-ban. Everything else is dropped; invalid flag combos, fragments and bogons are dropped and logged.',
    backend: 'nftables',
    ports: [
      { port: 22, proto: 'tcp', dir: 'in', comment: 'SSH — rate-limited 4 new conns/min, abuse set with 1h timeout' },
      { port: 9090, proto: 'tcp', dir: 'in', comment: 'Cockpit web UI — rate-limited 10 new conns/min' },
    ],
    rules: [
      { chain: 'INPUT', action: 'accept', proto: 'tcp', comment: 'ct state established,related' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', source: '127.0.0.1/8', comment: 'loopback' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '22', comment: 'ssh (rate-limited + auto-ban)' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '9090', comment: 'cockpit (rate-limited)' },
      { chain: 'INPUT', action: 'drop', proto: 'tcp', comment: 'default drop (invalid flags, fragments, bogons)' },
    ],
  },
  {
    id: 'no-services',
    name: 'No Services',
    description:
      'Locked-down host firewall with no public services except SSH. Modern nftables syntax (inet family, sets, verdict maps, named counters, synproxy for SYN floods, bogon filtering, fragment protection). Default input/forward policy: drop.',
    backend: 'nftables',
    ports: [
      { port: 22, proto: 'tcp', dir: 'in', comment: 'SSH — the only exposed service (synproxy-protected)' },
    ],
    rules: [
      { chain: 'INPUT', action: 'accept', proto: 'tcp', comment: 'ct state established,related' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', source: '127.0.0.1/8', comment: 'loopback' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '22', comment: 'ssh (synproxy)' },
      { chain: 'INPUT', action: 'drop', proto: 'tcp', comment: 'default drop — no public services' },
    ],
  },
  {
    id: 'cilium',
    name: 'Cilium eBPF',
    description:
      'Cilium eBPF datapath backend: replaces nftables rules with eBPF programs at XDP and tc ingress/egress. Identity-based policy (labels survive IP changes) plus L7 HTTP/gRPC/Kafka policy via Envoy — observable with cilium monitor and Hubble flow logs. Requires kernel 5.10+ and cilium-cli.',
    backend: 'cilium',
    ports: [
      { port: 22, proto: 'tcp', dir: 'in', comment: 'SSH — host firewall (XDP) while cilium-agent manages the rest' },
    ],
    rules: [
      { chain: 'INPUT', action: 'accept', proto: 'tcp', comment: 'ct state established,related' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '22', comment: 'ssh (XDP)' },
      { chain: 'POLICY', action: 'accept', proto: 'any', comment: 'cilium L7: allow http GET /api/* from ingress-identity' },
      { chain: 'POLICY', action: 'drop', proto: 'any', comment: 'cilium default deny at L7' },
    ],
  },
  {
    id: 'sysdeck-fw',
    name: 'SysDeck FW (zones)',
    description:
      'Unified nftables zone firewall (RED/ORANGE/GREEN/BLUE, takes influence from Smoothwall Express + IPFire): source-verified outbound per zone, AirWall isolation (BLUE cannot reach GREEN, not even DNS), optional flow offload, synproxy, bogon filtering and DMZ port-forwarding.',
    backend: 'nftables',
    ports: [
      { port: 22, proto: 'tcp', dir: 'in', comment: 'SSH from RED (Internet) — rate-limited' },
      { port: 53, proto: 'udp', dir: 'in', comment: 'DNS for GREEN (trusted LAN) only' },
      { port: 80, proto: 'tcp', dir: 'in', comment: 'DMZ port-forward example (RED → ORANGE)' },
    ],
    rules: [
      { chain: 'INPUT', action: 'accept', proto: 'tcp', comment: 'ct state established,related' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', source: '127.0.0.1/8', comment: 'loopback' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '22', comment: 'ssh from RED (rate-limited)' },
      { chain: 'FORWARD', action: 'accept', proto: 'tcp', source: '10.0.0.0/8', comment: 'GREEN → RED/ORANGE allowed (source-verified outbound)' },
      { chain: 'FORWARD', action: 'drop', proto: 'tcp', source: '10.0.2.0/24', comment: 'BLUE → GREEN denied (AirWall — even DNS blocked)' },
    ],
  },
]

// ── lazy seed ───────────────────────────────────────────────────────

async function ensureSeeded(): Promise<void> {
  const count = await db.fwRuleset.count()
  if (count > 0) return
  await db.fwRuleset.create({
    data: {
      name: 'edge-fleet',
      backend: 'nftables',
      template: 'public-webserver',
      active: true,
      appliedAt: new Date(Date.now() - 86400000),
    },
  })
  await db.fwRule.createMany({
    data: TEMPLATES[0].rules.map((r, i) => ({ ...r, ruleset: 'edge-fleet', position: i + 1 })),
  })
  await db.fwRuleset.create({
    data: {
      name: 'lab-default',
      backend: 'iptables',
      template: 'no-services',
      active: false,
      appliedAt: null,
    },
  })
  await db.fwRule.createMany({
    data: [
      { chain: 'INPUT', action: 'accept', proto: 'tcp', comment: 'ct state established,related', position: 1, ruleset: 'lab-default' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', source: '127.0.0.1/8', comment: 'loopback', position: 2, ruleset: 'lab-default' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '22', comment: 'ssh', position: 3, ruleset: 'lab-default' },
      { chain: 'INPUT', action: 'drop', proto: 'tcp', port: '23', comment: 'telnet blocked', position: 4, ruleset: 'lab-default' },
      { chain: 'INPUT', action: 'drop', proto: 'tcp', comment: 'default drop', position: 5, ruleset: 'lab-default' },
    ],
  })
  await audit('seed', 'seeded demo rulesets: edge-fleet (nftables, public-webserver, active, 8 rules) + lab-default (iptables, inactive, 5 rules)')
}

// ── nft script synthesis ────────────────────────────────────────────

interface RuleRow {
  chain: string
  action: string
  proto: string
  port: string | null
  source: string | null
  comment: string | null
  position: number
}

function nftLine(r: RuleRow): string {
  const cmt = r.comment ? ` comment "${r.comment.replace(/"/g, "'")}"` : ''
  if (r.port === null && r.source === null && r.comment?.includes('established')) {
    return `ct state established,related ${r.action}${cmt}`
  }
  if (r.source === '127.0.0.1/8') return `iifname "lo" ${r.action}${cmt}`
  const src = r.source ? `ip saddr ${r.source} ` : ''
  const dst = r.port !== null ? `${r.proto} dport ${r.port} ` : ''
  const verdict = r.action === 'log' ? `log${cmt}` : `${r.action}${cmt}`
  return `${src}${dst}${verdict}`.trim()
}

function nftScript(ruleset: { name: string; backend: string; template: string | null }, rules: RuleRow[]): string {
  const input = rules.filter((r) => r.chain === 'INPUT').map(nftLine)
  const forward = rules.filter((r) => r.chain === 'FORWARD').map(nftLine)
  const other = rules.filter((r) => !['INPUT', 'FORWARD'].includes(r.chain))
  const lines = [
    `#!/usr/sbin/nft -f`,
    `# sysdeck-firewall: ruleset '${ruleset.name}' (backend ${ruleset.backend}${ruleset.template ? `, template ${ruleset.template}` : ''})`,
    `flush ruleset`,
    ``,
    `table inet firewall {`,
    `  set ssh_abuse {`,
    `    type ipv4_addr`,
    `    flags timeout`,
    `    timeout 1h`,
    `  }`,
    `  chain input {`,
    `    type filter hook input priority filter; policy drop;`,
    ...input.map((l) => `    ${l}`),
    `  }`,
    `  chain forward {`,
    `    type filter hook forward priority filter; policy drop;`,
    ...(forward.length ? forward.map((l) => `    ${l}`) : []),
    `  }`,
    `  chain output {`,
    `    type filter hook output priority filter; policy accept;`,
    `  }`,
    ...other.map((r) => `  chain ${r.chain.toLowerCase().replace('policy', 'cilium_policy')} {\n    ${nftLine(r)}\n  }`),
    `}`,
  ]
  return lines.join('\n')
}

function iptablesScript(ruleset: { name: string; backend: string }, rules: RuleRow[]): string {
  const lines = [
    `# sysdeck-firewall: ruleset '${ruleset.name}' (backend iptables) — iptables-restore format`,
    `*filter`,
    `:INPUT DROP [0:0]`,
    `:FORWARD DROP [0:0]`,
    `:OUTPUT ACCEPT [0:0]`,
  ]
  for (const r of rules) {
    const cmt = r.comment ? ` -m comment --comment "${r.comment.replace(/"/g, "'")}"` : ''
    let spec = ''
    if (r.comment?.includes('established')) spec = '-m conntrack --ctstate ESTABLISHED,RELATED'
    else if (r.source === '127.0.0.1/8') spec = '-i lo'
    else {
      const src = r.source ? ` -s ${r.source}` : ''
      const dport = r.port !== null ? ` -p ${r.proto} --dport ${r.port}` : ` -p ${r.proto}`
      spec = `${dport}${src}`
    }
    lines.push(`-A ${r.chain}${spec ? ` ${spec}` : ''} -j ${r.action.toUpperCase()}${cmt}`)
  }
  lines.push('COMMIT')
  return lines.join('\n')
}

// ── commands ────────────────────────────────────────────────────────

export const commands = {
  templates: async () => {
    await ensureSeeded()
    return ok(
      { templates: TEMPLATES.map(({ id, name, description, ports, backend }) => ({ id, name, description, ports, backend })), count: TEMPLATES.length },
      SOURCE,
      NOTE,
    )
  },

  rulesets: async () => {
    await ensureSeeded()
    const rulesets = await db.fwRuleset.findMany({ orderBy: { name: 'asc' } })
    const counts = await Promise.all(
      rulesets.map((r) => db.fwRule.count({ where: { ruleset: r.name } })),
    )
    return ok(
      {
        rulesets: rulesets.map((r, i) => ({
          id: r.id,
          name: r.name,
          backend: r.backend,
          template: r.template,
          active: r.active,
          appliedAt: r.appliedAt,
          ruleCount: counts[i],
        })),
        count: rulesets.length,
      },
      SOURCE,
      NOTE,
    )
  },

  rules: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const ruleset = String(args.ruleset ?? '')
    if (!ruleset) return failE('ruleset is required')
    const rs = await db.fwRuleset.findUnique({ where: { name: ruleset } })
    if (!rs) return failE(`ruleset '${ruleset}' not found`)
    const rules = await db.fwRule.findMany({ where: { ruleset }, orderBy: { position: 'asc' } })
    return ok(
      { ruleset: { name: rs.name, backend: rs.backend, template: rs.template, active: rs.active, appliedAt: rs.appliedAt }, rules, count: rules.length },
      SOURCE,
    )
  },

  create: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const name = String(args.name ?? '').trim()
    const backend = String(args.backend ?? 'nftables').trim()
    const template = args.template ? String(args.template).trim() : null
    if (!name) return failE('name is required')
    if (!validRulesetName(name)) return failE(`invalid ruleset name '${name}' — letters/digits/dashes/underscores only`)
    if (!['nftables', 'iptables', 'firewalld', 'sysdeck-fw', 'cilium'].includes(backend)) {
      return failE(`backend must be one of: nftables, iptables, firewalld, sysdeck-fw, cilium`)
    }
    if (await db.fwRuleset.findUnique({ where: { name } })) return failE(`ruleset '${name}' already exists`)
    let tplRules: Template['rules'] = []
    if (template) {
      const tpl = TEMPLATES.find((t) => t.id === template)
      if (!tpl) return failE(`unknown template '${template}' — available: ${TEMPLATES.map((t) => t.id).join(', ')}`)
      tplRules = tpl.rules
    }
    const row = await db.fwRuleset.create({
      data: { name, backend, template, active: false },
    })
    if (tplRules.length > 0) {
      await db.fwRule.createMany({
        data: tplRules.map((r, i) => ({ ...r, ruleset: name, position: i + 1 })),
      })
    }
    await audit('create', `ruleset ${name} (backend ${backend}${template ? `, from template ${template}` : ''}) with ${tplRules.length} rules`)
    return ok({ ruleset: { name: row.name, backend: row.backend, template: row.template, active: row.active }, rules: tplRules.length }, SOURCE)
  },

  apply: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const name = String(args.name ?? '').trim()
    const dryRun = args.dryRun === true
    if (!name) return failE('name is required')
    const rs = await db.fwRuleset.findUnique({ where: { name } })
    if (!rs) return failE(`ruleset '${name}' not found`)
    const rules = (await db.fwRule.findMany({ where: { ruleset: name }, orderBy: { position: 'asc' } })) as unknown as RuleRow[]
    if (dryRun) {
      return ok(
        { name, backend: rs.backend, script: rs.backend === 'iptables' ? iptablesScript(rs, rules) : nftScript(rs, rules), rules: rules.length },
        SOURCE,
        'dry run — the exact ruleset text that would be applied (nft/iptables syntax), nothing was loaded',
      )
    }
    // activating a ruleset deactivates the previously active one
    await db.fwRuleset.updateMany({ where: { active: true, NOT: { name } }, data: { active: false } })
    const row = await db.fwRuleset.update({ where: { name }, data: { active: true, appliedAt: new Date() } })
    await audit('apply', `ruleset ${name} ACTIVATED (${rules.length} rules, backend ${rs.backend}) — previously active ruleset deactivated`)
    return ok(
      { ruleset: row, applied: true, rules: rules.length },
      SOURCE,
      'demo activation — nft/iptables are not present in the sandbox, only the registry state changed',
    )
  },

  delete: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const name = String(args.name ?? '').trim()
    if (!name) return failE('name is required')
    const rs = await db.fwRuleset.findUnique({ where: { name } })
    if (!rs) return failE(`ruleset '${name}' not found`)
    if (rs.active) return failE(`ruleset '${name}' is ACTIVE — deactivate/apply another ruleset before deleting`)
    await db.fwRule.deleteMany({ where: { ruleset: name } })
    await db.fwRuleset.delete({ where: { name } })
    await audit('delete', `ruleset ${name} deleted (all rules removed)`)
    return ok({ deleted: { name } }, SOURCE)
  },

  addRule: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const ruleset = String(args.ruleset ?? '').trim()
    const chain = String(args.chain ?? 'INPUT').trim().toUpperCase()
    const action = String(args.action ?? '').trim().toLowerCase()
    const proto = String(args.proto ?? 'tcp').trim().toLowerCase()
    const port = args.port !== undefined && args.port !== null ? String(args.port).trim() : null
    const source = args.source ? String(args.source).trim() : null
    const comment = args.comment ? String(args.comment).trim() : null
    if (!ruleset) return failE('ruleset is required')
    if (!['INPUT', 'FORWARD', 'OUTPUT', 'POLICY'].includes(chain)) return failE(`chain must be INPUT, FORWARD, OUTPUT or POLICY`)
    if (!['accept', 'drop', 'reject', 'log'].includes(action)) return failE('action must be accept, drop, reject or log')
    if (port !== null && !/^\d+([:-]\d+)?$/.test(port)) return failE(`invalid port '${port}' — a number or a range like 3000:3100`)
    if (source && !/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(source)) return failE(`invalid source '${source}' — expected a CIDR like 192.168.1.0/24`)
    const rs = await db.fwRuleset.findUnique({ where: { name: ruleset } })
    if (!rs) return failE(`ruleset '${ruleset}' not found`)
    const last = await db.fwRule.findFirst({ where: { ruleset }, orderBy: { position: 'desc' } })
    const position = (last?.position ?? 0) + 1
    const row = await db.fwRule.create({ data: { ruleset, chain, action, proto, port, source, comment, position } })
    await audit('addRule', `ruleset ${ruleset}: +${chain} ${action} ${proto}${port ? ` dport ${port}` : ''}${source ? ` from ${source}` : ''} (position ${position})`)
    return ok({ rule: row, ruleset }, SOURCE)
  },

  deleteRule: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '').trim()
    if (!id) return failE('id is required')
    const rule = await db.fwRule.findUnique({ where: { id } })
    if (!rule) return failE('rule not found')
    await db.fwRule.delete({ where: { id } })
    await audit('deleteRule', `ruleset ${rule.ruleset}: removed position ${rule.position} (${rule.chain} ${rule.action}${rule.port ? ` ${rule.port}` : ''})`)
    return ok({ deleted: { id, ruleset: rule.ruleset, position: rule.position } }, SOURCE)
  },
}

function validRulesetName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)
}
