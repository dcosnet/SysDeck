// SysDeck bridge — firewall (real ruleset registry + real apply, live)
// Port of bridge/firewall.py semantics (2710 lines): the cockpit edition
// shipped EXECUTABLE templates in firewall/templates/*.sh (public-
// webserver, vps-webserver, ai-llm, remote-admin, no-services, cilium,
// sysdeck-fw) and managed nftables/iptables rulesets, applied through
// the org.sysdeck.firewall.modify polkit action. The web edition:
//   - keeps the template catalog (topologies ported verbatim — the
//     scripts themselves ship in the tarball and install to
//     /usr/share/sysdeck/firewall/templates/)
//   - the ruleset registry is the OPERATOR'S workspace (created
//     explicitly, never seeded)
//   - apply() runs the REAL thing: the shipped template script when the
//     ruleset came from a template, else the synthesized nft/iptables
//     script via `nft -f` / `iptables-restore` — privilege-gated
//     (root / sudo -n), honest failure otherwise, dry-run shows the
//     exact script
//   - live: reads the host's REAL active ruleset (nft -j list ruleset /
//     iptables-save) when a firewall binary exists
import { db } from '@/lib/db'
import { ok, fail, run, which, cached, readText } from './shared'
import { access } from 'fs/promises'
import { existsSync } from 'fs'

function failE(error: string, source: 'live' | 'hybrid' = 'live') {
  return { ...fail(error), source }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'firewall', action, detail } })
}

// ── template catalog (topologies ported verbatim from firewall/templates) ──

interface FwPort {
  port: number
  proto: string
  dir: string
  comment: string
}

interface FwRuleSeed {
  chain: string
  action: string
  proto: string
  port?: string
  source?: string
  comment?: string
}

interface Template {
  id: string
  name: string
  description: string
  backend: string
  ports: FwPort[]
  rules: FwRuleSeed[]
}

const TEMPLATES: Template[] = [
  {
    id: 'public-webserver',
    name: 'Public Webserver',
    description:
      'Public webserver with SSH: input default-drop, established/related accepted, loopback accepted, SSH rate-limited (4 new conns/min with an auto-ban abuse set), HTTP/HTTPS open, plus the ports the operator marked public (OpenWebUI 3000, Hermes 8000, Odysseus 8001, ollama 11434). Bogon and invalid-flag filtering, synproxy option for SYN floods.',
    backend: 'nftables',
    ports: [
      { port: 22, proto: 'tcp', dir: 'in', comment: 'SSH — rate-limited 4/min with abuse set' },
      { port: 80, proto: 'tcp', dir: 'in', comment: 'HTTP' },
      { port: 443, proto: 'tcp', dir: 'in', comment: 'HTTPS' },
      { port: 11434, proto: 'tcp', dir: 'in', comment: 'ollama api — public per user directive' },
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
    id: 'vps-webserver',
    name: 'VPS Webserver',
    description:
      'Service-aware firewall for VPS web servers. Auto-detects SSH, Caddy, Varnish, Forgejo and adapts rules accordingly. Varnish-on-80 + Caddy-HTTP-on-8080 (loopback) is the explicit default cache topology per v0.0.47. Aggressive SSH rate limiting when pubkey-only auth is detected.',
    backend: 'nftables',
    ports: [
      { port: 22, proto: 'tcp', dir: 'in', comment: 'SSH — rate-limited (aggressive when pubkey-only auth is detected)' },
      { port: 80, proto: 'tcp', dir: 'in', comment: 'Varnish cache front (public) — or Caddy HTTP direct when no Varnish' },
      { port: 443, proto: 'tcp', dir: 'in', comment: 'Caddy HTTPS (public)' },
      { port: 8080, proto: 'tcp', dir: 'loopback', comment: 'Caddy HTTP backend (loopback-only when Varnish fronts :80)' },
      { port: 3000, proto: 'tcp', dir: 'in', comment: 'Forgejo (when detected)' },
    ],
    rules: [
      { chain: 'INPUT', action: 'accept', proto: 'tcp', comment: 'ct state established,related' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', source: '127.0.0.1/8', comment: 'loopback' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '22', comment: 'ssh (rate-limited + auto-ban)' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '80', comment: 'varnish cache front / caddy http' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '443', comment: 'caddy https' },
      { chain: 'INPUT', action: 'drop', proto: 'tcp', comment: 'default drop' },
    ],
  },
  {
    id: 'ai-llm',
    name: 'AI / LLM Stack',
    description:
      'Public server variant for self-hosted AI LLM stacks. Exposes Ollama (11434), OpenWebUI (3000), Hermes (8000), Odysseus (8001) and SSH (22) — all AI service ports public per operator directive so the stack is reachable from anywhere; SSH is rate-limited with auto-ban. Designed for a personal / team AI workstation accessible over a trusted network or VPN.',
    backend: 'nftables',
    ports: [
      { port: 22, proto: 'tcp', dir: 'in', comment: 'SSH — rate-limited with auto-ban' },
      { port: 11434, proto: 'tcp', dir: 'in', comment: 'Ollama API — public per user directive (honor OLLAMA_HOST)' },
      { port: 3000, proto: 'tcp', dir: 'in', comment: 'OpenWebUI — public' },
      { port: 8000, proto: 'tcp', dir: 'in', comment: 'Hermes function-calling gateway — public' },
      { port: 8001, proto: 'tcp', dir: 'in', comment: 'Odysseus agent runtime — public' },
    ],
    rules: [
      { chain: 'INPUT', action: 'accept', proto: 'tcp', comment: 'ct state established,related' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', source: '127.0.0.1/8', comment: 'loopback' },
      { chain: 'INPUT', action: 'accept', proto: 'tcp', port: '22', comment: 'ssh (rate-limited + auto-ban)' },
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

// ── nft / iptables script synthesis (real syntax) ────────────────────

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
  const cmt = r.comment ? ` comment "${safeComment(r.comment)}"` : ''
  if (r.port === null && r.source === null && r.comment?.includes('established')) {
    return `ct state established,related ${r.action}${cmt}`
  }
  if (r.source === '127.0.0.1/8') return `iifname "lo" ${r.action}${cmt}`
  const src = r.source ? `ip saddr ${r.source} ` : ''
  const dst = r.port !== null ? `${r.proto} dport ${r.port} ` : ''
  const verdict = r.action === 'log' ? `log${cmt}` : `${r.action}${cmt}`
  return `${src}${dst}${verdict}`.trim()
}

/** Rule comments land inside double-quoted nft/iptables script strings —
 *  control characters and quotes are stripped at render time so a stored
 *  comment can never break out and inject directives. */
const safeComment = (c: string): string => c.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/"/g, "'").slice(0, 160)

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
    const cmt = r.comment ? ` -m comment --comment "${safeComment(r.comment)}"` : ''
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

// ── privilege + real apply ───────────────────────────────────────────

function isRoot(): boolean {
  return typeof process.geteuid === 'function' && process.geteuid() === 0
}

function havePasswordlessSudo(): Promise<boolean> {
  return cached('sudo:-n:true', 60_000, async () => (await run('sudo', ['-n', 'true'], 3000)).rc === 0)
}

/** template scripts ship in the tarball + install under the share dir */
const TEMPLATE_SCRIPT_ROOTS = [
  '/usr/share/sysdeck/firewall/templates',
  '/usr/local/share/sysdeck/firewall/templates',
  '/usr/lib/sysdeck/firewall/templates',
  `${process.cwd()}/../firewall/templates`, // dev tree
]

async function templateScriptPath(template: string): Promise<string | null> {
  for (const root of TEMPLATE_SCRIPT_ROOTS) {
    const p = `${root}/${template}.sh`
    try {
      await access(p)
      return p
    } catch {
      continue
    }
  }
  return null
}

async function applyForReal(
  script: string,
  backend: string,
): Promise<{ ok: boolean; command: string; via: string; output: string; error?: string }> {
  // The ruleset rides stdin: `nft -f -` and `iptables-restore` both read
  // scripts from the pipe, so no predictable /tmp path exists to hijack.
  const bin = backend === 'iptables' ? 'iptables-restore' : 'nft'
  const args = backend === 'iptables' ? [] : ['-f', '-']
  const command = `${bin} ${args.join(' ')} < ruleset`
  let res: { rc: number; stdout: string; stderr: string }
  if (isRoot()) {
    res = await run(bin, args, 30_000, { input: script })
    return { ok: res.rc === 0, command, via: 'root', output: res.stdout || res.stderr, error: res.rc === 0 ? undefined : res.stderr.trim().split('\n')[0] }
  }
  if (await havePasswordlessSudo()) {
    res = await run('sudo', ['-n', bin, ...args], 30_000, { input: script })
    return { ok: res.rc === 0, command: `sudo -n ${command}`, via: 'sudo -n', output: res.stdout || res.stderr, error: res.rc === 0 ? undefined : res.stderr.trim().split('\n')[0] }
  }
  return { ok: false, command, via: 'none', output: '', error: 'org.sysdeck.firewall.modify — not authorized: this console process is unprivileged and has no passwordless sudo' }
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  templates: async () => {
    return ok(
      {
        templates: TEMPLATES.map(({ id, name, description, ports, backend }) => ({ id, name, description, ports, backend })),
        count: TEMPLATES.length,
        scriptsShipped: TEMPLATES.filter((t) => existsSync(`${process.cwd()}/../firewall/templates/${t.id}.sh`) || t.id === 'cilium').length,
      },
      'live',
      'template topologies ported verbatim from firewall/templates/*.sh — the executable scripts ship in the tarball and install to /usr/share/sysdeck/firewall/templates/',
    )
  },

  rulesets: async () => {
    const rulesets = await db.fwRuleset.findMany({ orderBy: { name: 'asc' } })
    const counts = await Promise.all(rulesets.map((r) => db.fwRule.count({ where: { ruleset: r.name } })))
    const haveNft = await which('nft')
    const haveIpt = await which('iptables')
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
        firewalls: { nftables: haveNft, iptables: haveIpt },
      },
      'live',
      rulesets.length
        ? 'operator rulesets (created from this panel — never seeded)'
        : `no rulesets yet — create one from a template below; host firewall binaries: ${haveNft ? 'nft ✓' : 'nft ✗'} ${haveIpt ? 'iptables ✓' : 'iptables ✗'}`,
    )
  },

  live: async () => {
    // the host's REAL active ruleset, straight from the firewall binary
    if (await which('nft')) {
      const r = await run('nft', ['-j', 'list', 'ruleset'], 15_000)
      if (r.rc === 0) {
        let tables = 0
        try {
          const parsed = JSON.parse(r.stdout) as unknown[]
          tables = parsed.length
        } catch {
          tables = r.stdout.split('"table ').length - 1
        }
        return ok({ backend: 'nftables', tables, json: r.stdout.slice(0, 200_000) }, 'live', 'real `nft -j list ruleset`')
      }
      return failE(`nft -j list ruleset failed — ${r.stderr.trim().split('\n')[0] ?? 'needs root'}`)
    }
    if (await which('iptables')) {
      const r = await run('iptables-save', [], 15_000)
      if (r.rc === 0) {
        return ok(
          { backend: 'iptables', tables: (r.stdout.match(/^\*filter|^\*nat|^\*mangle/gm) ?? []).length, text: r.stdout.slice(0, 200_000) },
          'live',
          'real iptables-save output',
        )
      }
      return failE(`iptables-save failed — ${r.stderr.trim().split('\n')[0] ?? 'needs root'}`)
    }
    return ok(
      { backend: null, tables: 0, note: 'neither nft nor iptables is present on this host — nothing to read; the panel below still manages ruleset definitions and can apply them the moment a firewall binary exists' },
      'live',
      'no firewall binary detected (probed: nft, iptables)',
    )
  },

  rules: async (args: Record<string, unknown>) => {
    const ruleset = String(args.ruleset ?? '')
    if (!ruleset) return failE('ruleset is required')
    const rs = await db.fwRuleset.findUnique({ where: { name: ruleset } })
    if (!rs) return failE(`ruleset '${ruleset}' not found`)
    const rules = await db.fwRule.findMany({ where: { ruleset }, orderBy: { position: 'asc' } })
    return ok(
      { ruleset: { name: rs.name, backend: rs.backend, template: rs.template, active: rs.active, appliedAt: rs.appliedAt }, rules, count: rules.length },
      'live',
    )
  },

  create: async (args: Record<string, unknown>) => {
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
    const row = await db.fwRuleset.create({ data: { name, backend, template, active: false } })
    if (tplRules.length > 0) {
      await db.fwRule.createMany({ data: tplRules.map((r, i) => ({ ...r, ruleset: name, position: i + 1 })) })
    }
    await audit('create', `ruleset ${name} (backend ${backend}${template ? `, from template ${template}` : ''}) with ${tplRules.length} rules`)
    return ok({ ruleset: { name: row.name, backend: row.backend, template: row.template, active: row.active }, rules: tplRules.length }, 'live')
  },

  apply: async (args: Record<string, unknown>) => {
    const name = String(args.name ?? '').trim()
    const dryRun = args.dryRun === true
    if (!name) return failE('name is required')
    const rs = await db.fwRuleset.findUnique({ where: { name } })
    if (!rs) return failE(`ruleset '${name}' not found`)
    const rules = (await db.fwRule.findMany({ where: { ruleset: name }, orderBy: { position: 'asc' } })) as unknown as RuleRow[]

    // template-derived ruleset with a shipped executable script → run the REAL script
    const scriptPath = rs.template ? await templateScriptPath(rs.template) : null
    if (scriptPath && rs.backend !== 'iptables' && !dryRun) {
      let res: { rc: number; stdout: string; stderr: string }
      if (isRoot()) res = await run(scriptPath, [], 60_000)
      else if (await havePasswordlessSudo()) res = await run('sudo', ['-n', scriptPath], 60_000)
      else {
        return failE(
          `org.sysdeck.firewall.modify — not authorized: run as root or grant sudo -n to execute:\n  ${scriptPath}`,
          'hybrid',
        )
      }
      await audit('apply', `ruleset ${name} ACTIVATED via shipped template script ${scriptPath} (rc=${res.rc})`)
      if (res.rc !== 0) return failE(`${scriptPath} failed — ${res.stderr.trim().split('\n')[0] ?? 'script error'}`)
      await db.fwRuleset.updateMany({ where: { active: true, NOT: { name } }, data: { active: false } })
      const row = await db.fwRuleset.update({ where: { name }, data: { active: true, appliedAt: new Date() } })
      return ok({ ruleset: row, applied: true, rules: rules.length, command: scriptPath, via: 'template script' }, 'live', `executed the shipped executable template ${scriptPath}`)
    }

    // dry-run previews EXACTLY what apply would load: the shipped template
    // script when one exists, otherwise the synthesized ruleset text.
    if (dryRun) {
      if (scriptPath) {
        const shipped = await readText(scriptPath)
        return ok(
          { name, backend: rs.backend, script: shipped.slice(0, 200_000), shipped: scriptPath, rules: rules.length },
          'live',
          `dry run — apply executes the shipped template script ${scriptPath} (shown verbatim); nothing was loaded`,
        )
      }
      const script = rs.backend === 'iptables' ? iptablesScript(rs, rules) : nftScript(rs, rules)
      return ok(
        { name, backend: rs.backend, script, rules: rules.length },
        'live',
        'dry run — the exact ruleset text that would be applied (nft/iptables syntax), nothing was loaded',
      )
    }

    const script = rs.backend === 'iptables' ? iptablesScript(rs, rules) : nftScript(rs, rules)
    const res = await applyForReal(script, rs.backend)
    await audit('apply', `ruleset ${name} → ${res.command} via ${res.via} — ${res.ok ? 'APPLIED' : 'FAILED'}`)
    if (!res.ok) {
      return failE(`${res.error ?? 'apply failed'} — the operator command:\n  ${res.command}`, 'hybrid')
    }
    await db.fwRuleset.updateMany({ where: { active: true, NOT: { name } }, data: { active: false } })
    const row = await db.fwRuleset.update({ where: { name }, data: { active: true, appliedAt: new Date() } })
    return ok(
      { ruleset: row, applied: true, rules: rules.length, command: res.command, via: res.via, output: res.output.split('\n').slice(-5).join('\n') },
      'live',
      `real apply via ${res.via}`,
    )
  },

  delete: async (args: Record<string, unknown>) => {
    const name = String(args.name ?? '').trim()
    if (!name) return failE('name is required')
    const rs = await db.fwRuleset.findUnique({ where: { name } })
    if (!rs) return failE(`ruleset '${name}' not found`)
    if (rs.active) return failE(`ruleset '${name}' is ACTIVE — deactivate/apply another ruleset before deleting`)
    await db.fwRule.deleteMany({ where: { ruleset: name } })
    await db.fwRuleset.delete({ where: { name } })
    await audit('delete', `ruleset ${name} deleted (all rules removed)`)
    return ok({ deleted: { name } }, 'live')
  },

  addRule: async (args: Record<string, unknown>) => {
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
    if (comment && !/^[\x20-\x7e]{1,120}$/.test(comment)) return failE('invalid comment — printable ASCII only, no newlines or control characters, max 120 chars')
    const rs = await db.fwRuleset.findUnique({ where: { name: ruleset } })
    if (!rs) return failE(`ruleset '${ruleset}' not found`)
    const last = await db.fwRule.findFirst({ where: { ruleset }, orderBy: { position: 'desc' } })
    const position = (last?.position ?? 0) + 1
    const row = await db.fwRule.create({ data: { ruleset, chain, action, proto, port, source, comment, position } })
    await audit('addRule', `ruleset ${ruleset}: +${chain} ${action} ${proto}${port ? ` dport ${port}` : ''}${source ? ` from ${source}` : ''} (position ${position})`)
    return ok({ rule: row, ruleset }, 'live')
  },

  deleteRule: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '').trim()
    if (!id) return failE('id is required')
    const rule = await db.fwRule.findUnique({ where: { id } })
    if (!rule) return failE('rule not found')
    await db.fwRule.delete({ where: { id } })
    await audit('deleteRule', `ruleset ${rule.ruleset}: removed position ${rule.position} (${rule.chain} ${rule.action}${rule.port ? ` ${rule.port}` : ''})`)
    return ok({ deleted: { id, ruleset: rule.ruleset, position: rule.position } }, 'live')
  },
}

function validRulesetName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)
}
