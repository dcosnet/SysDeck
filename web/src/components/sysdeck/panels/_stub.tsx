'use client'

// Placeholder shown while a module panel is under construction.
import { PanelHeader } from '@/components/sysdeck/ui'
import { MODULE_MAP } from '@/lib/sysdeck/registry'
import { Skeleton } from '@/components/ui/skeleton'

export default function ModuleUnderConstruction({ id }: { id: string }) {
  const meta = MODULE_MAP[id]
  return (
    <div>
      <PanelHeader
        title={meta?.name ?? id}
        subtitle={meta?.description ?? 'SysDeck module'}
        source={meta?.status}
      />
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
        <p className="text-center text-xs text-muted-foreground">
          panel assembly in progress — bridge module {id} online
        </p>
      </div>
    </div>
  )
}
