import { type ReactNode, useState } from "react";
import { BarChart3, LineChart as LineChartIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
  Chart,
  ChartLegend,
  type ChartSeries,
  type LegendItem,
} from "../ui/chart";
import { cn } from "../../lib/utils";

export interface ChartCardProps {
  title: string;
  /** Accessible name for the SVG chart. */
  ariaLabel: string;
  series?: ChartSeries[];
  legend?: LegendItem[];
  defaultType?: "line" | "bar";
  /** Right-aligned header controls (e.g. a model / provider Combobox). */
  filter?: ReactNode;
  /** Evenly spaced x-axis tick labels rendered under a time-series chart. */
  xTicks?: string[];
  /** Micro unit hint (e.g. "USD", "tokens", "ms"). */
  unit?: string;
  loading?: boolean;
  /** Force the empty state (feature off / dimension not recorded / filtered). */
  empty?: boolean;
  /** One-line muted note under the empty message explaining the gap. */
  emptyNote?: string;
  /** Hide the bar/line toggle (untracked cards have nothing to toggle). */
  hideToggle?: boolean;
  className?: string;
}

/**
 * Dashboard analytics card: title, optional filter + bar/line toggle, a legend
 * row, the dependency-free SVG Chart, and a graceful "No data available" state.
 * A card with no positive value collapses to the empty state automatically, so
 * an all-zero window never renders a misleading flat line.
 */
export function ChartCard(
  {
    title,
    ariaLabel,
    series = [],
    legend = [],
    defaultType = "line",
    filter,
    xTicks,
    unit,
    loading,
    empty,
    emptyNote,
    hideToggle,
    className,
  }: ChartCardProps,
) {
  const [type, setType] = useState<"line" | "bar">(defaultType);

  const hasData = series.some((s) => s.values.some((v) => v > 0));
  const showEmpty = Boolean(empty) || (!loading && !hasData);
  const showToggle = !hideToggle && !showEmpty;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <div className="flex items-center gap-2">
          {filter}
          {showToggle && (
            <div className="inline-flex items-center gap-1 rounded-md bg-muted p-0.5">
              <ToggleButton
                label="Bar chart"
                active={type === "bar"}
                onClick={() => setType("bar")}
              >
                <BarChart3 className="size-4" />
              </ToggleButton>
              <ToggleButton
                label="Line chart"
                active={type === "line"}
                onClick={() => setType("line")}
              >
                <LineChartIcon className="size-4" />
              </ToggleButton>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {showEmpty
          ? (
            <div className="flex h-44 flex-col items-center justify-center gap-1 text-center">
              <p className="text-sm font-medium text-muted-foreground">
                No data available
              </p>
              {emptyNote && (
                <p className="max-w-xs text-xs text-muted-foreground/80">
                  {emptyNote}
                </p>
              )}
            </div>
          )
          : loading
          ? <div className="skeleton-pulse h-44 rounded-md bg-muted" />
          : (
            <div className="flex flex-col gap-3">
              {(legend.length > 0 || unit) && (
                <div className="flex items-center justify-between gap-3">
                  <ChartLegend items={legend} />
                  {unit && (
                    <span className="shrink-0 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                      {unit}
                    </span>
                  )}
                </div>
              )}
              <Chart
                type={type}
                series={series}
                ariaLabel={ariaLabel}
                unit={unit}
                height={168}
              />
              {xTicks && xTicks.length > 0 && (
                <div className="flex items-center justify-between px-0.5 text-2xs text-muted-foreground">
                  {xTicks.map((tick, i) => (
                    <span key={`${tick}-${i}`} className="font-mono">
                      {tick}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
      </CardContent>
    </Card>
  );
}

function ToggleButton(
  { label, active, onClick, children }: {
    label: string;
    active: boolean;
    onClick: () => void;
    children: ReactNode;
  },
) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "grid size-7 place-items-center rounded-sm",
        "transition-colors duration-(--motion-fast)",
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
