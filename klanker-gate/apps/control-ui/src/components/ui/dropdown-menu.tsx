import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { type LucideIcon, MoreVertical } from "lucide-react";
import { cn } from "../../lib/utils";

export interface DropdownMenuItem {
  /** Stable id used as the React key. */
  id: string;
  label: string;
  onSelect: () => void;
  icon?: LucideIcon;
  destructive?: boolean;
  disabled?: boolean;
}

export interface DropdownMenuProps {
  items: DropdownMenuItem[];
  /** Accessible name for the trigger button (e.g. "Row actions"). */
  label: string;
  /** Trigger content; defaults to a kebab (vertical dots) icon. */
  trigger?: ReactNode;
  /** Horizontal alignment of the menu relative to the trigger. */
  align?: "start" | "end";
  className?: string;
}

interface MenuPosition {
  top: number;
  left?: number;
  right?: number;
}

/**
 * Accessible kebab / row menu (spec: replaces per-row action clusters). Roving
 * focus with Arrow/Home/End, Escape and click-outside close and restore focus
 * to the trigger, Enter/Space activate. The panel is PORTALLED to document.body
 * with fixed positioning derived from the trigger rect, so an ancestor with
 * `overflow` (e.g. a horizontally-scrollable table cell) can never clip it.
 */
export function DropdownMenu(
  { items, label, trigger, align = "end", className }: DropdownMenuProps,
) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<MenuPosition>({ top: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Anchor the fixed panel to the trigger. `end` alignment pins the panel's
  // right edge to the trigger's right edge (via `right`), so we never need the
  // panel width up front.
  const computePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setPosition(
      align === "end"
        ? { top: rect.bottom + 4, right: globalThis.innerWidth - rect.right }
        : { top: rect.bottom + 4, left: rect.left },
    );
  }, [align]);

  useLayoutEffect(() => {
    if (open) {
      computePosition();
    }
  }, [open, computePosition]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onReflow = () => computePosition();
    // Capture-phase scroll catches scrolling ancestors, not just the window.
    globalThis.addEventListener("scroll", onReflow, true);
    globalThis.addEventListener("resize", onReflow);
    return () => {
      globalThis.removeEventListener("scroll", onReflow, true);
      globalThis.removeEventListener("resize", onReflow);
    };
  }, [open, computePosition]);

  const enabledIndexes = items
    .map((item, index) => (item.disabled ? -1 : index))
    .filter((index) => index >= 0);

  function openMenu(focus: "first" | "last") {
    if (enabledIndexes.length === 0) {
      return;
    }
    const index = focus === "first"
      ? enabledIndexes[0]
      : enabledIndexes[enabledIndexes.length - 1];
    setActiveIndex(index);
    setOpen(true);
  }

  function close(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }

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
      const target = event.target as Node;
      // The panel is portalled outside rootRef, so treat it as inside too;
      // otherwise a mousedown on a menu item would close before its click fires.
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [open]);

  function step(delta: number) {
    const pos = enabledIndexes.indexOf(activeIndex);
    const nextPos = (pos + delta + enabledIndexes.length) %
      enabledIndexes.length;
    setActiveIndex(enabledIndexes[nextPos]);
  }

  function onMenuKeyDown(event: ReactKeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        step(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        step(-1);
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(enabledIndexes[0]);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(enabledIndexes[enabledIndexes.length - 1]);
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

  function activate(item: DropdownMenuItem) {
    if (item.disabled) {
      return;
    }
    close(true);
    item.onSelect();
  }

  return (
    <div ref={rootRef} className={cn("relative inline-block", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openMenu("first"))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter") {
            event.preventDefault();
            openMenu("first");
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            openMenu("last");
          }
        }}
        className={cn(
          "hit-target inline-flex size-(--control-h-sm) items-center",
          "justify-center rounded-md text-muted-foreground",
          "transition-colors duration-(--motion-fast)",
          "hover:bg-accent hover:text-foreground",
          "[&_svg]:size-4",
        )}
      >
        {trigger ?? <MoreVertical aria-hidden="true" />}
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          style={{
            position: "fixed",
            top: position.top,
            left: position.left,
            right: position.right,
          } as CSSProperties}
          className={cn(
            "z-(--z-overlay) min-w-44 overflow-hidden",
            "rounded-md border border-border bg-popover p-1 shadow-md",
            "text-popover-foreground",
          )}
        >
          {items.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                tabIndex={index === activeIndex ? 0 : -1}
                onClick={() => activate(item)}
                onMouseEnter={() => !item.disabled && setActiveIndex(index)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5",
                  "text-left text-sm outline-none",
                  "transition-colors duration-(--motion-fast)",
                  "focus-visible:bg-accent hover:bg-accent",
                  "disabled:pointer-events-none disabled:opacity-50",
                  "[&_svg]:size-4 [&_svg]:shrink-0",
                  item.destructive
                    ? "text-destructive focus-visible:text-destructive"
                    : "text-popover-foreground",
                )}
              >
                {Icon && <Icon aria-hidden="true" />}
                {item.label}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
