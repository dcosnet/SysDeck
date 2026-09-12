// SysDeck bridge registry — the web edition's equivalent of the cockpit
// edition's per-file COMMANDS dicts. Each module file exports `commands`.
import type { BridgeModule } from './shared'

import * as overview from './overview'
import * as glances from './glances'
import * as sensors from './sensors'
import * as fleet from './fleet'
import * as services from './services'
import * as packages from './packages'
import * as benchmark from './benchmark'
import * as firmware from './firmware'
import * as themes from './themes'
import * as firewall from './firewall'
import * as netsec from './netsec'
import * as integrity from './integrity'
import * as vault from './vault'
import * as auth from './auth'
import * as hwalert from './hwalert'
import * as policy from './policy'
import * as containers from './containers'
import * as mesh from './mesh'
import * as kata from './kata'
import * as remotefs from './remotefs'
import * as db from './db'
import * as fester from './fester'
import * as builder from './builder'
import * as mining from './mining'
import * as jellyfin from './jellyfin'
import * as photos from './photos'
import * as monitoring from './monitoring'
import * as modules from './modules'
import * as klanker from './klanker'
import * as cockpitmodules from './cockpitmodules'
import * as shell from './shell'

// No `as unknown as` erasure: each module's `commands` must satisfy the
// BridgeCommands contract structurally — the compiler keeps every module
// honestly typed, and a violating signature fails here instead of hiding.
export const BRIDGE_MODULES: Record<string, BridgeModule> = {
  overview: { commands: overview.commands },
  glances: { commands: glances.commands },
  sensors: { commands: sensors.commands },
  fleet: { commands: fleet.commands },
  services: { commands: services.commands },
  packages: { commands: packages.commands },
  benchmark: { commands: benchmark.commands },
  firmware: { commands: firmware.commands },
  themes: { commands: themes.commands },
  firewall: { commands: firewall.commands },
  netsec: { commands: netsec.commands },
  integrity: { commands: integrity.commands },
  vault: { commands: vault.commands },
  auth: { commands: auth.commands },
  hwalert: { commands: hwalert.commands },
  policy: { commands: policy.commands },
  containers: { commands: containers.commands },
  mesh: { commands: mesh.commands },
  kata: { commands: kata.commands },
  remotefs: { commands: remotefs.commands },
  db: { commands: db.commands },
  fester: { commands: fester.commands },
  builder: { commands: builder.commands },
  mining: { commands: mining.commands },
  jellyfin: { commands: jellyfin.commands },
  photos: { commands: photos.commands },
  monitoring: { commands: monitoring.commands },
  modules: { commands: modules.commands },
  klanker: { commands: klanker.commands },
  cockpitmodules: { commands: cockpitmodules.commands },
  shell: { commands: shell.commands },
}
