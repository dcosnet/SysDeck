import { useCallback, useEffect, useState } from "react";
import { Building2, RefreshCw } from "lucide-react";
import {
  type Budget,
  createCustomer,
  type Customer,
  deleteCustomer,
  getCustomers,
  getTeams,
  type Team,
  updateCustomer,
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

export function CustomersView() {
  const toast = useToast();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<
    { mode: "create" | "edit"; customer?: Customer } | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState<Customer | null>(null);

  const reload = useCallback(async () => {
    await ensureEurRate().catch(() => {});
    const [c, t] = await Promise.allSettled([getCustomers(), getTeams()]);
    if (c.status === "fulfilled") {
      setCustomers(c.value);
      setError(null);
    } else {
      setError(c.reason instanceof Error ? c.reason.message : String(c.reason));
    }
    if (t.status === "fulfilled") {
      setTeams(t.value);
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
    void run(() => deleteCustomer(target.id), () => {
      toast.success(`Customer "${target.name}" deleted`);
      setConfirmDelete(null);
    });
  }

  const teamCount = (customerId: string) =>
    teams.filter((t) => t.customerId === customerId).length;
  const deleteRefs = confirmDelete ? teamCount(confirmDelete.id) : 0;

  return (
    <div>
      <PageHeader
        title="Customers"
        subtitle="Top-level budget rollups above teams"
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
              New customer
            </Button>
          </>
        }
      />

      {error && <Banner tone="error" className="mb-4">{error}</Banner>}

      <Card>
        <CardHeader>
          <CardTitle>Customers</CardTitle>
        </CardHeader>
        <CardContent>
          {!loaded
            ? <TableSkeleton cols={6} />
            : customers.length === 0
            ? (
              <EmptyState
                icon={Building2}
                title="No customers yet"
                body="Customers cap spending across every team assigned to them."
                action={
                  <Button onClick={() => setDialog({ mode: "create" })}>
                    New customer
                  </Button>
                }
              />
            )
            : (
              <ScrollContainer label="Customers" minWidth="44rem">
                <Table>
                  <TableCaption>Customers</TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Teams</TableHead>
                      <TableHead>Budget</TableHead>
                      <TableHead>Used</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {customers.map((customer) => (
                      <TableRow key={customer.id}>
                        <TableCell>{customer.name}</TableCell>
                        <TableCell>
                          <StatusBadge enabled={customer.enabled} />
                        </TableCell>
                        <TableCell className="font-mono">
                          {teamCount(customer.id)}
                        </TableCell>
                        <TableCell>
                          <Chips items={budgetChips(customer.budget)} />
                        </TableCell>
                        <TableCell className="font-mono whitespace-nowrap">
                          {customer.usedRequests} req · {formatEurFromMicroUsd(
                            customer.usedCostMicroUsd,
                            4,
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1.5">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() =>
                                setDialog({ mode: "edit", customer })}
                            >
                              Edit
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={busy}
                              onClick={() => setConfirmDelete(customer)}
                            >
                              Delete customer
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
        <CustomerDialog
          mode={dialog.mode}
          initial={dialog.customer}
          busy={busy}
          onClose={() => setDialog(null)}
          onCreate={(payload) =>
            void run(() => createCustomer(payload), () => {
              toast.success(`Customer "${payload.name}" created`);
              setDialog(null);
            })}
          onSave={(id, patch, name) =>
            void run(() => updateCustomer(id, patch), () => {
              toast.success(`Customer "${name}" saved`);
              setDialog(null);
            })}
        />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={onConfirmDelete}
        title={`Delete customer "${confirmDelete?.name ?? ""}"?`}
        confirmLabel="Delete customer"
        pending={busy}
        body={`${deleteRefs} team(s) reference this customer and keep a dangling link until reassigned.`}
      />
    </div>
  );
}

function CustomerDialog(
  { mode, initial, busy, onClose, onCreate, onSave }: {
    mode: "create" | "edit";
    initial?: Customer;
    busy: boolean;
    onClose: () => void;
    onCreate: (
      payload: { name: string; enabled: boolean; budget?: Budget },
    ) => void;
    onSave: (
      id: string,
      patch: { name: string; enabled: boolean; budget?: Budget },
      name: string,
    ) => void;
  },
) {
  const [name, setName] = useState(initial?.name ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
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
        ? `Edit customer "${initial?.name ?? ""}"`
        : "New customer"}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} isLoading={busy}>
            {mode === "edit" ? "Save changes" : "Create customer"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field id="customer-name" label="Name" required>
          <Input
            id="customer-name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field id="customer-enabled" label="Enabled">
          <div className="flex h-9 items-center">
            <Switch
              id="customer-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Enabled"
            />
          </div>
        </Field>
        <BudgetField
          idPrefix="customer-budget"
          draft={budget}
          onChange={setBudget}
        />
        {error && <Banner tone="error">{error}</Banner>}
      </div>
    </Dialog>
  );
}
