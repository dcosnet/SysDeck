import { useEffect, useMemo, useState } from "react";
import { CornerDownLeft, Search } from "lucide-react";
import { filterNav, groupsOf } from "../../lib/nav";
import { useModal } from "../ui/use-modal";
import { cn } from "../../lib/utils";

export interface CommandItem {
  id: string;
  label: string;
  group: string;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  items: CommandItem[];
  onSelect: (id: string) => void;
}

/**
 * Dependency-free command palette (spec: Cmd/Ctrl-K overlay). Focus-trapped
 * via useModal, filters views as you type, and navigates on Enter or click.
 * Results are listbox options (not buttons) so they never collide with the
 * pinned nav button names. The search input's accessible name is "Command
 * menu" - deliberately free of any pinned substring (G6/G7).
 */
export function CommandPalette(
  { open, onClose, items, onSelect }: CommandPaletteProps,
) {
  const ref = useModal(open, onClose, true);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const results = useMemo(() => filterNav(items, query), [items, query]);

  // Reset the query and highlight each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  // Keep the highlight in range as the result set shrinks.
  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(0, results.length - 1)));
  }, [results.length]);

  if (!open) {
    return null;
  }

  function choose(id: string) {
    onSelect(id);
    onClose();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) =>
        results.length === 0 ? 0 : (i - 1 + results.length) % results.length
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = results[active];
      if (item) {
        choose(item.id);
      }
    }
  }

  const groups = groupsOf(results);
  const activeId = results[active]?.id;

  return (
    <div className="fixed inset-0 z-(--z-modal) flex items-start justify-center p-4 pt-[12vh]">
      <div
        className="absolute inset-0 bg-foreground/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          "relative z-10 flex w-full max-w-lg flex-col overflow-hidden",
          "rounded-xl border border-border bg-popover text-popover-foreground",
          "shadow-lg outline-none",
        )}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <input
            type="text"
            aria-label="Command menu"
            aria-controls="command-results"
            aria-activedescendant={activeId
              ? `command-opt-${activeId}`
              : undefined}
            placeholder="Search views..."
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            className={cn(
              "h-11 w-full bg-transparent text-base text-foreground outline-none",
              "placeholder:text-muted-foreground",
            )}
          />
        </div>

        <ul
          id="command-results"
          role="listbox"
          aria-label="Views"
          className="max-h-80 overflow-y-auto p-1.5"
        >
          {results.length === 0
            ? (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                No matching views.
              </li>
            )
            : (
              groups.map((group) => (
                <li key={group} role="presentation">
                  <div className="px-2 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                    {group}
                  </div>
                  <ul role="presentation" className="flex flex-col">
                    {results
                      .filter((item) => item.group === group)
                      .map((item) => {
                        const highlighted = item.id === activeId;
                        return (
                          <li
                            key={item.id}
                            id={`command-opt-${item.id}`}
                            role="option"
                            aria-selected={highlighted}
                            onClick={() => choose(item.id)}
                            onMouseMove={() =>
                              setActive(results.indexOf(item))}
                            className={cn(
                              "flex cursor-pointer items-center justify-between",
                              "rounded-md px-2.5 py-2 text-sm",
                              highlighted
                                ? "bg-accent text-accent-foreground"
                                : "text-foreground",
                            )}
                          >
                            <span>{item.label}</span>
                            {highlighted && (
                              <CornerDownLeft
                                aria-hidden="true"
                                className="size-3.5 text-muted-foreground"
                              />
                            )}
                          </li>
                        );
                      })}
                  </ul>
                </li>
              ))
            )}
        </ul>

        <div className="flex items-center gap-3 border-t border-border px-3 py-2 text-2xs text-muted-foreground">
          <span>Up / Down to move</span>
          <span>Enter to open</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
}
