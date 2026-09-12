import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

export interface ComboboxOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface ComboboxProps {
  options: ComboboxOption[];
  value: string | null;
  onChange: (value: string) => void;
  /** Accessible name for the combobox. */
  label: string;
  placeholder?: string;
  emptyText?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Searchable single-select (spec: customer / team / model filters). Implements
 * the editable-combobox ARIA pattern: type-ahead filtering, Arrow/Home/End to
 * move the active option, Enter to commit, Escape and click-outside to close.
 * With no query it lists every option, so it degrades to a plain picker.
 */
export function Combobox(
  {
    options,
    value,
    onChange,
    label,
    placeholder = "Select...",
    emptyText = "No matches.",
    id,
    disabled,
    className,
  }: ComboboxProps,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const listboxId = `${inputId}-listbox`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = options.find((option) => option.value === value) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return options;
    }
    return options.filter((option) => option.label.toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => {
    if (activeIndex >= filtered.length) {
      setActiveIndex(0);
    }
  }, [filtered.length, activeIndex]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [open]);

  function commit(option: ComboboxOption | undefined) {
    if (!option || option.disabled) {
      return;
    }
    onChange(option.value);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) {
          setOpen(true);
        } else {
          setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case "Home":
        if (open) {
          event.preventDefault();
          setActiveIndex(0);
        }
        break;
      case "End":
        if (open) {
          event.preventDefault();
          setActiveIndex(filtered.length - 1);
        }
        break;
      case "Enter":
        if (open) {
          event.preventDefault();
          commit(filtered[activeIndex]);
        }
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          setOpen(false);
          setQuery("");
        }
        break;
    }
  }

  const activeId = open && filtered[activeIndex]
    ? `${listboxId}-opt-${activeIndex}`
    : undefined;

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <input
        id={inputId}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        disabled={disabled}
        value={open ? query : selected?.label ?? ""}
        placeholder={placeholder}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className={cn(
          "h-(--control-h) w-full rounded-md border border-input bg-card",
          "pl-3 pr-8 text-base text-foreground shadow-sm",
          "placeholder:text-muted-foreground",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      />
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      {open && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={label}
          className={cn(
            "absolute z-(--z-overlay) mt-1 max-h-64 w-full overflow-y-auto",
            "rounded-md border border-border bg-popover p-1 shadow-md",
          )}
        >
          {filtered.length === 0
            ? (
              <li className="px-2 py-1.5 text-sm text-muted-foreground">
                {emptyText}
              </li>
            )
            : filtered.map((option, index) => {
              const isSelected = option.value === value;
              const isActive = index === activeIndex;
              return (
                <li
                  key={option.value}
                  id={`${listboxId}-opt-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={option.disabled || undefined}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => commit(option)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-sm px-2",
                    "py-1.5 text-sm text-popover-foreground",
                    isActive && "bg-accent",
                    option.disabled && "pointer-events-none opacity-50",
                  )}
                >
                  <Check
                    aria-hidden="true"
                    className={cn(
                      "size-4 shrink-0",
                      isSelected ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="flex-1 min-w-0 truncate">
                    {option.label}
                  </span>
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
}
