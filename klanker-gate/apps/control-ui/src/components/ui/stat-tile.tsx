import { Card } from "./card";
import { TileSkeleton } from "./skeleton";

export interface StatTileProps {
  label: string;
  value: string;
  caption?: string;
  loading?: boolean;
}

/** Overview metric tile (spec section 7): label, mono value, muted caption. */
export function StatTile({ label, value, caption, loading }: StatTileProps) {
  return (
    <Card className="px-4 py-3">
      {loading ? <TileSkeleton /> : (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          <span className="font-mono text-2xl font-semibold text-foreground">
            {value}
          </span>
          {caption && (
            <span className="text-xs text-muted-foreground">{caption}</span>
          )}
        </div>
      )}
    </Card>
  );
}
