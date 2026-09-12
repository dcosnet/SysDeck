import { useEffect, useId, useRef, useState } from "react";
import { Columns3 } from "lucide-react";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import type { ColumnMeta } from "./logs-model";

export interface ColumnPickerProps {
  columns: ColumnMeta[];
  visible: Set<string>;
  onToggle: (key: string, checked: boolean) => void;
}

/**
 * Show/hide column control (spec: Logs top bar). A disclosure button opens a
 * checkbox panel; Escape and click-outside close it. The last visible column
 * cannot be hidden so the table never collapses to nothing.
 */
export function ColumnPicker(
  { columns, visible, onToggle }: ColumnPickerProps,
) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const shownCount = columns.reduce(
    (n, column) => (visible.has(column.key) ? n + 1 : n),
    0,
  );

  return (
    <div ref={rootRef} className="relative inline-block">
      <Button
        variant="outline"
        size="icon"
        aria-label="Choose columns"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Columns3 aria-hidden="true" />
      </Button>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label="Columns"
          className="absolute right-0 z-(--z-overlay) mt-1 min-w-44 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md"
        >
          <p className="px-1 pb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Columns
          </p>
          <ul className="flex flex-col gap-0.5">
            {columns.map((column) => {
              const checked = visible.has(column.key);
              const lockLast = checked && shownCount === 1;
              return (
                <li key={column.key}>
                  <label className="hit-target flex cursor-pointer items-center gap-2 rounded-sm px-1 text-sm">
                    <Checkbox
                      checked={checked}
                      disabled={lockLast}
                      aria-label={column.label}
                      onChange={(event) =>
                        onToggle(column.key, event.target.checked)}
                    />
                    <span className="text-foreground">{column.label}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
