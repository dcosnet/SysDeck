import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import {
  type CatalogProviderRow,
  getProviderAvailableModels,
  updateProvider,
} from "../../api";
import { Dialog } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Banner } from "../ui/banner";
import { ToggleGridItem } from "../ui/toggle-grid-item";
import { ProviderIcon } from "../ui/provider-icon";
import { useToast } from "../ui/toast";

export interface ProviderModelsDialogProps {
  /** The clicked catalog row; null closes the dialog. */
  provider: CatalogProviderRow | null;
  onClose: () => void;
  /** Fired after a successful save so the catalog can reload. */
  onSaved: () => void;
}

/**
 * Per-provider model enablement grid. Opens from a Model Catalog row, fetches
 * the provider's full live model list, and shows every model (the live list
 * unioned with the currently-enabled ones) as an on/off tile. Saving writes the
 * enabled subset back to the account's `models` - the set the gateway routes
 * on. Providers without live listing fall back to their stored models.
 */
export function ProviderModelsDialog(
  { provider, onClose, onSaved }: ProviderModelsDialogProps,
) {
  const toast = useToast();
  const [available, setAvailable] = useState<string[]>([]);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noLiveListing, setNoLiveListing] = useState(false);

  const open = provider !== null;
  const providerId = provider?.id ?? null;

  useEffect(() => {
    if (!provider) {
      return;
    }
    let alive = true;
    setQuery("");
    setError(null);
    setNoLiveListing(false);
    setEnabled(new Set(provider.models));
    setAvailable(provider.models);
    setLoading(true);
    getProviderAvailableModels(provider.id)
      .then((res) => {
        if (alive) setAvailable(res.models);
      })
      .catch((err) => {
        if (!alive) return;
        // A 400 means the provider type cannot list models live; the stored
        // enabled set is still editable, so degrade instead of failing.
        setNoLiveListing(true);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [providerId]);

  // Union of the live list and the enabled set, so a model that is enabled but
  // no longer advertised still shows (and can be turned off).
  const allModels = useMemo(() => {
    const set = new Set<string>(available);
    for (const m of enabled) set.add(m);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [available, enabled]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? allModels.filter((m) => m.toLowerCase().includes(q)) : allModels;
  }, [allModels, query]);

  function toggle(model: string, on: boolean) {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (on) next.add(model);
      else next.delete(model);
      return next;
    });
  }

  function setAll(on: boolean) {
    setEnabled((prev) => {
      const next = new Set(prev);
      for (const m of filtered) {
        if (on) next.add(m);
        else next.delete(m);
      }
      return next;
    });
  }

  async function save() {
    if (!provider) return;
    setSaving(true);
    try {
      const models = [...enabled].sort((a, b) => a.localeCompare(b));
      await updateProvider(provider.id, { models });
      toast.success(`Models updated for "${provider.id}"`);
      onSaved();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={provider ? `${provider.id} models` : "Models"}
      description="Toggle which models this provider exposes to the gateway."
      className="max-w-3xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} isLoading={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {provider && (
            <ProviderIcon
              provider={provider.type}
              logoKey={provider.id}
              name={provider.id}
              custom={provider.custom}
              size="sm"
            />
          )}
          <span className="text-sm text-muted-foreground">
            {enabled.size} of {allModels.length} enabled
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAll(true)}
              disabled={loading || filtered.length === 0}
            >
              Enable all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAll(false)}
              disabled={loading || filtered.length === 0}
            >
              Disable all
            </Button>
          </div>
        </div>

        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search models"
            placeholder="Search models..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>

        {noLiveListing && (
          <Banner tone="info">
            This provider type does not support live model listing. Editing the
            models it already advertises.
          </Banner>
        )}
        {error && !noLiveListing && <Banner tone="error">{error}</Banner>}

        <div className="max-h-[50vh] overflow-y-auto pr-1">
          {loading
            ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Loading models...
              </p>
            )
            : filtered.length === 0
            ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {allModels.length === 0
                  ? "No models available."
                  : `No models match "${query}".`}
              </p>
            )
            : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((model) => (
                  <ToggleGridItem
                    key={model}
                    label={model}
                    checked={enabled.has(model)}
                    onCheckedChange={(on) => toggle(model, on)}
                  />
                ))}
              </div>
            )}
        </div>
      </div>
    </Dialog>
  );
}
