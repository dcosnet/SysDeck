import { useState } from "react";
import { Plus, Search } from "lucide-react";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { ProviderIcon } from "../ui/provider-icon";
import { cn } from "../../lib/utils";
import { PROVIDER_PRESETS, type ProviderPreset } from "./constants";

export interface AddProviderDialogProps {
  open: boolean;
  onClose: () => void;
  /** Pick a vendor preset: prefills the add form with its type + base URL. */
  onPick: (preset: ProviderPreset) => void;
  /** "Custom / other" escape hatch: open the blank / custom-provider flow. */
  onCustom: () => void;
}

/**
 * One-click provider gallery. Lists the vendor presets as filterable cards with
 * their brand logo; picking one prefills the add form. A trailing "Custom" card
 * routes to the bring-your-own flow for anything not in the catalog.
 */
export function AddProviderDialog(
  { open, onClose, onPick, onCustom }: AddProviderDialogProps,
) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? PROVIDER_PRESETS.filter((p) =>
      p.displayName.toLowerCase().includes(needle) ||
      p.key.toLowerCase().includes(needle) ||
      p.type.toLowerCase().includes(needle)
    )
    : PROVIDER_PRESETS;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a provider"
      description="Pick a vendor to prefill its connection, then add your key."
      className="max-w-2xl"
    >
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search providers"
            placeholder="Search providers..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>

        <div
          role="list"
          className="grid max-h-[22rem] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2"
        >
          {matches.map((preset) => (
            <button
              key={preset.key}
              type="button"
              role="listitem"
              onClick={() => onPick(preset)}
              className={cn(
                "flex items-center gap-3 rounded-lg border border-border",
                "bg-card p-3 text-left transition-colors duration-(--motion-fast)",
                "hover:border-ring hover:bg-accent",
                "focus-visible:outline-none focus-visible:ring-2",
                "focus-visible:ring-ring focus-visible:ring-offset-2",
                "focus-visible:ring-offset-background",
              )}
            >
              <ProviderIcon
                provider={preset.type}
                logoKey={preset.key}
                name={preset.displayName}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {preset.displayName}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {preset.hint ?? preset.type}
                </span>
              </span>
            </button>
          ))}
          {matches.length === 0 && (
            <p className="col-span-full py-6 text-center text-sm text-muted-foreground">
              No providers match "{query}".
            </p>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">
            Cannot find it? Add any OpenAI- or Anthropic-compatible endpoint.
          </p>
          <Button variant="outline" size="sm" onClick={onCustom}>
            <Plus aria-hidden="true" />
            Custom provider
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
