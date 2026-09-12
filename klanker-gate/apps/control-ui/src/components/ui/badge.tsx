import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export type BadgeTone = "primary" | "ok" | "warn" | "err" | "info" | "muted";

/* Soft: semantic text over a 16% tint with a 32% tint border (DESIGN.md). */
const SOFT_CLASSES: Record<BadgeTone, string> = {
  primary: "text-primary bg-primary/16 border-primary/32",
  ok: "text-success bg-success/16 border-success/32",
  warn: "text-warning bg-warning/16 border-warning/32",
  err: "text-destructive bg-destructive/16 border-destructive/32",
  info: "text-info bg-info/16 border-info/32",
  muted: "text-muted-foreground bg-muted border-border",
};

const SOLID_CLASSES: Record<BadgeTone, string> = {
  primary: "bg-primary text-primary-foreground border-transparent",
  ok: "bg-success text-success-foreground border-transparent",
  warn: "bg-warning text-warning-foreground border-transparent",
  err: "bg-destructive text-destructive-foreground border-transparent",
  info: "bg-info text-info-foreground border-transparent",
  muted: "bg-muted text-muted-foreground border-transparent",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  solid?: boolean;
}

export function Badge(
  { className, tone = "muted", solid = false, ...props }: BadgeProps,
) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5",
        "text-xs font-medium whitespace-nowrap",
        solid ? SOLID_CLASSES[tone] : SOFT_CLASSES[tone],
        className,
      )}
      {...props}
    />
  );
}
