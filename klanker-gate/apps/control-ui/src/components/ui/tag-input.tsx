import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";

export interface TagInputProps {
  id?: string;
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
}

/** Chip editor for provider model lists (spec 2.2 edit sheet). */
export function TagInput({ id, value, onChange, placeholder }: TagInputProps) {
  const [draft, setDraft] = useState("");

  function commit() {
    const next = draft.trim();
    if (next && !value.includes(next)) {
      onChange([...value, next]);
    }
    setDraft("");
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit();
    } else if (event.key === "Backspace" && !draft && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5 rounded-md border border-input",
        "bg-card px-2 py-1.5 shadow-sm",
      )}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-sm bg-secondary px-1.5 py-0.5 font-mono text-xs"
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onChange(value.filter((item) => item !== tag))}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        placeholder={value.length === 0 ? placeholder : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
