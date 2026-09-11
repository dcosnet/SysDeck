'use client'

// Panel import map — one lazy entry per SysDeck module.
// UI workstreams rewrite individual panel files; this map never changes.

import { lazy } from 'react'
import type { ComponentType } from 'react'

export const PANEL_MAP: Record<string, ComponentType> = {
  overview: lazy(() => import('./panels/overviewPanel')),
  glances: lazy(() => import('./panels/glancesPanel')),
  sensors: lazy(() => import('./panels/sensorsPanel')),
  fleet: lazy(() => import('./panels/fleetPanel')),
  services: lazy(() => import('./panels/servicesPanel')),
  packages: lazy(() => import('./panels/packagesPanel')),
  benchmark: lazy(() => import('./panels/benchmarkPanel')),
  firmware: lazy(() => import('./panels/firmwarePanel')),
  themes: lazy(() => import('./panels/themesPanel')),
  firewall: lazy(() => import('./panels/firewallPanel')),
  netsec: lazy(() => import('./panels/netsecPanel')),
  integrity: lazy(() => import('./panels/integrityPanel')),
  vault: lazy(() => import('./panels/vaultPanel')),
  auth: lazy(() => import('./panels/authPanel')),
  hwalert: lazy(() => import('./panels/hwalertPanel')),
  policy: lazy(() => import('./panels/policyPanel')),
  containers: lazy(() => import('./panels/containersPanel')),
  mesh: lazy(() => import('./panels/meshPanel')),
  kata: lazy(() => import('./panels/kataPanel')),
  remotefs: lazy(() => import('./panels/remotefsPanel')),
  db: lazy(() => import('./panels/dbPanel')),
  fester: lazy(() => import('./panels/festerPanel')),
  builder: lazy(() => import('./panels/builderPanel')),
  mining: lazy(() => import('./panels/miningPanel')),
  jellyfin: lazy(() => import('./panels/jellyfinPanel')),
  photos: lazy(() => import('./panels/photosPanel')),
  monitoring: lazy(() => import('./panels/monitoringPanel')),
  modules: lazy(() => import('./panels/modulesPanel')),
}
