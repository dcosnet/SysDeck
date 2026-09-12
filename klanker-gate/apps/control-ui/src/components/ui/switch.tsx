import { cn } from "../../lib/utils";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  id?: string;
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
}

export function Switch(
  { checked, onCheckedChange, id, disabled, title, ...aria }: SwitchProps,
) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "hit-target relative inline-flex h-5 w-9 shrink-0 items-center",
        "rounded-full border border-transparent",
        "transition-colors duration-(--motion-default)",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted border-input",
      )}
      {...aria}
    >
      <span
        aria-hidden="true"
        className={cn(
          "block size-4 rounded-full shadow-sm",
          "transition-transform duration-(--motion-default)",
          checked
            ? "translate-x-4 bg-primary-foreground"
            : "translate-x-0.5 bg-muted-foreground",
        )}
      />
    </button>
  );
}
