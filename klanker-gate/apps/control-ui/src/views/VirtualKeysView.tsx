import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Info,
  KeyRound,
  Plus,
  Search,
  SquarePen,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  createVirtualKey,
  type Customer,
  deleteVirtualKey,
  getConfig,
  getCustomers,
  getTeams,
  getVirtualKeys,
  type ProviderAccountPublic,
  type Team,
  updateVirtualKey,
  type VirtualKeyInput,
  type VirtualKeyPublic,
} from "../api";
import { PageHeader } from "../components/ui/page-header";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Banner } from "../components/ui/banner";
import { EmptyState } from "../components/ui/empty-state";
import { TableSkeleton } from "../components/ui/skeleton";
import { type Column, DataTable } from "../components/ui/data-table";
import { Combobox, type ComboboxOption } from "../components/ui/combobox";
import { ExportButton } from "../components/ui/export-button";
import { MaskedSecretCell } from "../components/ui/masked-secret";
import { Sheet } from "../components/ui/sheet";
import { ConfirmDialog } from "../components/ui/dialog";
import { Switch } from "../components/ui/switch";
import { Field, Label } from "../components/ui/label";
import { Input, Textarea } from "../components/ui/input";
import { NativeSelect } from "../components/ui/select";
import { CopyButton } from "../components/ui/copy-button";
import { useModal } from "../components/ui/use-modal";
import { useToast } from "../components/ui/toast";
import type { CsvColumn } from "../lib/csv";
import {
  budgetChips,
  type BudgetDraft,
  budgetError,
  budgetToDraft,
  budgetToPayload,
  Chips,
  emptyBudgetDraft,
  humanizeWindow,
  msFromWindow,
} from "../lib/governance";

/**
 * The gateway's CreateVirtualKeySchema accepts (and publicVirtualKey returns) a
 * `description`, but the shared api.ts input/public types predate that field.
 * We widen locally rather than edit the shared client, so `description` still
 * round-trips through create, update, and read.
 */
type VKPayload = VirtualKeyInput & { description?: string };

function keyDescription(vk?: VirtualKeyPublic): string {
  return (vk as (VirtualKeyPublic & { description?: string }) | undefined)
    ?.description ?? "";
}

/** Held only in memory for the reveal dialog; nulled on close (security #13). */
interface Revealed {
  name: string;
  token: string;
  tokenHint: string;
}

const PAGE_SIZE = 8;

/** Named reset windows shown as "Reset Period"; each maps to a stored windowMs. */
const RESET_PERIODS = [
  { label: "Hourly", ms: msFromWindow(1, "hours") },
  { label: "Daily", ms: msFromWindow(24, "hours") },
  { label: "Weekly", ms: msFromWindow(24 * 7, "hours") },
  { label: "Monthly", ms: msFromWindow(24 * 30, "hours") },
] as const;
const DEFAULT_PERIOD_MS = RESET_PERIODS[0].ms;

/** Preset windows, plus a synthetic entry so an off-preset stored window round-trips. */
function periodOptions(currentMs: number): { value: string; label: string }[] {
  const base = RESET_PERIODS.map((p) => ({
    value: String(p.ms),
    label: p.label,
  }));
  if (RESET_PERIODS.some((p) => p.ms === currentMs)) {
    return base;
  }
  return [
    { value: String(currentMs), label: `Every ${humanizeWindow(currentMs)}` },
    ...base,
  ];
}

function numOrUndef(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/** Team name a key is assigned to (empty string when unassigned). */
function assignedName(vk: VirtualKeyPublic, teams: Map<string, Team>): string {
  if (!vk.teamId) {
    return "";
  }
  return teams.get(vk.teamId)?.name ?? vk.teamId;
}

/** Rate + token limit chips for the "Rate Limits" column. */
function rateLimitItems(vk: VirtualKeyPublic): string[] {
  const items: string[] = [];
  if (vk.rateLimit) {
    items.push(
      `${vk.rateLimit.maxRequests} req / ${
        humanizeWindow(vk.rateLimit.windowMs)
      }`,
    );
  }
  if (vk.tokenLimit) {
    items.push(
      `${vk.tokenLimit.maxTokens} tok / ${
        humanizeWindow(vk.tokenLimit.windowMs)
      }`,
    );
  }
  return items;
}

export function VirtualKeysView() {
  const toast = useToast();
  const [keys, setKeys] = useState<VirtualKeyPublic[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [providers, setProviders] = useState<ProviderAccountPublic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const [search, setSearch] = useState("");
  const [customerFilter, setCustomerFilter] = useState("all");
  const [teamFilter, setTeamFilter] = useState("all");

  const [sheet, setSheet] = useState<
    { mode: "create" | "edit"; key?: VirtualKeyPublic } | null
  >(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<VirtualKeyPublic | null>(
    null,
  );

  const reload = useCallback(async () => {
    const [k, t, c, cfg] = await Promise.allSettled([
      getVirtualKeys(),
      getTeams(),
      getCustomers(),
      getConfig(),
    ]);
    if (k.status === "fulfilled") {
      setKeys(k.value);
      setError(null);
    } else {
      setError(k.reason instanceof Error ? k.reason.message : String(k.reason));
    }
    if (t.status === "fulfilled") {
      setTeams(t.value);
    }
    if (c.status === "fulfilled") {
      setCustomers(c.value);
    }
    if (cfg.status === "fulfilled") {
      setProviders(cfg.value.providers);
    }
    setLoaded(true);
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

  function onCreate(payload: VKPayload) {
    void run(async () => {
      const result = await createVirtualKey(payload);
      // Reveal state is the sole place the full token exists (security #13).
      setRevealed({
        name: result.name,
        token: result.token,
        tokenHint: result.tokenHint,
      });
      setSheet(null);
    });
  }

  function onEditSave(id: string, payload: VKPayload) {
    void run(() => updateVirtualKey(id, payload), () => {
      toast.success(`Virtual key "${payload.name ?? ""}" saved`);
      setSheet(null);
    });
  }

  function onConfirmDelete() {
    const target = confirmDelete;
    if (!target) {
      return;
    }
    void run(() => deleteVirtualKey(target.id), () => {
      toast.success(`Virtual key "${target.name}" deleted`);
      setConfirmDelete(null);
    });
  }

  function closeReveal() {
    const name = revealed?.name ?? "";
    setRevealed(null); // token forgotten from state and DOM (security #13)
    toast.success(`Virtual key "${name}" created`);
  }

  const teamsById = useMemo(
    () => new Map(teams.map((t) => [t.id, t])),
    [teams],
  );

  const customerOptions = useMemo<ComboboxOption[]>(
    () => [
      { value: "all", label: "All Customers" },
      ...customers.map((c) => ({ value: c.id, label: c.name })),
    ],
    [customers],
  );

  const teamOptions = useMemo<ComboboxOption[]>(
    () => [
      { value: "all", label: "All Teams" },
      ...teams.map((t) => ({ value: t.id, label: t.name })),
    ],
    [teams],
  );

  const visibleKeys = useMemo(() => {
    const q = search.trim().toLowerCase();
    return keys.filter((vk) => {
      if (q && !vk.name.toLowerCase().includes(q)) {
        return false;
      }
      if (teamFilter !== "all" && vk.teamId !== teamFilter) {
        return false;
      }
      if (customerFilter !== "all") {
        const team = vk.teamId ? teamsById.get(vk.teamId) : undefined;
        if (!team || team.customerId !== customerFilter) {
          return false;
        }
      }
      return true;
    });
  }, [keys, search, teamFilter, customerFilter, teamsById]);

  const csvColumns = useMemo<CsvColumn<VirtualKeyPublic>[]>(
    () => [
      { header: "Name", value: (vk) => vk.name },
      { header: "Assigned To", value: (vk) => assignedName(vk, teamsById) },
      { header: "Key", value: (vk) => vk.tokenHint },
      { header: "Budget", value: (vk) => budgetChips(vk.budget).join(" ") },
      { header: "Rate Limits", value: (vk) => rateLimitItems(vk).join(" ") },
      { header: "Status", value: (vk) => (vk.enabled ? "Active" : "Inactive") },
    ],
    [teamsById],
  );

  const columns: Column<VirtualKeyPublic>[] = [
    {
      key: "name",
      header: "Name",
      sortValue: (vk) => vk.name,
      cell: (vk) => (
        <span className="font-medium text-foreground">{vk.name}</span>
      ),
    },
    {
      key: "assigned",
      header: "Assigned To",
      cell: (vk) => {
        const name = assignedName(vk, teamsById);
        if (!name) {
          return <span className="text-muted-foreground">-</span>;
        }
        const known = !vk.teamId || teamsById.has(vk.teamId);
        return (
          <span className={known ? undefined : "text-warning"}>{name}</span>
        );
      },
    },
    {
      key: "key",
      header: "Key",
      cell: (vk) => (
        <MaskedSecretCell
          value={vk.tokenHint}
          label={vk.name || "virtual key"}
        />
      ),
    },
    {
      key: "budget",
      header: "Budget",
      sortValue: (vk) => vk.budget?.maxCostUsd ?? vk.budget?.maxRequests ?? 0,
      cell: (vk) => <Chips items={budgetChips(vk.budget)} />,
    },
    {
      key: "rate",
      header: "Rate Limits",
      cell: (vk) => <Chips items={rateLimitItems(vk)} />,
    },
    {
      // Not sortable on purpose: a sort button here would take the accessible
      // name "Status" and collide with the pinned "Status" nav leaf.
      key: "status",
      header: "Status",
      cell: (vk) => (
        <Badge tone={vk.enabled ? "ok" : "muted"}>
          {vk.enabled ? "Active" : "Inactive"}
        </Badge>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Virtual Keys"
        subtitle="Manage virtual keys, their permissions, budgets, and rate limits."
        actions={
          <>
            <ExportButton
              rows={visibleKeys}
              columns={csvColumns}
              filename="virtual-keys.csv"
              disabled={!loaded}
            />
            <Button onClick={() => setSheet({ mode: "create" })}>
              <Plus aria-hidden="true" />
              Add Virtual Key
            </Button>
          </>
        }
      />

      {error && <Banner tone="error" className="mb-4">{error}</Banner>}

      {!loaded ? <TableSkeleton cols={7} /> : keys.length === 0
        ? (
          <EmptyState
            icon={KeyRound}
            title="No virtual keys"
            body="Inference is open until the first key exists. Create a key to turn governance on and start metering usage."
            action={
              <Button onClick={() => setSheet({ mode: "create" })}>
                <Plus aria-hidden="true" />
                Add Virtual Key
              </Button>
            }
          />
        )
        : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-0 flex-1 sm:max-w-xs">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  aria-label="Search by key name"
                  placeholder="Search by name..."
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="pl-9"
                />
              </div>
              <Combobox
                className="w-full sm:w-48"
                label="Filter by customer"
                options={customerOptions}
                value={customerFilter}
                onChange={setCustomerFilter}
                placeholder="All Customers"
              />
              <Combobox
                className="w-full sm:w-44"
                label="Filter by team"
                options={teamOptions}
                value={teamFilter}
                onChange={setTeamFilter}
                placeholder="All Teams"
              />
            </div>

            <DataTable<VirtualKeyPublic>
              caption="Virtual key list"
              rows={visibleKeys}
              getRowId={(vk) => vk.id}
              columns={columns}
              pageSize={PAGE_SIZE}
              minWidth="60rem"
              empty="No virtual keys match your filters."
              rowMenuLabel="Row actions"
              rowMenu={(vk) => (
                <div className="flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit ${vk.name}`}
                    disabled={busy}
                    onClick={() => setSheet({ mode: "edit", key: vk })}
                  >
                    <SquarePen aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${vk.name}`}
                    disabled={busy}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setConfirmDelete(vk)}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              )}
            />
          </div>
        )}

      <Sheet
        open={sheet !== null}
        onClose={() => setSheet(null)}
        title={sheet?.mode === "edit"
          ? "Edit Virtual Key"
          : "Create Virtual Key"}
        description={sheet?.mode === "edit"
          ? "Update this virtual key's permissions, budgets, and rate limits."
          : "Create a new virtual key with specific permissions, budgets, and rate limits."}
      >
        {sheet && (
          <VKForm
            mode={sheet.mode}
            initial={sheet.key}
            providers={providers}
            busy={busy}
            onCancel={() => setSheet(null)}
            onCreate={onCreate}
            onSave={onEditSave}
          />
        )}
      </Sheet>

      {revealed && (
        <TokenRevealDialog
          revealed={revealed}
          onCopied={() => toast.success("Token copied to clipboard")}
          onDone={closeReveal}
        />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={onConfirmDelete}
        title={`Delete virtual key "${confirmDelete?.name ?? ""}"?`}
        confirmLabel="Delete key"
        pending={busy}
        body={
          <div className="flex flex-col gap-2">
            <p>
              Clients using this key are refused immediately. The token cannot
              be recovered.
            </p>
            {keys.length === 1 && (
              <p className="text-warning">
                This is the last virtual key - deleting it turns governance off
                and reopens inference to unauthenticated traffic.
              </p>
            )}
          </div>
        }
      />
    </div>
  );
}

/* --------------------------- token reveal (#13) ------------------------ */

function TokenRevealDialog(
  { revealed, onCopied, onDone }: {
    revealed: Revealed;
    onCopied: () => void;
    onDone: () => void;
  },
) {
  // Not dismissible: overlay click and Escape cannot close it, so the token is
  // never dismissed by accident and is forgotten only via the Done control.
  const ref = useModal(true, onDone, false);
  return (
    <div className="fixed inset-0 z-(--z-modal) flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/40" aria-hidden="true" />
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-label="Virtual key created"
        tabIndex={-1}
        className="relative z-10 flex w-full max-w-md flex-col gap-3 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-lg outline-none"
      >
        <div className="flex items-center gap-2">
          <TriangleAlert aria-hidden="true" className="size-5 text-warning" />
          <h2 className="text-lg font-semibold">Virtual key created</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          This token is shown once and never again. Frosty keeps only the hint
          {" "}
          <span className="font-mono">{revealed.tokenHint}</span>.
        </p>
        <code className="block w-full select-all break-all rounded-md border border-border bg-background px-3 py-2 font-mono text-sm">
          {revealed.token}
        </code>
        <div className="flex items-center justify-between gap-2">
          <CopyButton
            value={revealed.token}
            label="Copy token"
            onCopied={onCopied}
          />
          <Button onClick={onDone}>Done</Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- form ---------------------------------- */

/** Sentinel tag meaning "no model restriction"; persisted as `undefined`. */
const ALL_MODELS = "all";

function VKForm(
  { mode, initial, providers, busy, onCancel, onCreate, onSave }: {
    mode: "create" | "edit";
    initial?: VirtualKeyPublic;
    providers: ProviderAccountPublic[];
    busy: boolean;
    onCancel: () => void;
    onCreate: (payload: VKPayload) => void;
    onSave: (id: string, payload: VKPayload) => void;
  },
) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(keyDescription(initial));
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [providerIds, setProviderIds] = useState<string[]>(
    initial?.allowedProviders ?? [],
  );
  const [selectedModels, setSelectedModels] = useState<string[]>(() =>
    initial?.allowedModels && initial.allowedModels.length > 0
      ? initial.allowedModels
      : [ALL_MODELS]
  );
  const [maxTokens, setMaxTokens] = useState(
    initial?.tokenLimit ? String(initial.tokenLimit.maxTokens) : "",
  );
  const [tokenWindowMs, setTokenWindowMs] = useState(
    initial?.tokenLimit?.windowMs ?? DEFAULT_PERIOD_MS,
  );
  const [maxRequests, setMaxRequests] = useState(
    initial?.rateLimit ? String(initial.rateLimit.maxRequests) : "",
  );
  const [rateWindowMs, setRateWindowMs] = useState(
    initial?.rateLimit?.windowMs ?? DEFAULT_PERIOD_MS,
  );
  const [budget, setBudget] = useState<BudgetDraft>(() =>
    budgetToDraft(initial?.budget)
  );
  const [error, setError] = useState<string | null>(null);

  const providerOptions = useMemo<ComboboxOption[]>(
    () =>
      providers
        .filter((p) => p.enabled && !providerIds.includes(p.id))
        .map((p) => ({ value: p.id, label: p.id })),
    [providers, providerIds],
  );

  // Models advertised by the selected providers (the pickable universe). Kept
  // independent of the persisted allowlist so removing a provider never silently
  // drops an already-chosen model tag.
  const modelUniverse = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const p of providers) {
      if (providerIds.includes(p.id)) {
        for (const m of p.models) {
          set.add(m);
        }
      }
    }
    return [...set].sort();
  }, [providers, providerIds]);

  const concreteModels = selectedModels.filter((m) => m !== ALL_MODELS);
  const showModelPicker = providerIds.length > 0 || concreteModels.length > 0;

  const modelOptions = useMemo<ComboboxOption[]>(() => {
    const opts: ComboboxOption[] = [{ value: ALL_MODELS, label: "All models" }];
    for (const m of modelUniverse) {
      if (!selectedModels.includes(m)) {
        opts.push({ value: m, label: m });
      }
    }
    return opts;
  }, [modelUniverse, selectedModels]);

  function addProvider(id: string) {
    setProviderIds((current) =>
      current.includes(id) ? current : [...current, id]
    );
  }

  function addModel(id: string) {
    if (id === ALL_MODELS) {
      setSelectedModels([ALL_MODELS]);
      return;
    }
    setSelectedModels((current) => {
      const next = current.filter((m) => m !== ALL_MODELS);
      return next.includes(id) ? next : [...next, id];
    });
  }

  function removeModel(id: string) {
    setSelectedModels((current) => {
      const next = current.filter((m) => m !== id);
      return next.length > 0 ? next : [ALL_MODELS];
    });
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    const mt = numOrUndef(maxTokens);
    if (maxTokens.trim() && (mt === undefined || mt <= 0)) {
      setError("Maximum tokens must be a positive number.");
      return;
    }
    const mr = numOrUndef(maxRequests);
    if (maxRequests.trim() && (mr === undefined || mr <= 0)) {
      setError("Maximum requests must be a positive number.");
      return;
    }
    const budgetIssue = budgetError(budget);
    if (budgetIssue) {
      setError(budgetIssue);
      return;
    }
    setError(null);

    const payload: VKPayload = {
      name: trimmed,
      enabled,
      description: description.trim(),
    };
    if (mt !== undefined) {
      payload.tokenLimit = { maxTokens: mt, windowMs: tokenWindowMs };
    }
    if (mr !== undefined) {
      payload.rateLimit = { maxRequests: mr, windowMs: rateWindowMs };
    }
    const budgetPayload = budgetToPayload(budget);
    if (budgetPayload) {
      payload.budget = budgetPayload;
    }
    const models = selectedModels.filter((m) => m !== ALL_MODELS);
    if (mode === "edit") {
      payload.allowedProviders = providerIds.length > 0 ? providerIds : null;
      payload.allowedModels = models.length > 0 ? models : null;
    } else {
      if (providerIds.length > 0) {
        payload.allowedProviders = providerIds;
      }
      if (models.length > 0) {
        payload.allowedModels = models;
      }
    }

    if (mode === "edit" && initial) {
      onSave(initial.id, payload);
    } else {
      onCreate(payload);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <Field id="vk-name" label="Name" required>
        <Input
          id="vk-name"
          value={name}
          placeholder="e.g., Production API Key"
          onChange={(event) => setName(event.target.value)}
        />
      </Field>

      <Field id="vk-description" label="Description">
        <Textarea
          id="vk-description"
          rows={3}
          value={description}
          placeholder="This key is used for..."
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>

      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="vk-active">Is this key active?</Label>
        <Switch
          id="vk-active"
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label="Is this key active?"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="vk-providers">Provider Configurations</Label>
          <Info
            aria-hidden="true"
            className="size-3.5 text-muted-foreground"
            aria-label="Providers this key may route to"
          />
        </div>
        <Combobox
          id="vk-providers"
          label="Provider Configurations"
          options={providerOptions}
          value={null}
          onChange={addProvider}
          placeholder="Select a provider to add"
          emptyText="No providers to add."
        />
        {providerIds.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {providerIds.map((id) => (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-sm border border-border bg-muted px-1.5 py-0.5 text-xs text-foreground"
              >
                {id}
                <button
                  type="button"
                  aria-label={`Remove ${id}`}
                  onClick={() =>
                    setProviderIds((current) =>
                      current.filter((p) => p !== id)
                    )}
                  className="hit-target -mr-0.5 inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground [&_svg]:size-3"
                >
                  <X aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {showModelPicker && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <Label htmlFor="vk-models">Allowed models</Label>
            <Info
              aria-hidden="true"
              className="size-3.5 text-muted-foreground"
              aria-label="Models this key may call; 'all' allows any model"
            />
          </div>
          <Combobox
            id="vk-models"
            label="Allowed models"
            options={modelOptions}
            value={null}
            onChange={addModel}
            placeholder="Search models to allow"
            emptyText="No models advertised by the selected providers."
          />
          <div className="flex flex-wrap gap-1.5 pt-1">
            {selectedModels.map((m) => (
              <span
                key={m}
                className="inline-flex items-center gap-1 rounded-sm border border-border bg-muted px-1.5 py-0.5 text-xs text-foreground"
              >
                {m === ALL_MODELS ? "All models" : m}
                {m !== ALL_MODELS && (
                  <button
                    type="button"
                    aria-label={`Remove ${m}`}
                    onClick={() => removeModel(m)}
                    className="hit-target -mr-0.5 inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground [&_svg]:size-3"
                  >
                    <X aria-hidden="true" />
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      <div
        className="border-t border-dashed border-border"
        aria-hidden="true"
      />

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-foreground">
            Budget Configuration
          </p>
          {!budget.on && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setBudget({ ...budget, on: true })}
            >
              <Plus aria-hidden="true" />
              Add Budget
            </Button>
          )}
        </div>
        {budget.on
          ? (
            <div className="flex flex-col gap-3 rounded-md border border-border p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="vk-budget-cost" label="Max Budget (EUR)">
                  <Input
                    id="vk-budget-cost"
                    type="number"
                    min="0"
                    step="0.01"
                    value={budget.maxCostUsd}
                    placeholder="100.00"
                    onChange={(event) =>
                      setBudget({ ...budget, maxCostUsd: event.target.value })}
                  />
                </Field>
                <Field id="vk-budget-req" label="Max Requests">
                  <Input
                    id="vk-budget-req"
                    type="number"
                    min="1"
                    value={budget.maxRequests}
                    placeholder="1000"
                    onChange={(event) =>
                      setBudget({ ...budget, maxRequests: event.target.value })}
                  />
                </Field>
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setBudget(emptyBudgetDraft())}
                >
                  <Trash2 aria-hidden="true" />
                  Remove budget
                </Button>
              </div>
            </div>
          )
          : (
            <div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              No budget limits configured.
            </div>
          )}
      </div>

      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium text-foreground">
          Rate Limiting Configuration
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="vk-max-tokens" label="Maximum Tokens">
            <Input
              id="vk-max-tokens"
              type="number"
              min="1"
              value={maxTokens}
              placeholder="100"
              onChange={(event) => setMaxTokens(event.target.value)}
            />
          </Field>
          <Field id="vk-token-period" label="Reset Period">
            <NativeSelect
              id="vk-token-period"
              value={String(tokenWindowMs)}
              onChange={(event) => setTokenWindowMs(Number(event.target.value))}
            >
              {periodOptions(tokenWindowMs).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="vk-max-requests" label="Maximum Requests">
            <Input
              id="vk-max-requests"
              type="number"
              min="1"
              value={maxRequests}
              placeholder="100"
              onChange={(event) => setMaxRequests(event.target.value)}
            />
          </Field>
          <Field id="vk-request-period" label="Reset Period">
            <NativeSelect
              id="vk-request-period"
              value={String(rateWindowMs)}
              onChange={(event) => setRateWindowMs(Number(event.target.value))}
            >
              {periodOptions(rateWindowMs).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" isLoading={busy}>
          {mode === "edit" ? "Save changes" : "Create"}
        </Button>
      </div>
    </form>
  );
}
