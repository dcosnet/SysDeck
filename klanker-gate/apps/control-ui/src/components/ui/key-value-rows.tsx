import { Plus, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

export interface KeyValuePair {
  name: string;
  value: string;
}

export interface KeyValueRowsProps {
  value: KeyValuePair[];
  onChange: (rows: KeyValuePair[]) => void;
  nameLabel?: string;
  valueLabel?: string;
  namePlaceholder?: string;
  valuePlaceholder?: string;
  /** Use password inputs when values may be credentials. */
  valueInputType?: "text" | "password";
  addLabel?: string;
  /** Prefix for generated input ids / aria labels. */
  idPrefix?: string;
  className?: string;
}

/**
 * Repeatable Name / Value row editor (spec: Extra Headers, External Base URLs).
 * Fully controlled; add appends a blank pair, remove drops by index. Each field
 * carries an indexed accessible name so screen readers can tell rows apart.
 */
export function KeyValueRows(
  {
    value,
    onChange,
    nameLabel = "Name",
    valueLabel = "Value",
    namePlaceholder = "Name",
    valuePlaceholder = "Value",
    valueInputType = "text",
    addLabel = "Add row",
    idPrefix = "kv",
    className,
  }: KeyValueRowsProps,
) {
  function update(index: number, patch: Partial<KeyValuePair>) {
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function remove(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function add() {
    onChange([...value, { name: "", value: "" }]);
  }

  const fieldClass = cn(
    "h-(--control-h) w-full min-w-0 rounded-md border border-input bg-card",
    "px-3 text-sm text-foreground shadow-sm",
    "placeholder:text-muted-foreground",
  );

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {value.length > 0 && (
        <div className="flex items-center gap-2 px-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <span className="flex-1">{nameLabel}</span>
          <span className="flex-1">{valueLabel}</span>
          <span className="w-(--control-h)" aria-hidden="true" />
        </div>
      )}
      {value.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            aria-label={`${nameLabel} ${index + 1}`}
            value={row.name}
            placeholder={namePlaceholder}
            onChange={(event) =>
              update(index, { name: event.target.value })}
            className={cn("flex-1", fieldClass)}
          />
          <input
            aria-label={`${valueLabel} ${index + 1}`}
            type={valueInputType}
            autoComplete={valueInputType === "password" ? "off" : undefined}
            value={row.value}
            placeholder={valuePlaceholder}
            onChange={(event) =>
              update(index, { value: event.target.value })}
            className={cn("flex-1", fieldClass)}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${nameLabel.toLowerCase()} row ${index + 1}`}
            onClick={() => remove(index)}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      ))}
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={add}
          id={`${idPrefix}-add`}
        >
          <Plus aria-hidden="true" />
          {addLabel}
        </Button>
      </div>
    </div>
  );
}
