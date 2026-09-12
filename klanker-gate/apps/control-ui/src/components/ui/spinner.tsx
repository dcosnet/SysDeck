import { LoaderCircle } from "lucide-react";
import { cn } from "../../lib/utils";

export function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      aria-hidden="true"
      className={cn(
        "size-4 animate-spin [animation-duration:var(--motion-spin)]",
        "motion-reduce:animate-none",
        className,
      )}
    />
  );
}
