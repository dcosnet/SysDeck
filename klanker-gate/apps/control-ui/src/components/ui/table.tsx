import type {
  HTMLAttributes,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";
import { cn } from "../../lib/utils";

/**
 * Horizontal scroll wrapper for dense tables (spec section 5): keeps data
 * density instead of card-reflow, stays keyboard-scrollable.
 */
export function ScrollContainer(
  { className, label, minWidth, children, ...props }:
    & HTMLAttributes<HTMLDivElement>
    & { label: string; minWidth?: string },
) {
  return (
    <div
      role="group"
      aria-label={label}
      tabIndex={0}
      className={cn(
        "w-full overflow-x-auto rounded-lg",
        "focus-visible:outline focus-visible:outline-(--ring-w)",
        className,
      )}
      {...props}
    >
      <div style={minWidth ? { minWidth } : undefined}>{children}</div>
    </div>
  );
}

export function Table(
  { className, ...props }: TableHTMLAttributes<HTMLTableElement>,
) {
  return (
    <table
      className={cn("w-full border-collapse text-sm", className)}
      {...props}
    />
  );
}

export function TableHeader(
  { className, ...props }: HTMLAttributes<HTMLTableSectionElement>,
) {
  return <thead className={cn(className)} {...props} />;
}

export function TableBody(
  { className, ...props }: HTMLAttributes<HTMLTableSectionElement>,
) {
  return <tbody className={cn(className)} {...props} />;
}

export function TableRow(
  { className, ...props }: HTMLAttributes<HTMLTableRowElement>,
) {
  return (
    <tr
      className={cn(
        "border-b border-border last:border-0 hover:bg-muted/40",
        className,
      )}
      {...props}
    />
  );
}

export function TableHead(
  { className, ...props }: ThHTMLAttributes<HTMLTableCellElement>,
) {
  return (
    <th
      scope="col"
      className={cn(
        "h-9 px-3 text-left align-middle text-xs font-medium",
        "uppercase tracking-wide text-muted-foreground whitespace-nowrap",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell(
  { className, ...props }: TdHTMLAttributes<HTMLTableCellElement>,
) {
  return (
    <td
      className={cn("px-3 py-2 align-middle text-foreground", className)}
      {...props}
    />
  );
}

/** Visually hidden caption for screen readers (spec section 4). */
export function TableCaption({ children }: { children: string }) {
  return <caption className="sr-only-focusable">{children}</caption>;
}
