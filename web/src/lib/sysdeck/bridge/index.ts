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

export const BRIDGE_MODULES: Record<string, BridgeModule> = {
  overview: overview as unknown as BridgeModule,
  glances: glances as unknown as BridgeModule,
  sensors: sensors as unknown as BridgeModule,
  fleet: fleet as unknown as BridgeModule,
  services: services as unknown as BridgeModule,
  packages: packages as unknown as BridgeModule,
  benchmark: benchmark as unknown as BridgeModule,
  firmware: firmware as unknown as BridgeModule,
  themes: themes as unknown as BridgeModule,
  firewall: firewall as unknown as BridgeModule,
  netsec: netsec as unknown as BridgeModule,
  integrity: integrity as unknown as BridgeModule,
  vault: vault as unknown as BridgeModule,
  auth: auth as unknown as BridgeModule,
  hwalert: hwalert as unknown as BridgeModule,
  policy: policy as unknown as BridgeModule,
  containers: containers as unknown as BridgeModule,
  mesh: mesh as unknown as BridgeModule,
  kata: kata as unknown as BridgeModule,
  remotefs: remotefs as unknown as BridgeModule,
  db: db as unknown as BridgeModule,
  fester: fester as unknown as BridgeModule,
  builder: builder as unknown as BridgeModule,
  mining: mining as unknown as BridgeModule,
  jellyfin: jellyfin as unknown as BridgeModule,
  photos: photos as unknown as BridgeModule,
  monitoring: monitoring as unknown as BridgeModule,
  modules: modules as unknown as BridgeModule,
  klanker: klanker as unknown as BridgeModule,
  cockpitmodules: cockpitmodules as unknown as BridgeModule,
  shell: shell as unknown as BridgeModule,
}
