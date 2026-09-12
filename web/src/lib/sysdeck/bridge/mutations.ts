// SysDeck bridge mutation registry — the command-level authorization map.
//
// Contract: reads are open to every signed-in unix account (cockpit lets
// any user look); the commands listed here change operator state or the
// host, and the bridge dispatcher requires an admin session (wheel/sudo/
// adm membership or uid 0) for them unless SYSDECK_MUTATIONS=any opts the
// console back to the single-operator posture.
//
// This map is the single source of truth — a new mutating command that
// forgets to register here is still gated by the env-var escape hatch
// ONLY when that hatch is explicitly set; the default posture stays
// admin-gated by omission (fail-closed for unlisted modules).

const s = (...names: string[]): ReadonlySet<string> => new Set(names)

export const MUTATIONS: Record<string, ReadonlySet<string>> = {
  auth: s('unlock', 'lock'),
  benchmark: s('run'),
  builder: s('create', 'copy', 'delete', 'importHostPackages', 'build', 'cancel', 'deleteArtifact', 'clearArtifacts'),
  containers: s('start', 'stop', 'freeze', 'delete', 'exec'),
  db: s('start', 'stop', 'backup'),
  firewall: s('create', 'apply', 'delete', 'addRule', 'deleteRule'),
  firmware: s('apply'),
  fleet: s('addNode', 'removeNode'),
  hwalert: s('acknowledge', 'dismiss', 'block', 'unblock', 'whitelist', 'unwhitelist', 'setPolicy', 'scan'),
  integrity: s('baseline', 'check', 'resolve'),
  jellyfin: s('play', 'pause', 'start', 'stop', 'restart'),
  mesh: s('scale'),
  mining: s('start', 'stop', 'poolConfig'),
  modules: s('install', 'uninstall'),
  netsec: s('ban', 'unban'),
  packages: s('install', 'remove', 'update', 'updateAll'),
  photos: s('index', 'scan'),
  policy: s('sync', 'create', 'update', 'delete', 'toggle'),
  remotefs: s('mount', 'unmount', 'heal'),
  services: s('setPort', 'resetPort', 'restartService'),
  shell: s('setToggle', 'resetToggles'),
  themes: s('setActive'),
  vault: s('registerKeyfile', 'lock', 'unlock', 'backup'),
}

export function isMutation(module: string, command: string): boolean {
  return MUTATIONS[module]?.has(command) ?? false
}
