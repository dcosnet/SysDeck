import type { ReactNode } from "react";
import { useId } from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { useModal } from "./use-modal";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  /** max width token class, e.g. "max-w-lg"; token dialog uses wider. */
  className?: string;
}

/** Modal form dialog: focus-trapped, Escape/overlay-dismissible, aria-wired. */
export function Dialog(
  { open, onClose, title, description, children, footer, className }:
    DialogProps,
) {
  const titleId = useId();
  const descId = useId();
  const ref = useModal(open, onClose, true);
  if (!open) {
    return null;
  }
  return (
    <div className="fixed inset-0 z-(--z-modal) flex items-center justify-center p-4">
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
          "relative z-10 w-full max-w-md rounded-xl border border-border",
          "bg-popover text-popover-foreground shadow-lg outline-none",
          className,
        )}
      >
        <div className="flex flex-col gap-1 px-5 pt-5">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          {description && (
            <p id={descId} className="text-sm text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {children && <div className="px-5 py-4">{children}</div>}
        {footer && (
          <div className="flex flex-wrap justify-end gap-2 px-5 pb-5 pt-1">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
}

/**
 * AlertDialog confirmation (spec 6 ConfirmDialog): initial focus lands on
 * Cancel, overlay click does NOT dismiss, Escape cancels.
 */
export function ConfirmDialog(
  {
    open,
    onClose,
    onConfirm,
    title,
    body,
    confirmLabel,
    cancelLabel = "Cancel",
    destructive = true,
    pending = false,
  }: ConfirmDialogProps,
) {
  const titleId = useId();
  const descId = useId();
  const ref = useModal(open, onClose, true, "first");
  if (!open) {
    return null;
  }
  return (
    <div className="fixed inset-0 z-(--z-modal) flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/40" aria-hidden="true" />
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        className={cn(
          "relative z-10 w-full max-w-sm rounded-xl border border-border",
          "bg-popover text-popover-foreground shadow-lg outline-none",
        )}
      >
        <div className="flex flex-col gap-2 px-5 pt-5">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          <div id={descId} className="text-sm text-muted-foreground">
            {body}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2 px-5 pb-5 pt-4">
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={onConfirm}
            isLoading={pending}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
