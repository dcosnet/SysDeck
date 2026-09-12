import { useId } from "react";
import { cn } from "../../lib/utils";
import { Label } from "./label";

export interface NumberFieldProps {
  label: string;
  value: number | string;
  onChange: (value: string) => void;
  id?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Unit suffix shown inside the field, e.g. "seconds", "ms". */
  unit?: string;
  /** Help text below the field. */
  help?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * Labelled numeric field with unit + help text (spec: provider-config /
 * Performance Tuning / MCP dense grids). Emits the raw string so an empty
 * field stays representable; min/max/step map to native + aria constraints.
 */
export function NumberField(
  {
    label,
    value,
    onChange,
    id,
    min,
    max,
    step,
    unit,
    help,
    placeholder,
    required,
    disabled,
    className,
  }: NumberFieldProps,
) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const helpId = help ? `${fieldId}-help` : undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={fieldId}>
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-destructive">
            *
          </span>
        )}
      </Label>
      <div className="relative">
        <input
          id={fieldId}
          type="number"
          inputMode="decimal"
          value={value}
          min={min}
          max={max}
          step={step}
          required={required}
          disabled={disabled}
          placeholder={placeholder}
          aria-describedby={helpId}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            "h-(--control-h) w-full rounded-md border border-input bg-card",
            "px-3 text-base text-foreground shadow-sm",
            "placeholder:text-muted-foreground",
            "disabled:cursor-not-allowed disabled:opacity-50",
            unit && "pr-14",
          )}
        />
        {unit && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
          >
            {unit}
          </span>
        )}
      </div>
      {help && (
        <p id={helpId} className="text-sm text-muted-foreground">{help}</p>
      )}
    </div>
  );
}
