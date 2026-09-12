import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Card(
  { className, ...props }: HTMLAttributes<HTMLDivElement>,
) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card text-card-foreground shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader(
  { className, ...props }: HTMLAttributes<HTMLDivElement>,
) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 px-5 pt-4",
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle(
  { className, ...props }: HTMLAttributes<HTMLHeadingElement>,
) {
  return (
    <h3
      className={cn("text-lg font-semibold text-foreground", className)}
      {...props}
    />
  );
}

export function CardContent(
  { className, ...props }: HTMLAttributes<HTMLDivElement>,
) {
  return <div className={cn("px-5 py-4", className)} {...props} />;
}
