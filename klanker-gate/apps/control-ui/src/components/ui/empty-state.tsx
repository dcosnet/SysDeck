import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  body: string;
  /** Optional call-to-action slot (never a pinned button name, per G6). */
  action?: ReactNode;
  /** Info variant for feature-off notices (E-OFF): no error styling. */
  tone?: "default" | "info";
  className?: string;
}

export function EmptyState(
  { icon: Icon, title, body, action, tone = "default", className }:
    EmptyStateProps,
) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border",
        "border-dashed border-border px-6 py-10 text-center",
        className,
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-6",
          tone === "info" ? "text-info" : "text-muted-foreground",
        )}
      />
      <p className="text-base font-medium text-foreground">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
