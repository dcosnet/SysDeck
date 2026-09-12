import { useCallback, useEffect, useMemo, useState } from "react";
import { Plug, Plus, RefreshCw, Settings2, Star, Trash2 } from "lucide-react";
import {
  createProvider,
  deleteProvider,
  getConfig,
  getProviderHealth,
  type ProviderAccountConfig,
  type ProviderAccountPublic,
  type ProviderHealthView,
  refreshModels,
  setDefaultProvider,
  updateProvider,
} from "../api";
import { PageHeader } from "../components/ui/page-header";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Switch } from "../components/ui/switch";
import { Banner } from "../components/ui/banner";
import { Label } from "../components/ui/label";
import { EmptyState } from "../components/ui/empty-state";
import { TableSkeleton } from "../components/ui/skeleton";
import { useToast } from "../components/ui/toast";
import { TwoPane } from "../components/ui/two-pane";
import { DataTable } from "../components/ui/data-table";
import { DropdownMenu } from "../components/ui/dropdown-menu";
import { CustomBadge, ProviderIcon } from "../components/ui/provider-icon";
import { cn } from "../lib/utils";
import { setEurRate } from "../lib/currency";
import {
  isCustomProvider,
  PROVIDER_LABELS,
  type ProviderPreset,
} from "../components/providers/constants";
import { AddProviderForm } from "../components/providers/AddProviderForm";
import { AddProviderDialog } from "../components/providers/AddProviderDialog";
import { AddCustomProviderForm } from "../components/providers/AddCustomProviderForm";
import { ProviderConfigPanel } from "../components/providers/ProviderConfigPanel";
import { SecretReenter } from "../components/providers/SecretReenter";

type ProviderType = ProviderAccountConfig["type"];

/**
 * Traffic-light status for a configured provider (owner spec): green "online"
 * once it is enabled AND has a key/credentials AND a live health probe did not
 * fail; amber when the probe reports an error; red otherwise (disabled, or no
 * credentials).
 */
export function providerStatus(
  p: ProviderAccountPublic,
  health?: ProviderHealthView,
): { tone: "ok" | "warn" | "err"; label: string } {
  const hasCreds = p.hasApiKey || Boolean(p.hasCloudCredentials);
  if (!p.enabled) {
    return { tone: "err", label: "disabled" };
  }
  if (!hasCreds) {
    return { tone: "err", label: "no key" };
  }
  if (health?.status === "error") {
    return { tone: "warn", label: "error" };
  }
  return { tone: "ok", label: "online" };
}

/* ---------------------------- left list rail --------------------------- */

interface ProviderListProps {
  providers: ProviderAccountPublic[];
  selectedId: string | null;
  defaultId?: string;
  busy: boolean;
  health: Record<string, ProviderHealthView>;
  onSelect: (provider: ProviderAccountPublic) => void;
  onAddNew: () => void;
  onAddCustom: () => void;
  onDelete: (provider: ProviderAccountPublic) => void;
}

function ProviderList(
  {
    providers,
    selectedId,
    defaultId,
    busy,
    health,
    onSelect,
    onAddNew,
    onAddCustom,
    onDelete,
  }: ProviderListProps,
) {
  return (
    <div className="flex flex-col gap-3 py-1 pr-0 md:pr-4">
      <p className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Configured Providers
      </p>
      <table
        aria-label="Configured accounts"
        className="w-full border-collapse"
      >
        <tbody>
          {providers.map((p) => {
            const active = p.id === selectedId;
            const custom = isCustomProvider(p.type as ProviderType);
            return (
              <tr
                key={p.id}
                className={cn(
                  "group rounded-md",
                  active ? "bg-accent" : "hover:bg-accent/50",
                )}
              >
                <td className="p-0">
                  <button
                    type="button"
                    aria-label={p.id}
                    aria-current={active ? "true" : undefined}
                    onClick={() => onSelect(p)}
                    className={cn(
                      "hit-target flex w-full items-center gap-2.5 rounded-l-md",
                      "px-2.5 py-2 text-left text-sm",
                      "border-l-2",
                      active
                        ? "border-foreground font-medium text-foreground"
                        : "border-transparent text-foreground",
                    )}
                  >
                    <ProviderIcon
                      provider={p.type}
                      logoKey={p.id}
                      name={p.id}
                      custom={custom}
                      size="sm"
                    />
                    <span className="min-w-0 flex-1 truncate">{p.id}</span>
                    {}
                    <span className="flex shrink-0 items-center gap-1.5">
                      {(() => {
                        const status = providerStatus(p, health[p.id]);
                        return (
                          <Badge
                            tone={status.tone}
                            title={health[p.id]?.lastError}
                          >
                            {status.label}
                          </Badge>
                        );
                      })()}
                      {custom && <CustomBadge />}
                      {p.id === defaultId && (
                        // Icon-only: the star already reads as "default" and
                        // the word cost ~45px of a 288px rail, which is what
                        // tipped this row into overflow in the first place.
                        <Badge
                          tone="muted"
                          className="px-1"
                          title="Default provider"
                        >
                          <Star aria-hidden="true" className="size-3" />
                          <span className="sr-only">default</span>
                        </Badge>
                      )}
                    </span>
                  </button>
                </td>
                <td className="w-0 whitespace-nowrap pr-1.5 text-right align-middle">
                  <button
                    type="button"
                    aria-label={`Delete ${p.id}`}
                    disabled={busy}
                    onClick={() => onDelete(p)}
                    className={cn(
                      "hit-target inline-flex size-7 items-center justify-center",
                      "rounded-md text-muted-foreground opacity-0",
                      "transition-[opacity,color] duration-(--motion-fast)",
                      "hover:bg-destructive/10 hover:text-destructive",
                      "focus-visible:opacity-100 group-hover:opacity-100",
                      "disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-4",
                    )}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="flex flex-col gap-2 px-1">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={onAddNew}
        >
          <Plus aria-hidden="true" />
          Add New Provider
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={onAddCustom}
        >
          <Plus aria-hidden="true" />
          Add Custom Provider
        </Button>
      </div>
    </div>
  );
}

/* --------------------------- configured keys --------------------------- */

interface ConfiguredKeysProps {
  provider: ProviderAccountPublic;
  busy: boolean;
  defaultId?: string;
  onEditConfig: () => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onSaveKey: (apiKey: string) => void;
  onMakeDefault: () => void;
  onRefreshModels: () => void;
}

function ConfiguredKeys(
  {
    provider,
    busy,
    defaultId,
    onEditConfig,
    onDelete,
    onToggleEnabled,
    onSaveKey,
    onMakeDefault,
    onRefreshModels,
  }: ConfiguredKeysProps,
) {
  const [keyEditing, setKeyEditing] = useState(false);
  const [keyValue, setKeyValue] = useState("");
  const label = PROVIDER_LABELS[provider.type as ProviderType] ?? provider.type;

  // Single key per provider today; the keys table renders the one configured
  // key as a single row. Multi-key weighting is a documented follow-up.
  const rows = [provider];

  function submitKey() {
    if (keyValue.trim() === "") {
      return;
    }
    onSaveKey(keyValue.trim());
    setKeyValue("");
    setKeyEditing(false);
  }

  return (
    <div className="flex flex-col gap-4 py-1 md:pl-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <ProviderIcon
            provider={provider.type}
            logoKey={provider.id}
            name={provider.id}
            custom={isCustomProvider(provider.type as ProviderType)}
          />
          <div className="min-w-0">
            <h3 className="truncate text-lg font-semibold text-foreground">
              Configured keys
            </h3>
            <p className="text-xs text-muted-foreground">
              {provider.id} · {label}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="destructive-outline"
            size="sm"
            aria-label={`Delete ${provider.id} configuration`}
            disabled={busy}
            onClick={onDelete}
          >
            <Trash2 aria-hidden="true" />
          </Button>
          <Button variant="outline" size="sm" onClick={onEditConfig}>
            <Settings2 aria-hidden="true" />
            Edit Provider Config
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setKeyValue("");
              setKeyEditing(true);
            }}
          >
            <Plus aria-hidden="true" />
            Add new key
          </Button>
        </div>
      </div>

      <DataTable
        caption="Configured keys"
        rows={rows}
        getRowId={(p) => p.id}
        minWidth="34rem"
        columns={[
          {
            key: "key",
            header: "API Key",
            cell: (p) =>
              p.hasApiKey
                ? (
                  <span className="font-mono text-sm tracking-widest text-foreground">
                    ••••••••••
                  </span>
                )
                : p.hasCloudCredentials
                ? (
                  <span className="text-sm text-muted-foreground">
                    cloud credentials
                  </span>
                )
                : (
                  <span className="text-sm text-warning">
                    No key configured
                  </span>
                ),
          },
          {
            key: "weight",
            header: "Weight",
            width: "8rem",
            cell: () => <span className="font-mono text-sm">1</span>,
          },
          {
            key: "enabled",
            header: "Enabled",
            width: "8rem",
            cell: (p) => (
              <Switch
                checked={p.enabled}
                disabled={busy}
                aria-label="Provider enabled"
                onCheckedChange={onToggleEnabled}
              />
            ),
          },
        ]}
        rowMenu={() => (
          <DropdownMenu
            label="Key row actions"
            items={[
              {
                id: "replace-key",
                label: "Replace API key",
                icon: Plus,
                onSelect: () => {
                  setKeyValue("");
                  setKeyEditing(true);
                },
              },
              {
                id: "default",
                label: "Make default",
                icon: Star,
                disabled: provider.id === defaultId,
                onSelect: onMakeDefault,
              },
              {
                id: "refresh",
                label: "Refresh models",
                icon: RefreshCw,
                onSelect: onRefreshModels,
              },
              {
                id: "delete",
                label: "Delete provider",
                icon: Trash2,
                destructive: true,
                onSelect: onDelete,
              },
            ]}
          />
        )}
      />

      {keyEditing && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
          <Label htmlFor="keys-new">
            {provider.hasApiKey ? "Replace API key" : "Add API key"}
          </Label>
          <SecretReenter
            id="keys-new"
            label="API key"
            configured={false}
            value={keyValue}
            onChange={setKeyValue}
            placeholder="sk-..."
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setKeyEditing(false);
                setKeyValue("");
              }}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={submitKey} isLoading={busy}>
              Save key
            </Button>
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {provider.models.length} model{provider.models.length === 1 ? "" : "s"}
        {" "}
        advertised. One key per provider today; weighted multi-key routing is a
        follow-up.
      </p>
    </div>
  );
}

/* ------------------------------- the view ------------------------------ */

type Mode = "add" | "custom" | "keys" | "config";

export function ProvidersView() {
  const toast = useToast();
  const [providers, setProviders] = useState<ProviderAccountPublic[]>([]);
  const [defaultId, setDefaultId] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("add");
  const [addOpen, setAddOpen] = useState(false);
  const [addPreset, setAddPreset] = useState<ProviderPreset | null>(null);
  const [health, setHealth] = useState<Record<string, ProviderHealthView>>({});
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const selected = useMemo(
    () => providers.find((p) => p.id === selectedId) ?? null,
    [providers, selectedId],
  );

  const reload = useCallback(async () => {
    try {
      const config = await getConfig();
      setProviders(config.providers);
      setDefaultId(config.defaultProvider);
      setEurRate(config.eurRate);
      setError(null);
      // Live health drives the amber badge state; it can be slow (a probe per
      // provider) so it fills in asynchronously and never blocks the list.
      getProviderHealth()
        .then((rows) =>
          setHealth(Object.fromEntries(rows.map((r) => [r.id, r])))
        )
        .catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(action: () => Promise<unknown>, onOk?: () => void) {
    setBusy(true);
    try {
      await action();
      await reload();
      onOk?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  function selectProvider(p: ProviderAccountPublic) {
    setSelectedId(p.id);
    setMode("keys");
  }

  function openGallery() {
    setAddOpen(true);
  }

  /** Show the inline custom-provider form in the detail pane (not a modal). */
  function openCustom() {
    setAddPreset(null);
    setSelectedId(null);
    setMode("custom");
    setAddOpen(false);
  }

  function pickPreset(preset: ProviderPreset) {
    setAddPreset(preset);
    setSelectedId(null);
    setMode("add");
    setAddOpen(false);
  }

  function pickCustom() {
    openCustom();
  }

  function onAdd(payload: ProviderAccountConfig) {
    void run(() => createProvider(payload), () => {
      toast.success(`Provider "${payload.id}" added`);
      setAddPreset(null);
      setSelectedId(payload.id);
      setMode("keys");
    });
  }

  function onAddCustom(payload: ProviderAccountConfig) {
    void run(() => createProvider(payload), () => {
      toast.success(`Provider "${payload.id}" added`);
      setSelectedId(payload.id);
      setMode("keys");
    });
  }

  function onDelete(p: ProviderAccountPublic) {
    void run(() => deleteProvider(p.id), () => {
      toast.success(
        p.id === defaultId
          ? `Provider "${p.id}" deleted, no default provider is set`
          : `Provider "${p.id}" deleted`,
      );
      if (selectedId === p.id) {
        setSelectedId(null);
        setMode("add");
      }
    });
  }

  function onSaveConfig(patch: Partial<ProviderAccountConfig>) {
    if (!selected) {
      return;
    }
    const id = selected.id;
    void run(() => updateProvider(id, patch), () => {
      toast.success(`Configuration saved for "${id}"`);
      setMode("keys");
    });
  }

  function onToggleEnabled(p: ProviderAccountPublic, enabled: boolean) {
    void run(() => updateProvider(p.id, { enabled }), () => {
      toast.success(`Provider "${p.id}" ${enabled ? "enabled" : "disabled"}`);
    });
  }

  function onSaveKey(p: ProviderAccountPublic, apiKey: string) {
    void run(() => updateProvider(p.id, { apiKey }), () => {
      toast.success(`API key updated for "${p.id}"`);
    });
  }

  function onMakeDefault(p: ProviderAccountPublic) {
    void run(() => setDefaultProvider(p.id), () => {
      toast.success(`"${p.id}" is now the default provider`);
    });
  }

  function onRefresh(p: ProviderAccountPublic) {
    void run(() => refreshModels(p.id), () => {
      toast.success(`Models refreshed for "${p.id}"`);
    });
  }

  const header = (
    <PageHeader
      title="Providers"
      subtitle="Accounts the gateway can route inference to"
      actions={
        <Button
          variant="outline"
          size="icon"
          aria-label="Reload configuration"
          disabled={busy}
          onClick={() => void reload()}
        >
          <RefreshCw aria-hidden="true" />
        </Button>
      }
    />
  );

  // Full-width config panel replaces the two-pane while editing (reference).
  if (mode === "config" && selected) {
    return (
      <div>
        {header}
        {error && <Banner tone="error" className="mb-4">{error}</Banner>}
        <ProviderConfigPanel
          provider={selected}
          busy={busy}
          onSave={onSaveConfig}
          onRemove={() => onDelete(selected)}
          onBack={() => setMode("keys")}
        />
      </div>
    );
  }

  const detail = !loaded
    ? (
      <div className="py-2 md:pl-5">
        <TableSkeleton cols={3} />
      </div>
    )
    : mode === "keys" && selected
    ? (
      <ConfiguredKeys
        provider={selected}
        busy={busy}
        defaultId={defaultId}
        onEditConfig={() => setMode("config")}
        onDelete={() => onDelete(selected)}
        onToggleEnabled={(enabled) => onToggleEnabled(selected, enabled)}
        onSaveKey={(key) => onSaveKey(selected, key)}
        onMakeDefault={() => onMakeDefault(selected)}
        onRefreshModels={() => onRefresh(selected)}
      />
    )
    : mode === "custom"
    ? (
      <div className="md:pl-5">
        <AddCustomProviderForm
          busy={busy}
          onSubmit={onAddCustom}
          onCancel={() => setMode("add")}
        />
      </div>
    )
    : (
      <div className="md:pl-5">
        <AddProviderForm
          key={addPreset?.key ?? "blank"}
          busy={busy}
          onSubmit={onAdd}
          initial={addPreset
            ? {
              id: addPreset.key,
              type: addPreset.type,
              baseUrl: addPreset.baseUrl ?? "",
            }
            : undefined}
        />
      </div>
    );

  return (
    <div>
      {header}
      {error && <Banner tone="error" className="mb-4">{error}</Banner>}

      <div className="rounded-lg border border-border bg-card">
        {!loaded
          ? (
            <div className="p-4">
              <TableSkeleton cols={2} />
            </div>
          )
          : providers.length === 0
          ? (
            <div className="grid gap-0 md:grid-cols-[18rem_1fr]">
              <div className="flex flex-col gap-2 border-b border-border p-4 md:border-b-0 md:border-r">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={openGallery}
                >
                  <Plus aria-hidden="true" />
                  Add New Provider
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={openCustom}
                >
                  <Plus aria-hidden="true" />
                  Add Custom Provider
                </Button>
              </div>
              <div className="p-4">
                {mode === "custom"
                  ? (
                    <AddCustomProviderForm
                      busy={busy}
                      onSubmit={onAddCustom}
                      onCancel={() => setMode("add")}
                    />
                  )
                  : mode === "add"
                  ? (
                    <AddProviderForm
                      key={addPreset?.key ?? "blank"}
                      busy={busy}
                      onSubmit={onAdd}
                      initial={addPreset
                        ? {
                          id: addPreset.key,
                          type: addPreset.type,
                          baseUrl: addPreset.baseUrl ?? "",
                        }
                        : undefined}
                    />
                  )
                  : (
                    <EmptyState
                      icon={Plug}
                      title="No providers configured"
                      body="Add your first provider to start routing inference."
                    />
                  )}
              </div>
            </div>
          )
          : (
            <TwoPane
              listWidth="20rem"
              minListWidth={240}
              maxListWidth={480}
              storageKey="frosty.providers.railWidth"
              listLabel="Configured accounts"
              detailLabel="Account detail"
              detailActiveOnMobile={selectedId !== null}
              className="p-2 md:p-3"
              list={
                <ProviderList
                  providers={providers}
                  selectedId={selectedId}
                  defaultId={defaultId}
                  busy={busy}
                  health={health}
                  onSelect={selectProvider}
                  onAddNew={openGallery}
                  onAddCustom={openCustom}
                  onDelete={onDelete}
                />
              }
              detail={detail}
            />
          )}
      </div>

      <AddProviderDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onPick={pickPreset}
        onCustom={pickCustom}
      />
    </div>
  );
}
