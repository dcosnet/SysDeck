import { SlidersHorizontal } from "lucide-react";
import { useId } from "react";
import { cn } from "../../lib/utils";
import { Switch } from "./switch";

export interface ToggleGridItemProps {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** When set, renders a per-row settings (sliders) button. */
  onSettings?: () => void;
  settingsLabel?: string;
  description?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Labelled toggle row with an optional per-row settings button (spec: Custom
 * Provider "Allowed Request Types" grid). Designed to tile inside a responsive
 * grid; the switch owns the checked state and the settings icon is a separate
 * control so it never fights the toggle for focus.
 */
export function ToggleGridItem(
  {
    label,
    checked,
    onCheckedChange,
    onSettings,
    settingsLabel = "Settings",
    description,
    id,
    disabled,
    className,
  }: ToggleGridItemProps,
) {
  const generatedId = useId();
  const switchId = id ?? generatedId;
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-border bg-card",
        "px-3 py-2",
        className,
      )}
    >
      <label htmlFor={switchId} className="min-w-0 flex-1 cursor-pointer">
        <span className="block truncate text-sm font-medium text-foreground">
          {label}
        </span>
        {description && (
          <span className="block truncate text-xs text-muted-foreground">
            {description}
          </span>
        )}
      </label>
      {onSettings && (
        <button
          type="button"
          aria-label={`${settingsLabel}: ${label}`}
          disabled={disabled}
          onClick={onSettings}
          className={cn(
            "hit-target inline-flex size-7 shrink-0 items-center justify-center",
            "rounded-md text-muted-foreground",
            "transition-colors duration-(--motion-fast)",
            "hover:bg-accent hover:text-foreground",
            "disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4",
          )}
        >
          <SlidersHorizontal aria-hidden="true" />
        </button>
      )}
      <Switch
        id={switchId}
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}
