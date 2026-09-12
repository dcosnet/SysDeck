import { useId, useState } from "react";
import { Check, Eye, EyeOff, KeyRound } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export interface SecretReenterProps {
  /** Whether a secret is already stored server-side (a hasX marker). */
  configured: boolean;
  /** The new secret to submit; empty string means "keep the current value". */
  value: string;
  onChange: (value: string) => void;
  /** Accessible name, e.g. "API key", "Proxy password". */
  label: string;
  id?: string;
  placeholder?: string;
  /** Copy shown next to the "Configured" marker while not replacing. */
  configuredHint?: string;
  className?: string;
}

/**
 * Secret re-entry field (taste: never render stored secret values). When a
 * secret is already configured we show a "Configured" marker plus a "Replace"
 * button; only after the operator opts in does an input appear to submit a new
 * value. When nothing is configured the input shows immediately. The stored
 * value is never sent to the browser, so there is nothing to reveal - reveal
 * toggles only the operator's freshly typed replacement.
 */
export function SecretReenter(
  {
    configured,
    value,
    onChange,
    label,
    id,
    placeholder,
    configuredHint = "A value is already stored. Replace it or leave it as is.",
    className,
  }: SecretReenterProps,
) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  // Replacing is implied when nothing is configured, or once the operator opts
  // in. Typing keeps the input open even if they clear it back to empty.
  const [replacing, setReplacing] = useState(!configured);
  const [reveal, setReveal] = useState(false);

  if (configured && !replacing) {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <span
          className={cn(
            "inline-flex h-(--control-h) min-w-0 flex-1 items-center gap-2",
            "rounded-md border border-input bg-muted/40 px-3",
            "text-sm text-muted-foreground",
          )}
        >
          <KeyRound aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">Configured</span>
          <span aria-hidden="true" className="font-mono tracking-widest">
            ••••••••
          </span>
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setReplacing(true);
            onChange("");
          }}
          aria-label={`Replace ${label}`}
        >
          Replace
        </Button>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <input
            id={fieldId}
            type={reveal ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            aria-label={label}
            value={value}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)}
            className={cn(
              "h-(--control-h) w-full rounded-md border border-input bg-card",
              "pl-3 pr-10 font-mono text-sm text-foreground shadow-sm",
              "placeholder:font-sans placeholder:text-muted-foreground",
            )}
          />
          <button
            type="button"
            aria-pressed={reveal}
            aria-label={reveal ? `Hide ${label}` : `Show ${label}`}
            onClick={() => setReveal((prev) => !prev)}
            className={cn(
              "hit-target absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2",
              "items-center justify-center rounded-md text-muted-foreground",
              "transition-colors duration-(--motion-fast)",
              "hover:bg-accent hover:text-foreground [&_svg]:size-4",
            )}
          >
            {reveal
              ? <EyeOff aria-hidden="true" />
              : <Eye aria-hidden="true" />}
          </button>
        </div>
        {configured && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setReplacing(false);
              onChange("");
            }}
          >
            <Check aria-hidden="true" />
            Keep current
          </Button>
        )}
      </div>
      {configured && (
        <p className="text-sm text-muted-foreground">{configuredHint}</p>
      )}
    </div>
  );
}
