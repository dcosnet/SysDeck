'use client'

// Runbook panel — "Run without Cockpit". The complete standalone
// deployment guide for the SysDeck Web Edition: the whole console on
// the Next.js backend alone. No Cockpit, no systemd requirement, no
// Python bridge — one `bun run dev` (or a production build) serves
// all 29 modules.
//
// This is static documentation rendered as a first-class panel: every
// command block carries a copy-to-clipboard button, and the content
// mirrors web/README.md in the master tarball byte-for-byte in intent.

import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Check, Copy, ExternalLink, Server, Terminal } from 'lucide-react'
import { PanelCard, PanelHeader } from '@/components/sysdeck/ui'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// ── code block with copy button ─────────────────────────────────────

function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
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
    <div className="group relative overflow-hidden rounded-md border bg-black/40">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          <Terminal className="h-3 w-3" aria-hidden />
          {label ?? 'shell'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 font-mono text-[10px] text-muted-foreground"
          onClick={copy}
          aria-label={copied ? 'Copied' : 'Copy command to clipboard'}
        >
          {copied ? <Check className="h-3 w-3 text-emerald-400" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
          {copied ? 'copied' : 'copy'}
        </Button>
      </div>
      <pre className="sd-scroll overflow-x-auto px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function Step({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <PanelCard
      title={
        <span className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-primary/15 font-mono text-[10px] font-bold text-primary ring-1 ring-primary/30">
            {n}
          </span>
          {title}
        </span>
      }
    >
      <div className="space-y-3 text-sm leading-relaxed">{children}</div>
    </PanelCard>
  )
}

function Note({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'good'; children: ReactNode }) {
  const cls = {
    info: 'border-primary/30 bg-primary/10 text-foreground',
    warn: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    good: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  }[tone]
  return <div className={cn('rounded-md border px-3 py-2 text-xs leading-relaxed', cls)}>{children}</div>
}

// ── panel ───────────────────────────────────────────────────────────

export default function RunbookPanel() {
  return (
    <div className="space-y-4">
      <PanelHeader
        title="Run without Cockpit"
        subtitle="The standalone deployment runbook — the entire SysDeck console on the Next.js backend alone. No Cockpit, no Python bridge, no systemd required."
        source="live"
      />

      {/* what replaces what */}
      <PanelCard title="What you are actually running">
        <div className="space-y-3 text-sm leading-relaxed">
          <p>
            The Web Edition is a self-contained <strong>Next.js 16</strong> application. Everything the Cockpit
            edition needed a desktop session + Python bridge for is served by the web backend directly:
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              ['Cockpit plugin shell', 'one page at / with a 29-module sidebar registry'],
              ['bridge/*.py (27 modules)', 'POST /api/bridge → TypeScript bridge modules, same command surface'],
              ['cockpit.conf + file state', 'Prisma + SQLite at db/custom.db (theme, baselines, runs)'],
              ['Fester (sidecar)', 'bundled mini-service on :3010 — REST proxied, events over WebSocket'],
              ['klanker-gate', 'optional — point the AI Gateway panel at any running gateway'],
              ['systemd / root', 'not required — unprivileged user, any Linux/BSD/macOS'],
            ].map(([was, now]) => (
              <div key={was} className="rounded-md border bg-card/60 p-2.5">
                <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground line-through decoration-muted-foreground/50">
                  {was}
                </p>
                <p className="mt-0.5 text-xs text-foreground">{now}</p>
              </div>
            ))}
          </div>
          <Note tone="good">
            The Cockpit edition is still in the same master tarball (bundle root, <span className="font-mono">make install</span>) — it is now{' '}
            <em>optional</em>, not required. Both editions read the same design language; the Cockpit plugin pages even ship the web-edition skin (
            <span className="font-mono">shared/sysdeck-web.css</span>) since 0.3.0.
          </Note>
        </div>
      </PanelCard>

      {/* runtime topology */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { k: 'web edition', v: ':3000', h: 'next dev / standalone server' },
          { k: 'bridge', v: '/api/bridge', h: 'POST {module, command, args}' },
          { k: 'fester', v: ':3010', h: 'optional — DAG orchestrator' },
          { k: 'state', v: 'SQLite', h: 'db/custom.db via Prisma' },
        ].map((s) => (
          <div key={s.k} className="rounded-lg border bg-card p-3">
            <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              <Server className="h-3 w-3" aria-hidden />
              {s.k}
            </p>
            <p className="mt-1 font-mono text-base font-semibold text-primary">{s.v}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{s.h}</p>
          </div>
        ))}
      </div>

      {/* the runbook */}
      <Step n="1" title="Prerequisites">
        <ul className="list-disc space-y-1.5 pl-4 text-xs">
          <li>
            <strong>Bun ≥ 1.1</strong> (preferred) —{' '}
            <span className="font-mono text-[11px]">pacman -S bun</span> on Arch, or{' '}
            <span className="font-mono text-[11px]">curl -fsSL https://bun.sh/install | bash</span> anywhere else.
          </li>
          <li>
            …or <strong>Node.js ≥ 20</strong> for the build-only path (see step 5 — <span className="font-mono text-[11px]">node .next/standalone/server.js</span>).
          </li>
          <li>~200 MB disk for dependencies, ~512 MB RAM. SQLite is bundled via Prisma — no database server.</li>
          <li>
            <strong>Not required:</strong> Cockpit, systemd, Docker, root. The app runs as an unprivileged user.
          </li>
        </ul>
      </Step>

      <Step n="2" title="Quickstart — one command (dev)">
        <p className="text-xs">
          From the extracted master tarball root, the Cockpit Makefile has a web-edition launcher that installs,
          migrates the database, starts the Fester service in the background and boots Next.js on :3000:
        </p>
        <CodeBlock
          label="bundle root"
          code={`tar xjf sysdeck-0.4.1-master.tar.bz2
cd sysdeck-0.4.1-master
make web-dev        # bun install + db:push + fester + next dev :3000`}
        />
        <p className="text-xs">Then open <span className="font-mono">http://localhost:3000</span>. Done — that is the whole console.</p>
      </Step>

      <Step n="3" title="Quickstart — granular (what make web-dev does)">
        <CodeBlock
          label="web/"
          code={`cd sysdeck-0.3.1-master/web
bun install                     # dependencies
bun run db:push                 # create + migrate db/custom.db (SQLite)
bun run dev                     # Next.js on :3000

# optional — the Fester DAG orchestrator (own service, :3010):
cd mini-services/fester
bun install
bun run dev                     # bun --hot index.ts`}
        />
        <Note>
          The Fester panel proxies REST through <span className="font-mono">/api/fester</span> (server-side, no extra
          port exposure) and streams live build events over WebSocket through the gateway (
          <span className="font-mono">/?XTransformPort=3010</span>). Without the service running, the Fester panel
          says so — everything else works.
        </Note>
      </Step>

      <Step n="4" title="Production build">
        <p className="text-xs">
          The build emits a self-contained standalone server (<span className="font-mono">.next/standalone/</span> with
          static assets and public/ folded in):
        </p>
        <CodeBlock
          label="web/ — bun"
          code={`bun install
bun run build                   # next build + fold static/ & public/ into standalone
PORT=3000 HOSTNAME=0.0.0.0 bun run start`}
        />
        <CodeBlock
          label="web/ — node-only hosts"
          code={`bun run build                    # or: npx next build
PORT=3000 HOSTNAME=0.0.0.0 node .next/standalone/server.js`}
        />
        <Note tone="warn">
          Run <span className="font-mono">bun run db:push</span> once before the first production start — the SQLite
          file lives at <span className="font-mono">db/custom.db</span> (path from{' '}
          <span className="font-mono">DATABASE_URL</span> in .env). Keep the bundle layout intact so{' '}
          <span className="font-mono">../db</span> resolves.
        </Note>
      </Step>

      <Step n="5" title="systemd service (Arch Linux)">
        <p className="text-xs">
          Deploy the extracted bundle to <span className="font-mono">/opt/sysdeck</span> and run the web edition (and
          Fester) as services. Fester&apos;s unit uses plain <span className="font-mono">bun index.ts</span> — no hot
          reload in production:
        </p>
        <CodeBlock
          label="/etc/systemd/system/sysdeck-web.service"
          code={`[Unit]
Description=SysDeck Web Edition (Next.js)
After=network-online.target

[Service]
Type=simple
User=sysdeck
WorkingDirectory=/opt/sysdeck/web
Environment=PORT=3000
Environment=HOSTNAME=0.0.0.0
Environment=NODE_ENV=production
ExecStart=/usr/bin/bun run start
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target`}
        />
        <CodeBlock
          label="/etc/systemd/system/sysdeck-fester.service"
          code={`[Unit]
Description=SysDeck Fester — DAG build orchestration
After=network-online.target sysdeck-web.service

[Service]
Type=simple
User=sysdeck
WorkingDirectory=/opt/sysdeck/web/mini-services/fester
ExecStart=/usr/bin/bun index.ts
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target`}
        />
        <CodeBlock
          label="enable"
          code={`sudo useradd -r -d /opt/sysdeck -s /usr/sbin/nologin sysdeck || true
sudo systemctl enable --now sysdeck-web.service sysdeck-fester.service`}
        />
      </Step>

      <Step n="6" title="Environment (.env in web/)">
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/50 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2">variable</th>
                <th className="px-3 py-2">default</th>
                <th className="px-3 py-2">purpose</th>
              </tr>
            </thead>
            <tbody className="font-mono text-[11px]">
              {[
                ['DATABASE_URL', 'file:../db/custom.db', 'SQLite file for theme, baselines, runs (Prisma)'],
                ['KLANKER_URL', '—', 'AI Gateway panel → live gateway (e.g. http://127.0.0.1:8080)'],
                ['KLANKER_ADMIN_TOKEN', '—', 'admin token for that gateway (FROSTY_ADMIN_TOKEN)'],
                ['PORT / HOSTNAME', '3000 / localhost', 'standalone server bind (use 0.0.0.0 for LAN)'],
              ].map(([v, d, p]) => (
                <tr key={v} className="border-b last:border-0">
                  <td className="px-3 py-2 text-foreground">{v}</td>
                  <td className="px-3 py-2 text-muted-foreground">{d}</td>
                  <td className="px-3 py-2 font-sans text-foreground">{p}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Note>
          With no <span className="font-mono">KLANKER_URL</span>, the AI Gateway panel renders clearly-badged demo
          data (it flips to <span className="font-mono">LIVE</span> automatically when the gateway answers). On Arch,
          the gateway is one package away — <span className="font-mono">klanker-gate/arch/INSTALL-ARCH.md</span>.
        </Note>
      </Step>

      <Step n="7" title="Reverse proxy + WebSocket gateway">
        <p className="text-xs">
          A bundled <span className="font-mono">Caddyfile</span> implements the port-gateway pattern: every request
          carrying <span className="font-mono">?XTransformPort=&lt;port&gt;</span> is forwarded to that localhost port
          (this is how the Fester event stream crosses the single public port). Adapt the listener to your domain:
        </p>
        <CodeBlock
          label="Caddyfile (bundled — caddy run)"
          code={`sysdeck.example.com {
    @ws query XTransformPort=*
    handle @ws {
        reverse_proxy localhost:{query.XTransformPort}
    }
    handle {
        reverse_proxy 127.0.0.1:3000
    }
}`}
        />
        <CodeBlock
          label="nginx equivalent"
          code={`location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;    # websocket (XTransformPort=3010)
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
# ws traffic carries ?XTransformPort=3010 — split it to the fester port:
location / {
    if ($arg_XTransformPort) { proxy_pass http://127.0.0.1:$arg_XTransformPort; }
}`}
        />
      </Step>

      <Step n="8" title="Troubleshooting">
        <div className="space-y-2">
          {[
            [
              'PrismaClientInitializationError / "database not found"',
              'The SQLite file was never created — run bun run db:push in web/, and check DATABASE_URL points at db/custom.db relative to the bundle layout.',
            ],
            ['Port 3000 already in use', 'Start with PORT=3001 bun run dev (or stop the other listener). Every URL stays relative.'],
            ['Panels show a DEMO badge', 'Expected — the host lacks that backend (docker/kubectl/pacman). Panels badged LIVE read real /proc, /sys, lsblk data.'],
            ['Fester panel says service unreachable', 'The mini-service is not running: (cd mini-services/fester && bun run dev). REST is proxied server-side; only the event stream needs the port gateway.'],
            ['AI Gateway shows demo data', 'Set KLANKER_URL + KLANKER_ADMIN_TOKEN in web/.env, restart, or install the gateway via klanker-gate/arch/INSTALL-ARCH.md.'],
            ['Edits not appearing', 'Dev recompiles on save (check dev.log); production needs bun run build again.'],
          ].map(([sym, fix]) => (
            <div key={sym} className="rounded-md border bg-card/60 p-2.5">
              <p className="font-mono text-[11px] text-amber-300">{sym}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{fix}</p>
            </div>
          ))}
        </div>
      </Step>

      <PanelCard title="Cockpit is optional, not gone">
        <div className="space-y-3 text-sm">
          <p className="text-xs leading-relaxed">
            The same master tarball still ships the full Cockpit edition at the bundle root — 27 plugins + the Python
            bridge, installable with <span className="font-mono">sudo make install</span> (restart{' '}
            <span className="font-mono">cockpit.socket</span>). Since 0.3.0 the Cockpit plugin pages wear the
            web-edition skin by default, and <span className="font-mono">sudo make install-branding</span> themes the
            Cockpit shell chrome itself to match. Prefer the pure-web path? You already have it — steps 2–7 above are
            the complete instructions.
          </p>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="font-mono text-[10px]">bundle root = cockpit edition</Badge>
            <Badge variant="outline" className="font-mono text-[10px]">web/ = web edition</Badge>
            <Badge variant="outline" className="font-mono text-[10px]">web/mini-services/fester = orchestrator</Badge>
            <Badge variant="outline" className="font-mono text-[10px]">klanker-gate/ = AI gateway</Badge>
          </div>
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ExternalLink className="h-3 w-3" aria-hidden />
            The same runbook ships as web/README.md inside the master tarball.
          </p>
        </div>
      </PanelCard>
    </div>
  )
}
