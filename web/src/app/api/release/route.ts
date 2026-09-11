// Master tarball release metadata — reports the sha256/size of the
// sysdeck-0.2.0-master bundle in public/download (built by
// scripts/make-master-tarball.sh). The tarball itself is served
// statically at /download/sysdeck-0.2.0-master.tar.bz2.
//
// The bundle: cockpit edition (26 plugins + python bridge) + web edition
// (this Next.js app) + fester pre-integrated (vendored at
// web/mini-services/fester, its own version).
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

export const dynamic = 'force-dynamic'

const FILE = 'sysdeck-0.2.0-master.tar.bz2'
const DOWNLOAD_DIR = path.join(process.cwd(), 'public', 'download')

// hash cache — recompute when the file size OR mtime changes (rebuild)
let cache: { sizeBytes: number; sha256: string; builtAt: string; mtimeMs: number } | null = null

export async function GET() {
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
      version: '0.2.0',
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
      bundle: {
        cockpit: '26 cockpit plugins + python bridge (upstream layout)',
        web: 'SysDeck Web Edition — Next.js 16, 28 bridge modules',
        fester: 'Fester DAG orchestration service, pre-integrated',
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
