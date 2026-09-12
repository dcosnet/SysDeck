#!/usr/bin/env bun
// SysDeck web edition — local console-account manager (v0.4.0).
//
// Manages the SdUser table used by SYSDECK_AUTH_MODE=local / pam+local
// (the fallback when the host PAM path can't serve the install — e.g.
// a non-root service uid, where unix_chkpwd only verifies the invoking
// user). PAM is still the primary login path; these accounts are the
// documented escape hatch, not the default.
//
//   bun scripts/manage-users.mjs list
//   bun scripts/manage-users.mjs add <username> [--realname "Jane Doe"]
//   bun scripts/manage-users.mjs passwd <username>      # prompts, hidden
//   bun scripts/manage-users.mjs disable <username>
//   bun scripts/manage-users.mjs enable <username>
//   bun scripts/manage-users.mjs remove <username>
//
// Run from web/ (the db path comes from DATABASE_URL, default ../db/custom.db).
import { createInterface } from 'node:readline'
import { randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

// minimal prisma client bootstrap without a generated engine:
// talk straight to SQLite via bun:sqlite — the table is tiny and the
// schema is fixed, so hand-rolled SQL beats shipping prisma here.
import { Database } from 'bun:sqlite'

const dbUrl = process.env.DATABASE_URL ?? 'file:../db/custom.db'
const dbFile = dbFileOf(dbUrl)

function dbFileOf(url: string): string {
  const raw = url.replace(/^file:/, '').split('?')[0]
  return path.resolve(process.cwd(), raw)
}

function openDb() {
  if (!existsSync(dbFile)) {
    mkdirSync(path.dirname(dbFile), { recursive: true })
  }
  const db = new Database(dbFile)
  db.exec(`CREATE TABLE IF NOT EXISTS "SdUser" (
    "username"    TEXT NOT NULL PRIMARY KEY,
    "realname"    TEXT,
    "hash"        TEXT NOT NULL,
    "disabled"    BOOLEAN NOT NULL DEFAULT 0,
    "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   DATETIME NOT NULL,
    "lastLoginAt" DATETIME,
    "lastLoginIp" TEXT
  )`)
  return db
}

// scrypt in the exact format src/lib/sysdeck/users.ts verifies:
// salt$N$r$p$hex  (constant-time verify lives there)
const N = 16384, R = 8, P = 1, KEYLEN = 32
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const key = scryptSync(password, salt, KEYLEN, { N, r: R, p: P })
  return [salt, N, R, P, key.toString('hex')].join('$')
}

function promptPassword(): string {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve) => {
    process.stderr.write('password: ')
    rl.once('line', (line) => {
      process.stderr.write('\n')
      rl.close()
      resolve(line)
    })
  })
}

function validName(name: string): boolean {
  return /^[a-z_][a-z0-9_.-]*\$?$/i.test(name) && name.length <= 64
}

const [cmd, ...rest] = process.argv.slice(2)
const db = openDb()

try {
  switch (cmd) {
    case 'list': {
      const rows = db.query('SELECT username, realname, disabled, lastLoginAt, lastLoginIp, createdAt FROM SdUser ORDER BY username').all()
      if (!rows.length) {
        console.log('no local accounts (SdUser is empty — PAM logins are the default path)')
        break
      }
      for (const r of rows) {
        const state = r.disabled ? 'disabled' : 'active'
        const last = r.lastLoginAt ? `last login ${r.lastLoginIp ?? '?'} @ ${r.lastLoginAt}` : 'never logged in'
        console.log(`  ${String(r.username).padEnd(16)} ${state.padEnd(9)} ${r.realname ?? ''}  (${last})`)
      }
      break
    }
    case 'add': {
      const username = rest[0]
      const realname = rest[1] === '--realname' ? rest[2] : null
      if (!username || !validName(username)) {
        console.error('usage: add <username> [--realname "Jane Doe"]')
        process.exit(2)
      }
      const exists = db.query('SELECT 1 FROM SdUser WHERE username = ?').get(username)
      if (exists) {
        console.error(`account '${username}' already exists (use passwd)`)
        process.exit(2)
      }
      const password = await promptPassword()
      if (!password || password.length < 4) {
        console.error('password too short (min 4 chars)')
        process.exit(2)
      }
      db.query('INSERT INTO SdUser (username, realname, hash, disabled, updatedAt) VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)')
        .run(username, realname, hashPassword(password))
      console.log(`added local account '${username}'`)
      break
    }
    case 'passwd': {
      const username = rest[0]
      if (!username) {
        console.error('usage: passwd <username>')
        process.exit(2)
      }
      const row = db.query('SELECT username FROM SdUser WHERE username = ?').get(username)
      if (!row) {
        console.error(`no local account '${username}'`)
        process.exit(2)
      }
      const password = await promptPassword()
      if (!password || password.length < 4) {
        console.error('password too short (min 4 chars)')
        process.exit(2)
      }
      db.query('UPDATE SdUser SET hash = ?, updatedAt = CURRENT_TIMESTAMP WHERE username = ?')
        .run(hashPassword(password), username)
      console.log(`password updated for '${username}'`)
      break
    }
    case 'disable':
    case 'enable': {
      const username = rest[0]
      if (!username) {
        console.error(`usage: ${cmd} <username>`)
        process.exit(2)
      }
      const res = db.query('UPDATE SdUser SET disabled = ?, updatedAt = CURRENT_TIMESTAMP WHERE username = ?')
        .run(cmd === 'disable' ? 1 : 0, username)
      if (!res.changes) {
        console.error(`no local account '${username}'`)
        process.exit(2)
      }
      console.log(`${cmd === 'disable' ? 'disabled' : 'enabled'} local account '${username}'`)
      break
    }
    case 'remove': {
      const username = rest[0]
      if (!username) {
        console.error('usage: remove <username>')
        process.exit(2)
      }
      const res = db.query('DELETE FROM SdUser WHERE username = ?').run(username)
      if (!res.changes) {
        console.error(`no local account '${username}'`)
        process.exit(2)
      }
      console.log(`removed local account '${username}'`)
      break
    }
    default:
      console.log(`SysDeck local account manager (SdUser)

  list                     show local console accounts
  add <name> [--realname] create an account (prompts for password)
  passwd <name>            rotate an account password
  disable <name>           block sign-ins
  enable <name>            re-allow sign-ins
  remove <name>            delete the account

DB: ${dbFile}
These accounts only matter for SYSDECK_AUTH_MODE=local / pam+local —
PAM (the host unix accounts) is the default login path, like Cockpit.`)
      process.exit(cmd ? 2 : 0)
  }
} finally {
  db.close()
}
