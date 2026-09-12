import { type ReactNode, useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";

export interface CollapsibleProps {
  /** Header label; renders inside the disclosure toggle button. */
  title: ReactNode;
  children: ReactNode;
  /** Uncontrolled initial state (ignored when `open` is provided). */
  defaultOpen?: boolean;
  /** Controlled open state; pair with onOpenChange. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Optional trailing slot in the header (count badge, action, etc). */
  aside?: ReactNode;
  className?: string;
  headerClassName?: string;
  contentClassName?: string;
  disabled?: boolean;
}

/**
 * Disclosure primitive (spec: FacetRail groups, VFS preview): a labelled
 * toggle button controlling a region. Works controlled or uncontrolled. The
 * chevron rotation is the only motion and collapses under reduced motion.
 */
export function Collapsible(
  {
    title,
    children,
    defaultOpen = false,
    open,
    onOpenChange,
    aside,
    className,
    headerClassName,
    contentClassName,
    disabled = false,
  }: CollapsibleProps,
) {
  const regionId = useId();
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;

  function toggle() {
    const next = !isOpen;
    if (!isControlled) {
      setInternalOpen(next);
    }
    onOpenChange?.(next);
  }

  return (
    <div className={cn("border-b border-border last:border-0", className)}>
      <h3 className="m-0">
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={regionId}
          disabled={disabled}
          onClick={toggle}
          className={cn(
            "hit-target flex w-full items-center gap-2 py-2 text-left",
            "text-sm font-medium text-foreground",
            "transition-colors duration-(--motion-fast)",
            "hover:text-foreground disabled:opacity-50",
            headerClassName,
          )}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-muted-foreground",
              "transition-transform duration-(--motion-default)",
              isOpen && "rotate-90",
            )}
          />
          <span className="flex-1 min-w-0">{title}</span>
          {aside && <span className="shrink-0">{aside}</span>}
        </button>
      </h3>
      <div id={regionId} hidden={!isOpen}>
        {isOpen && (
          <div className={cn("pb-3", contentClassName)}>{children}</div>
        )}
      </div>
    </div>
  );
}
