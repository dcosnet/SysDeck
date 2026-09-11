'use client'

// SysDeck web bridge client — the JS-side twin of the cockpit edition's
// shared/bridge.js. One POST /api/bridge call per bridge invocation.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import type { BridgeResponse } from './types'

export async function bridgeCall<T = unknown>(
  module: string,
  command: string,
  args?: Record<string, unknown>,
): Promise<BridgeResponse<T>> {
  try {
    const res = await fetch('/api/bridge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ module, command, args: args ?? {} }),
    })
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, module, command }
    }
    return (await res.json()) as BridgeResponse<T>
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), module, command }
  }
}

/** Invoke a bridge command and unwrap data; throws on bridge errors. */
export async function bridgeData<T = unknown>(
  module: string,
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const res = await bridgeCall<T>(module, command, args)
  if (!res.ok || res.data === undefined) {
    throw new Error(res.error ?? `${module}.${command} failed`)
  }
  return res.data
}

export interface BridgeQueryOptions {
  refetchInterval?: number
  enabled?: boolean
  staleTime?: number
}

/** TanStack Query wrapper over a bridge command. */
export function useBridgeQuery<T = unknown>(
  module: string,
  command: string,
  args?: Record<string, unknown>,
  options: BridgeQueryOptions = {},
) {
  return useQuery<BridgeResponse<T>>({
    queryKey: ['bridge', module, command, args ?? {}],
    queryFn: () => bridgeCall<T>(module, command, args),
    refetchInterval: options.refetchInterval,
    enabled: options.enabled,
    staleTime: options.staleTime ?? 2000,
  })
}

/** Mutation-style helper: run a command then refresh that module's queries. */
export function useBridgeAction() {
  const qc = useQueryClient()
  return useCallback(
    async (module: string, command: string, args?: Record<string, unknown>) => {
      const res = await bridgeCall(module, command, args)
      await qc.invalidateQueries({ queryKey: ['bridge', module] })
      return res
    },
    [qc],
  )
}
