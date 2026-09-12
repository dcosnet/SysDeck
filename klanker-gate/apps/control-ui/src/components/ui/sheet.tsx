import type { ReactNode } from "react";
import { useId } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { useModal } from "./use-modal";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
}

/** Right-side edit panel (spec 6 Sheet): full-screen under sm, 28rem above. */
export function Sheet(
  { open, onClose, title, description, children, footer }: SheetProps,
) {
  const titleId = useId();
  const descId = useId();
  const ref = useModal(open, onClose, true);
  if (!open) {
    return null;
  }
  return (
    <div className="fixed inset-0 z-(--z-modal) flex justify-end">
      <div
        className="absolute inset-0 bg-foreground/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          "relative z-10 flex h-full w-full max-w-[28rem] flex-col",
          "border-l border-border bg-card text-card-foreground shadow-lg",
          "outline-none",
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
            {description && (
              <p id={descId} className="mt-0.5 text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close panel"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {children}
        </div>
        {footer && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
