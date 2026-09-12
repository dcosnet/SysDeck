import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Clock } from "lucide-react";
import { cn } from "../../lib/utils";

export interface TimeRangeOption {
  value: string;
  label: string;
}

export const DEFAULT_TIME_RANGES: TimeRangeOption[] = [
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
];

export interface TimeRangePickerProps {
  value: string;
  onChange: (value: string) => void;
  options?: TimeRangeOption[];
  /** Accessible name for the trigger. */
  label?: string;
  className?: string;
}

/**
 * Range control (spec: Dashboard "Last hour"). A menu button whose trigger
 * shows the current label; the menu is a radio group with Arrow/Home/End
 * roving focus, Escape and click-outside to close.
 */
export function TimeRangePicker(
  {
    value,
    onChange,
    options = DEFAULT_TIME_RANGES,
    label = "Time range",
    className,
  }: TimeRangePickerProps,
) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const current = options[selectedIndex];

  useEffect(() => {
    if (open) {
      itemRefs.current[activeIndex]?.focus();
    }
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [open]);

  function openMenu() {
    setActiveIndex(selectedIndex);
    setOpen(true);
  }

  function close(restore: boolean) {
    setOpen(false);
    if (restore) {
      triggerRef.current?.focus();
    }
  }

  function select(index: number) {
    onChange(options[index].value);
    close(true);
  }

  function onMenuKeyDown(event: ReactKeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % options.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + options.length) % options.length);
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  }

  return (
    <div ref={rootRef} className={cn("relative inline-block", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`${label}: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter") {
            event.preventDefault();
            openMenu();
          }
        }}
        className={cn(
          "hit-target inline-flex h-(--control-h) items-center gap-2 rounded-md",
          "border border-input bg-card px-3 text-sm font-medium text-foreground",
          "shadow-sm transition-colors duration-(--motion-fast)",
          "hover:bg-accent [&_svg]:size-4",
        )}
      >
        <Clock aria-hidden="true" className="text-muted-foreground" />
        {current.label}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className={cn(
            "absolute right-0 z-(--z-overlay) mt-1 min-w-40 overflow-hidden",
            "rounded-md border border-border bg-popover p-1 shadow-md",
          )}
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              tabIndex={index === activeIndex ? 0 : -1}
              onClick={() => select(index)}
              onMouseEnter={() => setActiveIndex(index)}
              className={cn(
                "flex w-full items-center rounded-sm px-2 py-1.5 text-left",
                "text-sm text-popover-foreground outline-none",
                "transition-colors duration-(--motion-fast)",
                "focus-visible:bg-accent hover:bg-accent",
                option.value === value && "font-medium",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
