import type { ReactNode } from "react";
import { forwardRef } from "react";
import { cn } from "../../lib/utils";

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
}

/**
 * Shared screen header: h2 title (focus target on nav, spec section 4) +
 * optional subtitle + right-aligned action cluster.
 */
export const PageHeader = forwardRef<HTMLHeadingElement, PageHeaderProps>(
  function PageHeader({ title, subtitle, actions, className }, ref) {
    return (
      <div
        className={cn(
          "mb-5 flex flex-wrap items-start justify-between gap-3",
          className,
        )}
      >
        <div className="min-w-0">
          <h2
            ref={ref}
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight text-foreground outline-none"
          >
            {title}
          </h2>
          {subtitle && (
            <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </div>
    );
  },
);
