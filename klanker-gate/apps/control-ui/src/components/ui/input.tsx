import {
  forwardRef,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "../../lib/utils";

const FIELD_CLASSES = "w-full rounded-md border border-input bg-card px-3 " +
  "text-base text-foreground shadow-sm placeholder:text-muted-foreground " +
  "disabled:cursor-not-allowed disabled:opacity-50 " +
  "aria-invalid:border-destructive";

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn("h-(--control-h)", FIELD_CLASSES, className)}
      {...props}
    />
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn("py-2", FIELD_CLASSES, className)}
      {...props}
    />
  );
});
