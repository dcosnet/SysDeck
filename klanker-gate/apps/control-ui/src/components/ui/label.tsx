import { forwardRef, type LabelHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/utils";

export const Label = forwardRef<
  HTMLLabelElement,
  LabelHTMLAttributes<HTMLLabelElement>
>(function Label({ className, ...props }, ref) {
  return (
    <label
      ref={ref}
      className={cn("text-sm font-medium text-foreground", className)}
      {...props}
    />
  );
});

export interface FieldProps {
  id: string;
  label: string;
  required?: boolean;
  error?: string | null;
  hint?: string;
  className?: string;
  children: ReactNode;
}

/** Label + control + hint/error stack; the caller wires aria attributes. */
export function Field(
  { id, label, required, error, hint, className, children }: FieldProps,
) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id}>
        {label}
        {required && (
          <span aria-hidden="true" className="text-destructive">
            {" *"}
          </span>
        )}
      </Label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
