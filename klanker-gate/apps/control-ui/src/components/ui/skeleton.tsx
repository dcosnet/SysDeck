import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

/** Base shimmer bar; animation self-disables under reduced motion. */
export function Skeleton(
  { className, ...props }: HTMLAttributes<HTMLDivElement>,
) {
  return (
    <div
      className={cn("skeleton-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

/** Table placeholder: header row + N muted rows matching the column count. */
export function TableSkeleton(
  { cols, rows = 5 }: { cols: number; rows?: number },
) {
  return (
    <div className="w-full" aria-hidden="true">
      <div className="flex gap-3 border-b border-border pb-2">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      <div className="flex flex-col gap-3 pt-3">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex gap-3">
            {Array.from({ length: cols }).map((_, c) => (
              <Skeleton key={c} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Stat tile placeholder: small label bar + large number bar. */
export function TileSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-7 w-16" />
    </div>
  );
}

/** Generic two-line panel placeholder. */
export function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}
