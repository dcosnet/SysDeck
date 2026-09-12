import { useCallback, useEffect, useRef, useState } from "react";
import { CircleDollarSign, Plus, Trash2 } from "lucide-react";
import { getPricing, type ModelPrice, putPricing } from "../api";
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
import { Input } from "../components/ui/input";
import { ConfirmDialog } from "../components/ui/dialog";
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
import { ensureEurRate, eurToUsd, usdToEur } from "../lib/currency";

interface PriceRow {
  key: number;
  model: string;
  input: string;
  output: string;
}

function toRows(prices: Record<string, ModelPrice>, seed: number): PriceRow[] {
  return Object.entries(prices)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, price], i) => ({
      key: seed + i,
      model,
      // Prices are stored as canonical USD; the operator edits them in euros.
      input: String(usdToEur(price.inputPerMTokUsd)),
      output: String(usdToEur(price.outputPerMTokUsd)),
    }));
}

function validNumber(value: string): boolean {
  if (!value.trim()) {
    return false;
  }
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
}

export function PricingView() {
  const toast = useToast();
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [savedModels, setSavedModels] = useState<Set<string>>(new Set());
  const [snapshot, setSnapshot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);
  const seedRef = useRef(1);
  const lastRowRef = useRef<HTMLInputElement>(null);
  const focusLastRef = useRef(false);

  const load = useCallback(async () => {
    await ensureEurRate().catch(() => {});
    try {
      const prices = await getPricing();
      const seed = seedRef.current;
      seedRef.current += Object.keys(prices).length + 1;
      const nextRows = toRows(prices, seed);
      setRows(nextRows);
      setSavedModels(new Set(Object.keys(prices)));
      setSnapshot(
        JSON.stringify(nextRows.map((r) => [r.model, r.input, r.output])),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (focusLastRef.current) {
      focusLastRef.current = false;
      lastRowRef.current?.focus();
    }
  }, [rows]);

  const current = JSON.stringify(rows.map((r) => [r.model, r.input, r.output]));
  const dirty = current !== snapshot;

  const trimmedModels = rows.map((r) => r.model.trim());
  const duplicateModels = new Set(
    trimmedModels.filter((m, i) => m && trimmedModels.indexOf(m) !== i),
  );
  const valid = rows.length > 0 &&
    rows.every((r) =>
      r.model.trim() && validNumber(r.input) && validNumber(r.output) &&
      !duplicateModels.has(r.model.trim())
    );

  function updateRow(key: number, patch: Partial<PriceRow>) {
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, ...patch } : r))
    );
  }

  function addRow() {
    const key = seedRef.current++;
    focusLastRef.current = true;
    setRows((prev) => [...prev, { key, model: "", input: "", output: "" }]);
  }

  function removeRow(key: number) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }

  const removedCount = [...savedModels].filter(
    (m) => !rows.some((r) => r.model.trim() === m),
  ).length;

  function save() {
    const prices: Record<string, ModelPrice> = {};
    for (const row of rows) {
      prices[row.model.trim()] = {
        // The operator types euros; store canonical USD per million tokens.
        inputPerMTokUsd: eurToUsd(Number(row.input)),
        outputPerMTokUsd: eurToUsd(Number(row.output)),
      };
    }
    setBusy(true);
    setConfirmSave(false);
    putPricing(prices)
      .then((res) => {
        const nextRows = toRows(res.prices, seedRef.current);
        seedRef.current += Object.keys(res.prices).length + 1;
        setRows(nextRows);
        setSavedModels(new Set(Object.keys(res.prices)));
        setSnapshot(
          JSON.stringify(nextRows.map((r) => [r.model, r.input, r.output])),
        );
        setError(null);
        toast.success(
          `Pricing saved - ${Object.keys(res.prices).length} models`,
        );
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        toast.error(message);
      })
      .finally(() => setBusy(false));
  }

  function onSaveClick() {
    if (removedCount > 0) {
      setConfirmSave(true);
    } else {
      save();
    }
  }

  const saveTitle = !dirty
    ? "No unsaved changes"
    : !valid
    ? "Fix invalid rows first"
    : undefined;

  return (
    <div>
      <PageHeader
        title="Pricing"
        subtitle="Per-model token prices in EUR per million tokens"
        actions={
          <Button
            disabled={!dirty || !valid || busy}
            isLoading={busy}
            title={saveTitle}
            onClick={onSaveClick}
          >
            Save pricing
          </Button>
        }
      />

      {error && <Banner tone="error" className="mb-4">{error}</Banner>}

      <Card>
        <CardHeader>
          <CardTitle>Model pricing</CardTitle>
          <span className="text-sm text-muted-foreground">
            Unpriced models bill €0 against budgets and cost metrics. Saving
            replaces the entire catalog.
          </span>
        </CardHeader>
        <CardContent>
          {!loaded ? <TableSkeleton cols={4} /> : rows.length === 0
            ? (
              <EmptyState
                icon={CircleDollarSign}
                title="No prices configured"
                body="Cost budgets and the cost counter treat unpriced models as €0. Add rows for the models you route."
                action={<Button onClick={addRow}>Add price row</Button>}
              />
            )
            : (
              <ScrollContainer label="Model pricing" minWidth="36rem">
                <Table>
                  <TableCaption>Model pricing</TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model</TableHead>
                      <TableHead className="text-right">Input €/MTok</TableHead>
                      <TableHead className="text-right">
                        Output €/MTok
                      </TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row, index) => {
                      const dup = row.model.trim() !== "" &&
                        duplicateModels.has(row.model.trim());
                      return (
                        <TableRow key={row.key}>
                          <TableCell>
                            <Input
                              ref={index === rows.length - 1
                                ? lastRowRef
                                : undefined}
                              aria-label={`Model ${index + 1}`}
                              className="font-mono"
                              aria-invalid={dup || undefined}
                              value={row.model}
                              onChange={(e) =>
                                updateRow(row.key, { model: e.target.value })}
                            />
                            {dup && (
                              <p className="mt-1 text-xs text-destructive">
                                Duplicate model id.
                              </p>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Input
                              aria-label={`Input price ${index + 1}`}
                              type="number"
                              min="0"
                              step="0.01"
                              className="text-right font-mono"
                              value={row.input}
                              onChange={(e) =>
                                updateRow(row.key, { input: e.target.value })}
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            <Input
                              aria-label={`Output price ${index + 1}`}
                              type="number"
                              min="0"
                              step="0.01"
                              className="text-right font-mono"
                              value={row.output}
                              onChange={(e) =>
                                updateRow(row.key, { output: e.target.value })}
                            />
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Remove ${
                                row.model.trim() || `row ${index + 1}`
                              }`}
                              onClick={() => removeRow(row.key)}
                            >
                              <Trash2 />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </ScrollContainer>
            )}

          {rows.length > 0 && (
            <div className="mt-4">
              <Button variant="outline" size="sm" onClick={addRow}>
                <Plus />
                Add price row
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmSave}
        onClose={() => setConfirmSave(false)}
        onConfirm={save}
        title={`Save removes ${removedCount} priced model(s)`}
        confirmLabel="Save pricing"
        destructive={false}
        body="Removed models bill €0 from now on."
      />
    </div>
  );
}
