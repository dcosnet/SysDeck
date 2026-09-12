import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  exportConfig,
  getConfig,
  importConfig,
  reloadConfig,
  setDefaultProvider,
} from "../../api";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import { Banner } from "../ui/banner";
import { Field, Label } from "../ui/label";
import { Textarea } from "../ui/input";
import { NativeSelect } from "../ui/select";
import { ConfirmDialog } from "../ui/dialog";
import { CopyButton } from "../ui/copy-button";
import { PanelSkeleton } from "../ui/skeleton";
import { useToast } from "../ui/toast";

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

function isStoreOff(err: unknown): boolean {
  return err instanceof ApiError && err.status === 400 &&
    err.message.includes("No persistent config store");
}

interface ImportInspection {
  data: unknown;
  count: number;
  incomingDefault: string | undefined;
}

/** Client-side shape/size guard (security #20); the server re-validates. */
function inspectImport(text: string): ImportInspection | { error: string } {
  if (text.length > MAX_IMPORT_BYTES) {
    return { error: "Pasted JSON is too large (over 2 MB)." };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "Not valid JSON." };
  }
  const root = data as {
    config?: unknown;
    providers?: unknown;
    defaultProvider?: unknown;
  };
  const config = (root.config ?? root) as {
    providers?: unknown;
    defaultProvider?: unknown;
  };
  if (!Array.isArray(config.providers)) {
    return { error: "Missing config.providers - is this a Frosty export?" };
  }
  return {
    data,
    count: config.providers.length,
    incomingDefault: typeof config.defaultProvider === "string"
      ? config.defaultProvider
      : undefined,
  };
}

export function ConfigPanel() {
  const toast = useToast();
  const [providerIds, setProviderIds] = useState<string[]>([]);
  const [currentDefault, setCurrentDefault] = useState("");
  const [selectedDefault, setSelectedDefault] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [storeOff, setStoreOff] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);

  const [contents, setContents] = useState<"redacted" | "secrets">("redacted");
  const [confirmSecrets, setConfirmSecrets] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  const [importText, setImportText] = useState("");
  const [confirmImport, setConfirmImport] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const config = await getConfig();
      setProviderIds(config.providers.map((p) => p.id));
      setCurrentDefault(config.defaultProvider ?? "");
      setSelectedDefault(config.defaultProvider ?? "");
    } catch {
      // handled by the standard banner in downstream actions
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function saveDefault() {
    setSavingDefault(true);
    setDefaultProvider(selectedDefault || undefined)
      .then(() => {
        setCurrentDefault(selectedDefault);
        toast.success("Default provider updated");
      })
      .catch((err) =>
        toast.error(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setSavingDefault(false));
  }

  async function doPreview() {
    try {
      const data = await exportConfig(false); // redacted only (security #15)
      setPreview(JSON.stringify(data, null, 2));
    } catch (err) {
      if (isStoreOff(err)) {
        setStoreOff(true);
        return;
      }
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function doDownload() {
    try {
      // The secret-bearing body is a local const: never stored in state or DOM
      // and dropped when this function returns (security #15).
      const data = await exportConfig(contents === "secrets");
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `frosty-config-${
        new Date().toISOString().slice(0, 10)
      }.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success(
        contents === "secrets"
          ? "Export downloaded. Treat it like a password file."
          : "Export downloaded",
      );
    } catch (err) {
      if (isStoreOff(err)) {
        setStoreOff(true);
        return;
      }
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function onSelectContents(value: string) {
    if (value === "secrets") {
      setConfirmSecrets(true); // gated by explicit warning (security #15)
    } else {
      setContents("redacted");
    }
  }

  function readFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => setImportText(String(reader.result ?? ""));
    reader.readAsText(file);
  }

  const inspection = importText.trim() ? inspectImport(importText) : null;
  const importError = inspection && "error" in inspection
    ? inspection.error
    : null;
  const importReady = inspection !== null && !("error" in inspection);

  function doImport() {
    if (!inspection || "error" in inspection) {
      return;
    }
    const payload = inspection.data;
    setConfirmImport(false);
    importConfig(payload)
      .then((res) => {
        toast.success(`Imported ${res.providers} providers`);
        setImportText("");
        void load();
      })
      .catch((err) => {
        if (isStoreOff(err)) {
          setStoreOff(true);
          return;
        }
        toast.error(err instanceof Error ? err.message : String(err));
      });
  }

  function doReload() {
    setConfirmReload(false);
    reloadConfig()
      .then((res) => {
        toast.success(`Config reloaded - ${res.providers} providers`);
        void load();
      })
      .catch((err) => {
        if (isStoreOff(err)) {
          setStoreOff(true);
          return;
        }
        toast.error(err instanceof Error ? err.message : String(err));
      });
  }

  const importSummary = inspection && !("error" in inspection)
    ? inspection
    : null;

  return (
    <div>
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Default provider</CardTitle>
        </CardHeader>
        <CardContent>
          {!loaded
            ? <PanelSkeleton />
            : (
              <div className="flex flex-wrap items-end gap-3">
                <Field
                  id="default-provider"
                  label="Default provider"
                  className="min-w-56"
                >
                  <NativeSelect
                    id="default-provider"
                    value={selectedDefault}
                    onChange={(e) => setSelectedDefault(e.target.value)}
                  >
                    <option value="">None</option>
                    {providerIds.map((id) => (
                      <option key={id} value={id}>{id}</option>
                    ))}
                  </NativeSelect>
                </Field>
                <Button
                  disabled={selectedDefault === currentDefault || savingDefault}
                  isLoading={savingDefault}
                  onClick={saveDefault}
                >
                  Save
                </Button>
              </div>
            )}
        </CardContent>
      </Card>

      {storeOff
        ? (
          <Banner tone="info" className="mb-6">
            No persistent config store attached - export, import and reload need
            a gateway started with FROSTY_PG_URL pointing at a reachable
            PostgreSQL.
          </Banner>
        )
        : (
          <>
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>Export</CardTitle>
              </CardHeader>
              <CardContent>
                <fieldset className="flex flex-col gap-2">
                  <Label>Contents</Label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="export-contents"
                      className="accent-primary"
                      checked={contents === "redacted"}
                      onChange={() => onSelectContents("redacted")}
                    />
                    Redacted (safe to share)
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="export-contents"
                      className="accent-primary"
                      checked={contents === "secrets"}
                      onChange={() => onSelectContents("secrets")}
                    />
                    Include secrets
                  </label>
                </fieldset>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={contents === "secrets"}
                    title={contents === "secrets"
                      ? "Preview shows the redacted export only"
                      : undefined}
                    onClick={doPreview}
                  >
                    Preview
                  </Button>
                  <Button onClick={doDownload}>Download</Button>
                </div>
                {preview !== null && (
                  <div className="mt-4">
                    <div className="mb-2 flex justify-end">
                      <CopyButton value={preview} label="Copy JSON" />
                    </div>
                    <pre className="max-h-72 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs">
                      <code>{preview}</code>
                    </pre>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="mb-6">
              <CardHeader>
                <CardTitle>Import</CardTitle>
              </CardHeader>
              <CardContent>
                {
                  /* measure-capped: a JSON paste area stretched to the full
                    container width makes long lines unscannable and the
                    caret hard to find. */
                }
                <Field id="import-json" label="Paste JSON" className="measure">
                  <Textarea
                    id="import-json"
                    rows={8}
                    className="font-mono"
                    value={importText}
                    aria-invalid={importError ? true : undefined}
                    onChange={(e) => setImportText(e.target.value)}
                  />
                </Field>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/json"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        readFile(file);
                      }
                    }}
                  />
                  <Button
                    variant="outline"
                    onClick={() => fileRef.current?.click()}
                  >
                    Choose file...
                  </Button>
                  <Button
                    disabled={!importReady}
                    onClick={() => setConfirmImport(true)}
                  >
                    Import...
                  </Button>
                </div>
                {importError && (
                  <p className="mt-2 text-sm text-destructive" role="alert">
                    {importError}
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Reload</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-3 text-sm text-muted-foreground">
                  Re-read providers, governance and MCP config from PostgreSQL,
                  discarding runtime-only state.
                </p>
                <Button
                  variant="outline"
                  onClick={() => setConfirmReload(true)}
                >
                  Reload from store
                </Button>
              </CardContent>
            </Card>
          </>
        )}

      <ConfirmDialog
        open={confirmSecrets}
        onClose={() => setConfirmSecrets(false)}
        onConfirm={() => {
          setContents("secrets");
          setConfirmSecrets(false);
        }}
        title="Export secrets?"
        confirmLabel="Export with secrets"
        body="The file will contain plaintext API keys and cloud credentials. Treat it like a password file."
      />

      <ConfirmDialog
        open={confirmImport}
        onClose={() => setConfirmImport(false)}
        onConfirm={doImport}
        title="Replace configuration?"
        confirmLabel="Import and replace"
        body={importSummary
          ? `Import replaces all ${providerIds.length} provider(s) with ${importSummary.count} from this file and sets the default provider to "${
            importSummary.incomingDefault ?? "none"
          }". Current providers not present in the file are removed, including their stored keys.`
          : ""}
      />

      <ConfirmDialog
        open={confirmReload}
        onClose={() => setConfirmReload(false)}
        onConfirm={doReload}
        title="Reload configuration from store?"
        confirmLabel="Reload"
        destructive={false}
        body="Any provider changes made only in memory are discarded."
      />
    </div>
  );
}
