// SysDeck web edition — account sources for unix login (v0.4.0).
//
// Two stores, one identity model:
//   unix  → /etc/passwd + /etc/group, authenticated by PAM (pam-auth.py)
//   local → the SdUser SQLite table, scrypt-hashed, for installs where
//           the PAM path cannot serve (non-root service uid, no
//           python3) — SYSDECK_AUTH_MODE=local / pam+local
//
// The route layer decides which store authenticates; this module only
// reads/enriches identity (gecos, uid/gid, admin group membership) so
// the shell can render a cockpit-style user menu.
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import os from 'node:os'
import { db } from '@/lib/db'

export interface ConsoleUser {
  username: string
  realname: string | null
  uid: number | null
  gid: number | null
  home: string | null
  shell: string | null
  isAdmin: boolean
  source: 'unix' | 'local' | 'legacy'
}

export type AuthMode = 'pam' | 'local' | 'pam+local'

/** Effective auth mode (default pam: the host decides, like cockpit). */
export function authMode(): AuthMode {
  const raw = (process.env.SYSDECK_AUTH_MODE ?? 'pam').trim().toLowerCase()
  if (raw === 'local' || raw === 'pam+local' || raw === 'pam') return raw
  return 'pam'
}

/** A login-safe username: what pam would accept as a name. */
export function validUsername(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 64 &&
    /^[a-z_][a-z0-9_.-]*\$?$/i.test(name)
  )
}

/** Parse /etc/passwd once per minute — it barely ever changes. */
let passwdCache: { rows: Map<string, { uid: number; gid: number; gecos: string; home: string; shell: string }>; readAt: number } | null = null

async function passwdRows(): Promise<Map<string, { uid: number; gid: number; gecos: string; home: string; shell: string }>> {
  const now = Date.now()
  if (passwdCache && now - passwdCache.readAt < 60_000) return passwdCache.rows
  const rows = new Map<string, { uid: number; gid: number; gecos: string; home: string; shell: string }>()
  try {
    const text = await readFile('/etc/passwd', 'utf-8')
    for (const line of text.split('\n')) {
      if (!line) continue
      const [name, , uidS, gidS, gecos, home, shell] = line.split(':')
      if (!name || uidS === undefined) continue
      const uid = Number(uidS)
      const gid = Number(gidS)
      if (!Number.isFinite(uid)) continue
      rows.set(name, { uid, gid, gecos: gecos ?? '', home: home ?? '', shell: shell ?? '' })
    }
  } catch {
    /* no /etc/passwd (non-Linux dev box) — local store still works */
  }
  passwdCache = { rows, readAt: now }
  return rows
}

/** Admin groups that unlock the "administrative access" badge. */
const ADMIN_GROUPS = new Set(['wheel', 'sudo', 'adm', 'administrator', 'root'])

let groupCache: { adminNames: Set<string>; readAt: number } | null = null

async function adminUsernames(): Promise<Set<string>> {
  const now = Date.now()
  if (groupCache && now - groupCache.readAt < 60_000) return groupCache.adminNames
  const adminNames = new Set<string>()
  try {
    const text = await readFile('/etc/group', 'utf-8')
    for (const line of text.split('\n')) {
      if (!line) continue
      const [name, , , members] = line.split(':')
      if (!name || !ADMIN_GROUPS.has(name)) continue
      for (const m of (members ?? '').split(',')) {
        const trimmed = m.trim()
        if (trimmed) adminNames.add(trimmed)
      }
    }
  } catch {
    /* no /etc/group — nobody is admin-flagged */
  }
  groupCache = { adminNames, readAt: now }
  return adminNames
}

/** Enriched identity for a username, unix store first, local second. */
export async function consoleUser(username: string): Promise<ConsoleUser | null> {
  const admins = await adminUsernames()
  const rows = await passwdRows()
  const unix = rows.get(username)
  if (unix) {
    return {
      username,
      realname: unix.gecos ? unix.gecos.split(',')[0].trim() || null : null,
      uid: unix.uid,
      gid: unix.gid,
      home: unix.home || null,
      shell: unix.shell || null,
      isAdmin: admins.has(username) || unix.uid === 0,
      source: 'unix',
    }
  }
  try {
    const local = await db.sdUser.findUnique({ where: { username } })
    if (local) {
      return {
        username,
        realname: local.realname,
        uid: null,
        gid: null,
        home: null,
        shell: null,
        isAdmin: username === 'root' || admins.has(username),
        source: 'local',
      }
    }
  } catch {
    /* db hiccup — identity enrichment is best-effort */
  }
  return null
}

/** Identity for a legacy v1 token (pre-0.4.0 shared-password session). */
export function legacyUser(): ConsoleUser {
  return {
    username: 'operator',
    realname: 'Shared session (pre-0.4.0 cookie)',
    uid: null,
    gid: null,
    home: null,
    shell: null,
    isAdmin: false,
    source: 'legacy',
  }
}

// ── local account store (SdUser) ────────────────────────────────────

const SCRYPT_N = 16384
const SCRYPT_r = 8
const SCRYPT_p = 1
const SCRYPT_KEYLEN = 32

/** scrypt hash in the phpass-adjacent `salt$N$r$p$hex` format. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const key = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p })
  return [salt, SCRYPT_N, SCRYPT_r, SCRYPT_p, key.toString('hex')].join('$')
}

/** Constant-time verify against a stored `salt$N$r$p$hex` hash. */
export function verifyLocalPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 5) return false
  const [salt, nS, rS, pS, hex] = parts
  const N = Number(nS)
  const r = Number(rS)
  const p = Number(pS)
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false
  try {
    const expected = scryptSync(password, salt, SCRYPT_KEYLEN, { N, r, p })
    const candidate = Buffer.from(hex, 'hex')
    if (candidate.length !== expected.length) return false
    return timingSafeEqual(expected, candidate)
  } catch {
    return false
  }
}

/** Authenticate against the local SdUser store; updates nothing. */
export async function authenticateLocal(username: string, password: string): Promise<ConsoleUser | null> {
  try {
    const row = await db.sdUser.findUnique({ where: { username } })
    if (!row || row.disabled) return null
    if (!verifyLocalPassword(password, row.hash)) return null
    return await consoleUser(username)
  } catch {
    return null
  }
}

/** Mark a successful local login (audit trail in the table itself). */
export async function touchLocalLogin(username: string, ip: string): Promise<void> {
  try {
    await db.sdUser.update({ where: { username }, data: { lastLoginAt: new Date(), lastLoginIp: ip } })
  } catch {
    /* best-effort */
  }
}

/**
 * First-boot convenience: seed a local account matching the service's
 * own unix user with the documented default password — only in
 * local/pam+local modes, and only when the table is empty. The login
 * screen nags in amber until the operator rotates it
 * (web/scripts/manage-users.mjs passwd <name>).
 */
let seedChecked = false
export async function seedDefaultLocalAccount(): Promise<void> {
  if (seedChecked) return
  seedChecked = true
  const mode = authMode()
  if (mode === 'pam') return
  try {
    const count = await db.sdUser.count()
    if (count > 0) return
    const name = os.userInfo().username || 'sysdeck'
    await db.sdUser.create({
      data: {
        username: name,
        realname: 'Console operator (seeded default)',
        hash: hashPassword('sysdeck'),
      },
    })
    console.log(`[auth] seeded local account '${name}' with the default password (rotate it!)`)
  } catch {
    /* table missing / db busy — the manage-users CLI can still add accounts */
  }
}

/** True when any enabled local account still authenticates with the documented default (nag). */
export async function hasDefaultPasswordAccount(): Promise<boolean> {
  try {
    const rows = await db.sdUser.findMany({ select: { hash: true, disabled: true } })
    return rows.some((r) => !r.disabled && verifyLocalPassword('sysdeck', r.hash))
  } catch {
    return false
  }
}

/** Host identity for the login banner (public on a LAN console). */
export function hostIdentity(): { hostname: string; prettyName: string | null } {
  const hostname = os.hostname() || 'sysdeck'
  let prettyName: string | null = null
  try {
    const text = readFileSync('/etc/os-release', 'utf-8')
    const m = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(text)
    if (m) prettyName = m[1]
  } catch {
    /* non-Linux / unreadable — hostname alone is fine */
  }
  return { hostname, prettyName }
}

/** Stable color for the avatar ring — one hue per username. */
export function avatarHue(username: string): number {
  const h = createHash('sha256').update(username).digest()[0]
  return Math.round((h / 255) * 360)
}
