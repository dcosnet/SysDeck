import { forwardRef, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

/** Styled native select (G9: the only select in the app). */
export const NativeSelect = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(function NativeSelect({ className, children, ...props }, ref) {
  return (
    <div className={cn("relative", className)}>
      <select
        ref={ref}
        className={cn(
          "h-(--control-h) w-full appearance-none rounded-md border",
          "border-input bg-card pl-3 pr-8 text-base text-foreground",
          "shadow-sm disabled:cursor-not-allowed disabled:opacity-50",
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute right-2 top-1/2 size-4",
          "-translate-y-1/2 text-muted-foreground",
        )}
      />
    </div>
  );
});
