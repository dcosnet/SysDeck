// Master tarball release metadata — reports the sha256/size of the
// sysdeck-0.4.4-master bundle in public/download (built by
// scripts/make-master-tarball.sh). The tarball itself is served
// statically at /download/sysdeck-0.4.4-master.tar.bz2.
//
// As of 0.3.1 every web surface is gated; 0.4.0 gates it with the unix-account session
// — the tarball file itself stays a plain static
// download.
//
// The bundle: cockpit edition (27 plugins + python bridge) + web edition
// (this Next.js app) + fester pre-integrated (vendored at
// web/mini-services/fester, its own version) + klanker-gate vendored
// (the Frosty Deno LLM gateway, own version 0.9.0, with arch/ packaging).
// klanker-gate is NOT SysDeck code — it is by TykoDev
// (https://github.com/TykoDev/klanker-gate, Apache-2.0), credited in
// klanker-gate/ATTRIBUTION.md and THIRD_PARTY.md inside the tarball.
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { requireSession } from '@/lib/sysdeck/session'

export const dynamic = 'force-dynamic'

const FILE = 'sysdeck-0.4.4-master.tar.bz2'
const DOWNLOAD_DIR = path.join(process.cwd(), 'public', 'download')

// hash cache — recompute when the file size OR mtime changes (rebuild)
let cache: { sizeBytes: number; sha256: string; builtAt: string; mtimeMs: number } | null = null

export async function GET(req: Request) {
  const denied = await requireSession(req)
  if (denied) return denied

  const filePath = path.join(DOWNLOAD_DIR, FILE)
  try {
    const st = await stat(filePath)
    if (!cache || cache.sizeBytes !== st.size || cache.mtimeMs !== st.mtimeMs) {
      const buf = await readFile(filePath)
      cache = {
        sizeBytes: st.size,
        sha256: createHash('sha256').update(buf).digest('hex'),
        builtAt: st.mtime.toISOString(),
        mtimeMs: st.mtimeMs,
      }
    }
    return NextResponse.json({
      ok: true,
      version: '0.4.4',
      edition: 'master',
      file: FILE,
      url: `/download/${FILE}`,
      sizeBytes: cache.sizeBytes,
      sha256: cache.sha256,
      builtAt: cache.builtAt,
      fester: {
        version: '0.2.1',
        vendoredAt: 'web/mini-services/fester',
        transport: 'rest+ws :3010',
      },
      klanker: {
        version: '0.9.0',
        vendoredAt: 'klanker-gate',
        transport: 'rest :8080 (KLANKER_URL)',
        archPackaging: 'arch/ — PKGBUILD + systemd unit + INSTALL-ARCH.md',
        upstream: 'TykoDev — https://github.com/TykoDev/klanker-gate (Apache-2.0)',
      },
      bundle: {
        cockpit: '27 cockpit plugins + python bridge (upstream layout)',
        web: 'SysDeck Web Edition — Next.js 16, 29 bridge modules',
        fester: 'Fester DAG orchestration service, pre-integrated',
        klanker: 'Frosty Deno LLM gateway by TykoDev, vendored with Arch packaging',
      },
    })
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: 'master tarball not built yet — run scripts/make-master-tarball.sh',
      },
      { status: 404 },
    )
  }
}
