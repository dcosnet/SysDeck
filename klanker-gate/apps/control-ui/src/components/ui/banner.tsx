import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export type BannerTone = "info" | "warn" | "error";

const TONE: Record<BannerTone, { cls: string; Icon: typeof Info }> = {
  info: { cls: "border-info/32 bg-info/12 text-foreground", Icon: Info },
  warn: {
    cls: "border-warning/32 bg-warning/12 text-foreground",
    Icon: TriangleAlert,
  },
  error: {
    cls: "border-destructive/32 bg-destructive/12 text-foreground",
    Icon: CircleAlert,
  },
};

export interface BannerProps {
  tone: BannerTone;
  children: ReactNode;
  /** error banners announce as role=alert; info/warn as role=status. */
  action?: ReactNode;
  className?: string;
}

export function Banner({ tone, children, action, className }: BannerProps) {
  const { cls, Icon } = TONE[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-3 rounded-lg border px-4 py-3 text-sm",
        cls,
        className,
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="flex-1">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** Inline form/card error that quotes the gateway's error.message (G10/E-4XX). */
export function ErrorBanner(
  { message, className }: { message: string; className?: string },
) {
  return (
    <Banner tone="error" className={className}>
      {message}
    </Banner>
  );
}
