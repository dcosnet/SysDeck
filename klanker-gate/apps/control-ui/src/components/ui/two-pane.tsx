import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/utils";

/** Rail resize bounds (px). The dynamic max also reserves room for the pane. */
const DEFAULT_MIN = 224; // 14rem
const DEFAULT_MAX = 512; // 32rem
/** Keep the detail pane at least this wide when dragging the rail out. */
const MIN_DETAIL = 320;

/** Resolve a rem/px CSS length to px; falls back to the min on nonsense. */
function toPx(value: string): number {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return DEFAULT_MIN;
  if (value.trim().endsWith("rem")) {
    const root = parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    return n * (Number.isFinite(root) && root > 0 ? root : 16);
  }
  return n;
}

export interface TwoPaneProps {
  /** Left list rail content. */
  list: ReactNode;
  /** Right detail pane content. */
  detail: ReactNode;
  /** Initial rail width on md+ screens (CSS length). */
  listWidth?: string;
  /** Resize bounds in px. */
  minListWidth?: number;
  maxListWidth?: number;
  listLabel?: string;
  detailLabel?: string;
  /**
   * Mobile collapse: below md only one pane shows at a time. When true the
   * detail pane is visible (a row is selected); when false the list shows.
   */
  detailActiveOnMobile?: boolean;
  className?: string;
  /** When set, the operator's chosen rail width persists under this key. */
  storageKey?: string;
}

/**
 * Master / detail layout (spec: provider config, VFS). Side-by-side on md+
 * with a draggable rail and a flexible detail pane; below md it collapses to a
 * single visible pane driven by `detailActiveOnMobile`. The rail keeps
 * `overflow-hidden` so a too-wide row still truncates instead of overlapping
 * the pane (regression lock: `two-pane.overflow.test.tsx`); resizing lets the
 * operator widen it to read the full content.
 */
export function TwoPane(
  {
    list,
    detail,
    listWidth = "18rem",
    minListWidth = DEFAULT_MIN,
    maxListWidth = DEFAULT_MAX,
    listLabel = "List",
    detailLabel = "Detail",
    detailActiveOnMobile = false,
    className,
    storageKey,
  }: TwoPaneProps,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const draggingRef = useRef(false);
  const widthRef = useRef(0);
  const [dragging, setDragging] = useState(false);

  const [width, setWidth] = useState<number>(() => {
    if (storageKey && typeof localStorage !== "undefined") {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved > 0) {
        return Math.max(minListWidth, Math.min(maxListWidth, saved));
      }
    }
    return Math.max(minListWidth, Math.min(maxListWidth, toPx(listWidth)));
  });
  widthRef.current = width;

  /** Upper bound at interaction time: honour the prop cap, but also leave the
   * detail pane usable. A zero container (jsdom / pre-layout) uses the cap. */
  function maxNow(): number {
    const w = containerRef.current?.getBoundingClientRect().width ?? 0;
    if (w <= 0) return maxListWidth;
    return Math.max(minListWidth, Math.min(maxListWidth, w - MIN_DETAIL));
  }

  function commit(px: number, persist: boolean) {
    const next = Math.max(minListWidth, Math.min(maxNow(), px));
    widthRef.current = next;
    setWidth(next);
    if (persist && storageKey && typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(storageKey, String(Math.round(next)));
      } catch {
        /* private mode / disabled storage: width stays session-only */
      }
    }
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    draggingRef.current = true;
    setDragging(true);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const left = asideRef.current?.getBoundingClientRect().left ?? 0;
    commit(event.clientX - left, false);
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    commit(widthRef.current, true);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 32 : 16;
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        commit(widthRef.current - step, true);
        break;
      case "ArrowRight":
        event.preventDefault();
        commit(widthRef.current + step, true);
        break;
      case "Home":
        event.preventDefault();
        commit(minListWidth, true);
        break;
      case "End":
        event.preventDefault();
        commit(maxNow(), true);
        break;
    }
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex min-h-0 flex-col md:flex-row md:items-stretch",
        className,
      )}
    >
      <aside
        ref={asideRef}
        aria-label={listLabel}
        style={{ ["--rail-w" as string]: `${width}px` }}
        className={cn(
          "min-w-0 shrink-0 overflow-hidden md:w-(--rail-w)",
          detailActiveOnMobile ? "hidden md:block" : "block",
        )}
      >
        {list}
      </aside>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${listLabel.toLowerCase()}`}
        aria-valuemin={minListWidth}
        aria-valuemax={maxListWidth}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        className={cn(
          "group relative hidden w-2 shrink-0 cursor-col-resize touch-none",
          "select-none md:flex md:items-stretch md:justify-center",
          "focus-visible:outline-none",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none w-px self-stretch bg-border transition-colors",
            "group-hover:bg-ring group-focus-visible:bg-ring",
            dragging && "bg-ring",
          )}
        />
      </div>
      <section
        aria-label={detailLabel}
        className={cn(
          "min-w-0 flex-1",
          detailActiveOnMobile ? "block" : "hidden md:block",
        )}
      >
        {detail}
      </section>
    </div>
  );
}
