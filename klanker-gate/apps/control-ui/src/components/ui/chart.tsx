import { useId, useRef, useState } from "react";
import { cn } from "../../lib/utils";

export type ChartColor = "1" | "2" | "3" | "4" | "5";

export interface ChartSeries {
  name: string;
  color: ChartColor;
  values: number[];
}

export interface ChartProps {
  type: "line" | "bar";
  series: ChartSeries[];
  height?: number;
  ariaLabel: string;
  className?: string;
  /** Unit shown beside hovered values (e.g. "tokens", "ms"). */
  unit?: string;
}

// Literal classes so Tailwind v4 emits them (dynamic `text-chart-${n}` would
// be purged).
const SERIES_TEXT: Record<ChartColor, string> = {
  "1": "text-chart-1",
  "2": "text-chart-2",
  "3": "text-chart-3",
  "4": "text-chart-4",
  "5": "text-chart-5",
};

// viewBox geometry (stretched with preserveAspectRatio="none"; strokes stay
// crisp via vector-effect non-scaling-stroke).
const VB = 100;
const TOP = 4;
const BOTTOM = 96;
const USABLE = BOTTOM - TOP; // 92

// Gridline / axis-label fractions, top (max) to bottom (zero).
const AXIS_FRACTIONS = [1, 0.75, 0.5, 0.25, 0];

function niceMax(series: ChartSeries[]): number {
  let max = 0;
  for (const s of series) {
    for (const v of s.values) {
      if (v > max) {
        max = v;
      }
    }
  }
  return max <= 0 ? 1 : max;
}

function yFor(value: number, max: number): number {
  return BOTTOM - (value / max) * USABLE;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Compact axis / tooltip value: 1.2k, 3.4M, 12, 0.75. */
function formatValue(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${round1(v / 1e9)}B`;
  if (abs >= 1e6) return `${round1(v / 1e6)}M`;
  if (abs >= 1e3) return `${round1(v / 1e3)}k`;
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 100) / 100);
}

function round1(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

export function Chart(
  { type, series, height = 160, ariaLabel, className, unit }: ChartProps,
) {
  const clipId = useId();
  const plotRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const max = niceMax(series);
  const pointCount = series.reduce((n, s) => Math.max(n, s.values.length), 0);

  const gridlines = AXIS_FRACTIONS.map((f) => BOTTOM - f * USABLE);

  // Fraction (0..1) of the plot width for a given bucket index. Lines pin the
  // first/last bucket to the edges; bars center each bucket in its group.
  function xFraction(index: number): number {
    if (pointCount <= 1) {
      return 0.5;
    }
    return type === "line"
      ? index / (pointCount - 1)
      : (index + 0.5) / pointCount;
  }

  function onMove(event: React.PointerEvent<HTMLDivElement>) {
    const el = plotRef.current;
    if (!el || pointCount === 0) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const frac = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    setHover(pointCount <= 1 ? 0 : Math.round(frac * (pointCount - 1)));
  }

  const hovered = hover != null && hover < pointCount;
  const hoverX = hovered ? xFraction(hover as number) * 100 : 0;
  const tooltipAlign = hoverX > 78 ? "end" : hoverX < 22 ? "start" : "center";

  return (
    <div className={cn("flex", className)} style={{ height }}>
      {/* Y-axis value scale, aligned to the gridlines below. */}
      <div className="relative w-11 shrink-0" aria-hidden="true">
        {AXIS_FRACTIONS.map((f) => (
          <span
            key={f}
            className="absolute right-1.5 -translate-y-1/2 text-2xs tabular-nums text-muted-foreground"
            style={{ top: `${BOTTOM - f * USABLE}%` }}
          >
            {formatValue(f * max)}
          </span>
        ))}
      </div>

      <div
        ref={plotRef}
        className="relative flex-1"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <svg
          role="img"
          aria-label={ariaLabel}
          viewBox={`0 0 ${VB} ${VB}`}
          preserveAspectRatio="none"
          className="h-full w-full"
        >
          {/* horizontal gridlines + baseline */}
          <g className="text-muted-foreground" stroke="currentColor">
            {gridlines.map((y, i) => (
              <line
                key={`g${i}`}
                x1={0}
                y1={y}
                x2={VB}
                y2={y}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                opacity={i === gridlines.length - 1 ? 0.5 : 0.18}
              />
            ))}
          </g>

          {type === "line"
            ? (
              series.map((s) => {
                const n = s.values.length;
                const points = s.values
                  .map((v, i) => {
                    const x = n <= 1 ? VB / 2 : (i / (n - 1)) * VB;
                    return `${x.toFixed(2)},${yFor(v, max).toFixed(2)}`;
                  })
                  .join(" ");
                return (
                  <polyline
                    key={s.name}
                    className={SERIES_TEXT[s.color]}
                    points={points}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })
            )
            : (
              <g clipPath={`url(#${clipId})`}>
                {Array.from({ length: pointCount }).map((_, i) => {
                  const groupW = VB / Math.max(1, pointCount);
                  const pad = groupW * 0.16;
                  const inner = groupW - pad * 2;
                  const barW = inner / Math.max(1, series.length);
                  return series.map((s, j) => {
                    const v = s.values[i] ?? 0;
                    const h = (v / max) * USABLE;
                    const x = i * groupW + pad + j * barW;
                    return (
                      <rect
                        key={`${s.name}-${i}`}
                        className={SERIES_TEXT[s.color]}
                        x={x}
                        y={BOTTOM - h}
                        width={barW * 0.82}
                        height={h}
                        rx={0.6}
                        fill="currentColor"
                      />
                    );
                  });
                })}
              </g>
            )}

          <clipPath id={clipId}>
            <rect x={0} y={0} width={VB} height={BOTTOM} />
          </clipPath>
        </svg>

        {/* Hover guideline, per-series markers, and value tooltip. */}
        {hovered && (
          <div
            className="pointer-events-none absolute inset-0"
            aria-hidden="true"
          >
            <div
              className="absolute w-px bg-muted-foreground/40"
              style={{
                left: `${hoverX}%`,
                top: `${TOP}%`,
                height: `${USABLE}%`,
              }}
            />
            {series.map((s) => {
              const value = s.values[hover as number] ?? 0;
              return (
                <span
                  key={s.name}
                  className={cn(
                    "absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card",
                    SERIES_DOT[s.color],
                  )}
                  style={{ left: `${hoverX}%`, top: `${yFor(value, max)}%` }}
                />
              );
            })}
            <div
              className={cn(
                "absolute top-1 min-w-max rounded-md border border-border",
                "bg-popover/95 px-2 py-1.5 text-2xs shadow-md backdrop-blur-sm",
                tooltipAlign === "end" && "-translate-x-full",
                tooltipAlign === "center" && "-translate-x-1/2",
              )}
              style={{ left: `${hoverX}%` }}
            >
              <ul className="flex flex-col gap-0.5">
                {series.map((s) => (
                  <li key={s.name} className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        SERIES_DOT[s.color],
                      )}
                    />
                    <span className="text-muted-foreground">{s.name}</span>
                    <span className="ml-auto pl-3 font-medium tabular-nums text-foreground">
                      {formatValue(s.values[hover as number] ?? 0)}
                      {unit ? ` ${unit}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export interface LegendItem {
  name: string;
  color: ChartColor;
}

/** Series legend keyed to the chart color family. */
export function ChartLegend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((item) => (
        <li
          key={item.name}
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <span
            aria-hidden="true"
            className={cn("size-2 rounded-full", SERIES_DOT[item.color])}
          />
          {item.name}
        </li>
      ))}
    </ul>
  );
}

const SERIES_DOT: Record<ChartColor, string> = {
  "1": "bg-chart-1",
  "2": "bg-chart-2",
  "3": "bg-chart-3",
  "4": "bg-chart-4",
  "5": "bg-chart-5",
};
