import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Users } from "lucide-react";
import {
  type Budget,
  createTeam,
  type Customer,
  deleteTeam,
  getCustomers,
  getTeams,
  getVirtualKeys,
  type Team,
  updateTeam,
  type VirtualKeyPublic,
} from "../api";
import { PageHeader } from "../components/ui/page-header";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Banner } from "../components/ui/banner";
import { EmptyState } from "../components/ui/empty-state";
import { TableSkeleton } from "../components/ui/skeleton";
import { ConfirmDialog, Dialog } from "../components/ui/dialog";
import { Switch } from "../components/ui/switch";
import { Field } from "../components/ui/label";
import { Input } from "../components/ui/input";
import { NativeSelect } from "../components/ui/select";
import { useToast } from "../components/ui/toast";
import {
  ScrollContainer,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import {
  budgetChips,
  type BudgetDraft,
  budgetError,
  BudgetField,
  budgetToDraft,
  budgetToPayload,
  Chips,
  StatusBadge,
} from "../lib/governance";
import { ensureEurRate, formatEurFromMicroUsd } from "../lib/currency";

export function TeamsView() {
  const toast = useToast();
  const [teams, setTeams] = useState<Team[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [keys, setKeys] = useState<VirtualKeyPublic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<
    { mode: "create" | "edit"; team?: Team } | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState<Team | null>(null);

  const reload = useCallback(async () => {
    await ensureEurRate().catch(() => {});
    const [t, c, k] = await Promise.allSettled([
      getTeams(),
      getCustomers(),
      getVirtualKeys(),
    ]);
    if (t.status === "fulfilled") {
      setTeams(t.value);
      setError(null);
    } else {
      setError(t.reason instanceof Error ? t.reason.message : String(t.reason));
    }
    if (c.status === "fulfilled") {
      setCustomers(c.value);
    }
    if (k.status === "fulfilled") {
      setKeys(k.value);
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

  function onConfirmDelete() {
    const target = confirmDelete;
    if (!target) {
      return;
    }
    void run(() => deleteTeam(target.id), () => {
      toast.success(`Team "${target.name}" deleted`);
      setConfirmDelete(null);
    });
  }

  const customerNames = new Map(customers.map((c) => [c.id, c.name]));
  const keyCount = (teamId: string) =>
    keys.filter((vk) => vk.teamId === teamId).length;
  const deleteRefs = confirmDelete ? keyCount(confirmDelete.id) : 0;

  return (
    <div>
      <PageHeader
        title="Teams"
        subtitle="Shared budgets across virtual keys"
        actions={
          <>
            <Button
              variant="outline"
              size="icon"
              aria-label="Refresh"
              onClick={() => void reload()}
            >
              <RefreshCw />
            </Button>
            <Button onClick={() => setDialog({ mode: "create" })}>
              New team
            </Button>
          </>
        }
      />

      {error && <Banner tone="error" className="mb-4">{error}</Banner>}

      <Card>
        <CardHeader>
          <CardTitle>Teams</CardTitle>
        </CardHeader>
        <CardContent>
          {!loaded ? <TableSkeleton cols={7} /> : teams.length === 0
            ? (
              <EmptyState
                icon={Users}
                title="No teams yet"
                body="Teams group virtual keys under one budget and roll up to a customer."
                action={
                  <Button onClick={() => setDialog({ mode: "create" })}>
                    New team
                  </Button>
                }
              />
            )
            : (
              <ScrollContainer label="Teams" minWidth="52rem">
                <Table>
                  <TableCaption>Teams</TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Keys</TableHead>
                      <TableHead>Budget</TableHead>
                      <TableHead>Used</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {teams.map((team) => (
                      <TableRow key={team.id}>
                        <TableCell>{team.name}</TableCell>
                        <TableCell>
                          <StatusBadge enabled={team.enabled} />
                        </TableCell>
                        <TableCell>
                          {team.customerId
                            ? (customerNames.get(team.customerId) ?? (
                              <span
                                className="text-warning"
                                title="Customer no longer exists"
                              >
                                {team.customerId}
                              </span>
                            ))
                            : <span className="text-muted-foreground">-</span>}
                        </TableCell>
                        <TableCell className="font-mono">
                          {keyCount(team.id)}
                        </TableCell>
                        <TableCell>
                          <Chips items={budgetChips(team.budget)} />
                        </TableCell>
                        <TableCell className="font-mono whitespace-nowrap">
                          {team.usedRequests} req ·{" "}
                          {formatEurFromMicroUsd(team.usedCostMicroUsd, 4)}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1.5">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => setDialog({ mode: "edit", team })}
                            >
                              Edit
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={busy}
                              onClick={() => setConfirmDelete(team)}
                            >
                              Delete team
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollContainer>
            )}
        </CardContent>
      </Card>

      {dialog && (
        <TeamDialog
          mode={dialog.mode}
          initial={dialog.team}
          customers={customers}
          busy={busy}
          onClose={() => setDialog(null)}
          onCreate={(payload) =>
            void run(() => createTeam(payload), () => {
              toast.success(`Team "${payload.name}" created`);
              setDialog(null);
            })}
          onSave={(id, patch, name) =>
            void run(() => updateTeam(id, patch), () => {
              toast.success(`Team "${name}" saved`);
              setDialog(null);
            })}
        />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={onConfirmDelete}
        title={`Delete team "${confirmDelete?.name ?? ""}"?`}
        confirmLabel="Delete team"
        pending={busy}
        body={deleteRefs > 0
          ? `${deleteRefs} virtual key(s) reference this team. Their requests may be denied by the fail-closed hierarchy check until you reassign or clear their team.`
          : "No virtual keys reference this team."}
      />
    </div>
  );
}

function TeamDialog(
  { mode, initial, customers, busy, onClose, onCreate, onSave }: {
    mode: "create" | "edit";
    initial?: Team;
    customers: Customer[];
    busy: boolean;
    onClose: () => void;
    onCreate: (
      payload: {
        name: string;
        enabled: boolean;
        customerId?: string;
        budget?: Budget;
      },
    ) => void;
    onSave: (
      id: string,
      patch: {
        name: string;
        enabled: boolean;
        customerId?: string;
        budget?: Budget;
      },
      name: string,
    ) => void;
  },
) {
  const [name, setName] = useState(initial?.name ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [customerId, setCustomerId] = useState(initial?.customerId ?? "");
  const [budget, setBudget] = useState<BudgetDraft>(() =>
    budgetToDraft(initial?.budget)
  );
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    const budgetIssue = budgetError(budget);
    if (budgetIssue) {
      setError(budgetIssue);
      return;
    }
    const payload = {
      name: name.trim(),
      enabled,
      customerId: customerId || undefined,
      budget: budgetToPayload(budget),
    };
    if (mode === "edit" && initial) {
      onSave(initial.id, payload, payload.name);
    } else {
      onCreate(payload);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === "edit"
        ? `Edit team "${initial?.name ?? ""}"`
        : "New team"}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} isLoading={busy}>
            {mode === "edit" ? "Save changes" : "Create team"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field id="team-name" label="Name" required>
          <Input
            id="team-name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field id="team-enabled" label="Enabled">
          <div className="flex h-9 items-center">
            <Switch
              id="team-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Enabled"
            />
          </div>
        </Field>
        <Field id="team-customer" label="Customer">
          <NativeSelect
            id="team-customer"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
          >
            <option value="">No customer</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </NativeSelect>
        </Field>
        <BudgetField
          idPrefix="team-budget"
          draft={budget}
          onChange={setBudget}
        />
        {error && <Banner tone="error">{error}</Banner>}
      </div>
    </Dialog>
  );
}
