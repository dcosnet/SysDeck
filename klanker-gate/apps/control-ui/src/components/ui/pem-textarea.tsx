import { useId } from "react";
import { cn } from "../../lib/utils";
import { Textarea } from "./input";
import { Label } from "./label";

const DEFAULT_PLACEHOLDER =
  "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----";

/** Non-blocking heuristic: empty is valid; otherwise expect PEM delimiters. */
export function isLikelyPem(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") {
    return true;
  }
  return /-----BEGIN [^-]+-----/.test(trimmed) &&
    /-----END [^-]+-----/.test(trimmed);
}

export interface PemTextareaProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  label?: string;
  placeholder?: string;
  rows?: number;
  hint?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Monospace PEM editor (spec: TLS / CA certificate). Ships a PEM placeholder
 * and a light, non-blocking validation affordance: malformed input flags
 * aria-invalid and shows a hint but never prevents entry.
 */
export function PemTextarea(
  {
    value,
    onChange,
    id,
    label,
    placeholder = DEFAULT_PLACEHOLDER,
    rows = 6,
    hint,
    disabled,
    className,
  }: PemTextareaProps,
) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const messageId = `${fieldId}-message`;
  const valid = isLikelyPem(value);
  const warn = !valid;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && <Label htmlFor={fieldId}>{label}</Label>}
      <Textarea
        id={fieldId}
        value={value}
        rows={rows}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={warn || undefined}
        aria-describedby={warn || hint ? messageId : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="font-mono text-xs leading-relaxed"
      />
      {warn
        ? (
          <p id={messageId} className="text-sm text-warning">
            Expected PEM delimiters (-----BEGIN ...----- / -----END ...-----).
          </p>
        )
        : hint
        ? (
          <p id={messageId} className="text-sm text-muted-foreground">
            {hint}
          </p>
        )
        : null}
    </div>
  );
}
