import { type KeyboardEvent as ReactKeyboardEvent, useRef } from "react";
import { cn } from "../../lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedSelectProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible group name (e.g. "Beta header override"). */
  label: string;
  size?: "sm" | "default";
  disabled?: boolean;
  className?: string;
}

/**
 * Inline 2-3 option control (spec: beta-headers "Default / Override"). A radio
 * group on a muted track; the selected segment reads as a raised card. Arrow
 * keys move and select with roving focus.
 */
export function SegmentedSelect<T extends string>(
  { options, value, onChange, label, size = "default", disabled, className }:
    SegmentedSelectProps<T>,
) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  function move(delta: number) {
    const next = (activeIndex + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5",
        disabled && "opacity-50",
        className,
      )}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={onKeyDown}
            className={cn(
              "hit-target rounded-sm font-medium whitespace-nowrap",
              "transition-colors duration-(--motion-fast)",
              "disabled:cursor-not-allowed",
              size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm",
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
