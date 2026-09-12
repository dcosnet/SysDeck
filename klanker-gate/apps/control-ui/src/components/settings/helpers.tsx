import type { ReactNode } from "react";
import type { SettingSource } from "../../api";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Card, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Button } from "../ui/button";

/* --------------------------- value coercion ---------------------------- */
// Settings values arrive typed as `unknown` (the shape is per-group). These
// keep the panels total when the gateway omits a field or returns a partial.

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asBool(value: unknown): boolean {
  return value === true;
}

/** A number field's raw string; keeps an empty field representable. */
export function asNumStr(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" ? value : "";
}

export function asStrArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

/** Parse a raw number field back to a value for the save payload. */
export function numOrUndef(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/** Read a field's provenance from a section's `sources` map. */
export function sourceOf(
  sources: Record<string, SettingSource> | undefined,
  field: string,
): SettingSource | undefined {
  return sources?.[field];
}

/* ------------------------------ provenance ----------------------------- */

/**
 * Subtle provenance tag driven by `sources[field]`. Env-set and operator
 * overrides get a muted chip (monochrome, never a status color); a built-in
 * default renders nothing so the common case stays quiet.
 */
export function SourceTag({ source }: { source?: SettingSource }): ReactNode {
  if (source === "env") {
    return (
      <Badge
        tone="muted"
        title="Set by an environment variable; manage it there."
      >
        env
      </Badge>
    );
  }
  if (source === "override") {
    return (
      <Badge tone="muted" title="Overridden from this control plane.">
        override
      </Badge>
    );
  }
  return null;
}

/** One-line hint shown under an env-managed control. */
export function EnvHint({ source }: { source?: SettingSource }): ReactNode {
  if (source !== "env") {
    return null;
  }
  return (
    <p className="text-sm text-muted-foreground">
      Set by an environment variable. Update it in your environment
      configuration to change this value.
    </p>
  );
}

/* --------------------------- shared layout ----------------------------- */

/** h4 sub-section heading inside a panel. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <h4 className="text-sm font-semibold text-foreground">{children}</h4>;
}

/** Muted intro line at the top of each sub-page panel. */
export function PanelIntro({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

export interface FieldBlockProps {
  id: string;
  label: string;
  source?: SettingSource;
  required?: boolean;
  hint?: ReactNode;
  children: ReactNode;
}

/**
 * Vertical label + control stack (label on top) with an inline provenance chip
 * and an optional hint. The caller wires the control's `id` so the label names
 * it. Env-managed fields also render the managed-by hint.
 */
export function FieldBlock(
  { id, label, source, required, hint, children }: FieldBlockProps,
) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2">
        <Label htmlFor={id}>
          {label}
          {required && (
            <span aria-hidden="true" className="ml-0.5 text-destructive">
              *
            </span>
          )}
        </Label>
        <SourceTag source={source} />
      </span>
      {children}
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      <EnvHint source={source} />
    </div>
  );
}

export interface ToggleRowProps {
  id: string;
  label: string;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  source?: SettingSource;
  /** Trailing label chip (e.g. "Beta", "Deprecating soon"). */
  badge?: ReactNode;
  /** Card border; off renders a plain row (Compatibility page). */
  bordered?: boolean;
  /** Extra content below the row (caution note, etc.). */
  children?: ReactNode;
}

/**
 * Labelled boolean row with an optional badge and a right-aligned switch. The
 * visible label is associated to the switch (pointer) while the switch owns the
 * accessible name; env provenance surfaces a chip plus a managed-by hint.
 */
export function ToggleRow(
  {
    id,
    label,
    description,
    checked,
    onCheckedChange,
    disabled,
    source,
    badge,
    bordered = false,
    children,
  }: ToggleRowProps,
) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        bordered && "rounded-md border border-border bg-card px-4 py-3",
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <label htmlFor={id} className="min-w-0 cursor-pointer">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{label}</span>
            {badge}
            <SourceTag source={source} />
          </span>
          {description && (
            <span className="mt-0.5 block text-sm text-muted-foreground">
              {description}
            </span>
          )}
        </label>
        <Switch
          id={id}
          checked={checked}
          disabled={disabled}
          aria-label={label}
          onCheckedChange={onCheckedChange}
        />
      </div>
      <EnvHint source={source} />
      {children}
    </div>
  );
}

export interface NumberCardProps {
  id: string;
  label: string;
  description?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  source?: SettingSource;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}

/**
 * A bordered card with the field title and help on the left and a compact
 * numeric input on the right (Performance / MCP tuning cards). The input is
 * labelled by the left-hand title via `htmlFor`, so it needs no repeated label.
 */
export function NumberCard(
  {
    id,
    label,
    description,
    value,
    onChange,
    source,
    min,
    max,
    step,
    disabled,
  }: NumberCardProps,
) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <Label htmlFor={id} className="font-semibold">{label}</Label>
            <SourceTag source={source} />
          </span>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
          <EnvHint source={source} />
        </div>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-28"
        />
      </CardContent>
    </Card>
  );
}

/** Right-aligned save footer shared by every panel. */
export function PanelFooter(
  { dirty, busy, onSave }: {
    dirty: boolean;
    busy: boolean;
    onSave: () => void;
  },
) {
  return (
    <div className="flex justify-end pt-1">
      <Button onClick={onSave} disabled={!dirty} isLoading={busy}>
        Save changes
      </Button>
    </div>
  );
}
