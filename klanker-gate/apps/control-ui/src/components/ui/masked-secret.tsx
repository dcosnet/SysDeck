import { useState } from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { cn } from "../../lib/utils";
import { CopyButton } from "./copy-button";

const DOTS = "•".repeat(10);

/**
 * Render a secret with a short leading hint and fixed-width dots. The dot count
 * is constant so the true length never leaks. The full value is never logged.
 */
export function maskSecret(value: string, visiblePrefix = 6): string {
  if (!value) {
    return "";
  }
  const prefix = value.slice(0, Math.min(visiblePrefix, value.length));
  return `${prefix}${DOTS}`;
}

export interface MaskedSecretProps {
  value: string;
  /** Accessible name for the reveal toggle + field. */
  label: string;
  id?: string;
  /** Characters shown before the dots while masked. */
  visiblePrefix?: number;
  className?: string;
}

/** Read-only secret field: masked by default with reveal + copy affordances. */
export function MaskedSecret(
  { value, label, id, visiblePrefix = 6, className }: MaskedSecretProps,
) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <input
        id={id}
        readOnly
        aria-label={label}
        value={revealed ? value : maskSecret(value, visiblePrefix)}
        className={cn(
          "h-(--control-h) min-w-0 flex-1 rounded-md border border-input",
          "bg-card px-3 font-mono text-sm text-foreground shadow-sm",
        )}
      />
      <RevealToggle
        revealed={revealed}
        label={label}
        onToggle={() => setRevealed((prev) => !prev)}
      />
      <CopyButton value={value} label="Copy" />
    </div>
  );
}

export interface MaskedSecretCellProps {
  value: string;
  /** Accessible name, e.g. the key's name. */
  label: string;
  visiblePrefix?: number;
  className?: string;
}

/**
 * Compact table-cell variant (spec: Virtual Keys "Key" column): mono prefix +
 * dots with inline reveal and copy icon buttons.
 */
export function MaskedSecretCell(
  { value, label, visiblePrefix = 8, className }: MaskedSecretCellProps,
) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable (insecure context / jsdom): silent no-op
    }
  }

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="font-mono text-sm text-foreground">
        {revealed ? value : maskSecret(value, visiblePrefix)}
      </span>
      <RevealToggle
        revealed={revealed}
        label={label}
        onToggle={() => setRevealed((prev) => !prev)}
      />
      <button
        type="button"
        aria-label={copied ? "Copied" : `Copy ${label}`}
        onClick={copy}
        className={cn(
          "hit-target inline-flex size-7 shrink-0 items-center justify-center",
          "rounded-md text-muted-foreground",
          "transition-colors duration-(--motion-fast)",
          "hover:bg-accent hover:text-foreground [&_svg]:size-4",
        )}
      >
        {copied
          ? <Check aria-hidden="true" className="text-success" />
          : <Copy aria-hidden="true" />}
      </button>
    </span>
  );
}

function RevealToggle(
  { revealed, label, onToggle }: {
    revealed: boolean;
    label: string;
    onToggle: () => void;
  },
) {
  return (
    <button
      type="button"
      aria-pressed={revealed}
      aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
      onClick={onToggle}
      className={cn(
        "hit-target inline-flex size-7 shrink-0 items-center justify-center",
        "rounded-md text-muted-foreground",
        "transition-colors duration-(--motion-fast)",
        "hover:bg-accent hover:text-foreground [&_svg]:size-4",
      )}
    >
      {revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
    </button>
  );
}
