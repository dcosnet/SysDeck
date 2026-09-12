import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "./button";

export interface CopyButtonProps {
  value: string;
  label?: string;
  onCopied?: () => void;
  className?: string;
}

/** Clipboard copy with a 2s "Copied" confirmation (spec 6 CopyButton). */
export function CopyButton(
  { value, label = "Copy", onCopied, className }: CopyButtonProps,
) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
      onCopied?.();
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable (insecure context / jsdom): silent no-op
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={copy}
      className={className}
    >
      {copied
        ? (
          <>
            <Check aria-hidden="true" />
            Copied
          </>
        )
        : (
          <>
            <Copy aria-hidden="true" />
            {label}
          </>
        )}
    </Button>
  );
}
