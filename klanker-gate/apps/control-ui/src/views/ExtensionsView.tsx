import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import {
  createMCPClient,
  deleteMCPClient,
  getMCPClients,
  getMCPHealth,
  getMCPTools,
  getPlugins,
  type MCPClientInput,
  type MCPClientView,
  type MCPHealthView,
  type MCPToolView,
  syncAllMCP,
  syncMCPClient,
  updateMCPClient,
} from "../api";
import { PageHeader } from "../components/ui/page-header";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Field, Label } from "../components/ui/label";
import { NativeSelect } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Sheet } from "../components/ui/sheet";
import { UnderlineTabs } from "../components/ui/nav-tabs";
import { Banner } from "../components/ui/banner";
import { EmptyState } from "../components/ui/empty-state";
import { TableSkeleton } from "../components/ui/skeleton";
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
import { relativeTime } from "../lib/utils";

const TRANSPORTS = ["http-sse", "streamable-http", "auto"] as const;

interface HeaderRow {
  name: string;
  value: string;
}

function HealthCell({ health }: { health?: MCPHealthView }) {
  if (!health) {
    return (
      <span
        className="text-muted-foreground"
        title="Health monitor unavailable"
      >
        -
      </span>
    );
  }
  const tone = health.status === "healthy"
    ? "ok"
    : health.status === "unhealthy"
    ? "err"
    : "muted";
  return (
    <span
      className="inline-flex items-center gap-1"
      title={health.lastError}
    >
      <Badge tone={tone}>{health.status}</Badge>
      {health.consecutiveFailures > 0 && (
        <sup className="text-2xs text-muted-foreground">
          ×{health.consecutiveFailures}
        </sup>
      )}
    </span>
  );
}

export function ExtensionsView() {
  const toast = useToast();
  const [clients, setClients] = useState<MCPClientView[]>([]);
  const [tools, setTools] = useState<MCPToolView[]>([]);
  const [health, setHealth] = useState<MCPHealthView[]>([]);
  const [plugins, setPlugins] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<MCPClientView | null>(null);
  // Draft for the edit sheet, reported up by EditMCPForm (no shared singleton).
  const [editDraft, setEditDraft] = useState<Partial<MCPClientInput>>({});
  const [tab, setTab] = useState("mcp-servers");

  // Add form
  const [formId, setFormId] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formTransport, setFormTransport] = useState<string>("http-sse");
  const [advanced, setAdvanced] = useState(false);
  const [formTimeout, setFormTimeout] = useState("");
  const [formHeaders, setFormHeaders] = useState<HeaderRow[]>([]);

  const reload = useCallback(async () => {
    const [c, t, p] = await Promise.allSettled([
      getMCPClients(),
      getMCPTools(),
      getPlugins(),
    ]);
    if (c.status === "fulfilled") setClients(c.value);
    if (t.status === "fulfilled") setTools(t.value);
    if (p.status === "fulfilled") setPlugins(p.value);
    const firstError = [c, t, p].find((r) => r.status === "rejected");
    setError(
      firstError && firstError.status === "rejected"
        ? (firstError.reason instanceof Error
          ? firstError.reason.message
          : String(firstError.reason))
        : null,
    );
    setLoaded(true);
  }, []);

  const reloadHealth = useCallback(async () => {
    try {
      setHealth(await getMCPHealth());
    } catch {
      setHealth([]);
    }
  }, []);

  const reloadRef = useRef({ reload, reloadHealth });
  reloadRef.current = { reload, reloadHealth };

  useEffect(() => {
    void reloadRef.current.reload();
    void reloadRef.current.reloadHealth();
    const timer = setInterval(
      () => void reloadRef.current.reloadHealth(),
      30_000,
    );
    return () => clearInterval(timer);
  }, []);

  const healthById = new Map(health.map((h) => [h.clientId, h]));

  async function run(action: () => Promise<unknown>, onOk?: () => void) {
    try {
      await action();
      await reload();
      await reloadHealth();
      onOk?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error(message);
    }
  }

  function onAdd(event: React.FormEvent) {
    event.preventDefault();
    const payload: MCPClientInput = {
      id: formId.trim(),
      url: formUrl.trim(),
      transport: formTransport,
      enabled: true,
    };
    if (formTimeout) payload.requestTimeoutMs = Number(formTimeout);
    const headers = Object.fromEntries(
      formHeaders.filter((h) => h.name.trim()).map((
        h,
      ) => [h.name.trim(), h.value]),
    );
    if (Object.keys(headers).length > 0) payload.headers = headers;
    void run(() => createMCPClient(payload), () => {
      toast.success(`MCP server "${payload.id}" added`);
      setFormId("");
      setFormUrl("");
      setFormTransport("http-sse");
      setFormTimeout("");
      setFormHeaders([]);
    });
  }

  function onRemove(client: MCPClientView) {
    const captured: MCPClientInput = {
      id: client.id,
      url: client.url,
      enabled: client.enabled,
      transport: client.transport,
      requestTimeoutMs: client.requestTimeoutMs,
    };
    const cannotSafelyRestore = client.headerNames.length > 0 ||
      client.hasCommand || client.hasUrlCredentials;
    void run(() => deleteMCPClient(client.id), () => {
      if (cannotSafelyRestore) {
        toast.success(`MCP server "${client.id}" removed`);
        return;
      }
      toast.success(`MCP server "${client.id}" removed`, {
        action: {
          label: "Undo",
          onClick: () =>
            void run(() => createMCPClient(captured), () => {
              toast.success(`MCP server "${client.id}" restored`);
            }),
        },
      });
    });
  }

  function onSync(client: MCPClientView) {
    void run(() => syncMCPClient(client.id), () => {
      toast.success(`Synced tools from "${client.id}"`);
    });
  }

  function onSyncAll() {
    void run(() => syncAllMCP(), () => toast.success("Synced MCP servers"));
  }

  return (
    <div>
      <PageHeader
        title="Extensions"
        subtitle="MCP servers, synced tools, and plugins"
        actions={
          <Button variant="outline" size="sm" onClick={onSyncAll}>
            <RefreshCw />
            Sync all
          </Button>
        }
      />

      <UnderlineTabs
        label="Extension sections"
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: "mcp-servers", label: "MCP servers" },
          { value: "tools", label: "Synced tools" },
          { value: "plugins", label: "Plugins" },
        ]}
        className="mb-4"
      />

      {error && <Banner tone="error" className="mb-4">{error}</Banner>}

      {tab === "mcp-servers" && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle id="mcp-servers">MCP servers</CardTitle>
          </CardHeader>
          <CardContent>
            {!loaded
              ? <TableSkeleton cols={7} />
              : clients.length === 0
              ? (
                <EmptyState
                  icon={Plus}
                  title="No MCP servers registered"
                  body="Register a server below to make its tools available to every chat completion."
                />
              )
              : (
                <ScrollContainer label="MCP servers" minWidth="52rem">
                  <Table>
                    <TableCaption>MCP servers</TableCaption>
                    <TableHeader>
                      <TableRow>
                        <TableHead>ID</TableHead>
                        <TableHead>URL</TableHead>
                        <TableHead>Transport</TableHead>
                        <TableHead>Tools</TableHead>
                        <TableHead>Health</TableHead>
                        <TableHead>Last sync</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {clients.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell className="font-mono">{c.id}</TableCell>
                          <TableCell
                            className="max-w-xs truncate font-mono"
                            title={c.url}
                          >
                            {c.url ?? "-"}
                          </TableCell>
                          <TableCell>{c.transport ?? "http-sse"}</TableCell>
                          <TableCell>{c.toolCount}</TableCell>
                          <TableCell>
                            <HealthCell health={healthById.get(c.id)} />
                          </TableCell>
                          <TableCell
                            className="text-muted-foreground"
                            title={c.lastSyncAt}
                          >
                            {relativeTime(c.lastSyncAt)}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1.5">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => onSync(c)}
                              >
                                Sync
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setEditing(c)}
                              >
                                Edit
                              </Button>
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => onRemove(c)}
                              >
                                Remove
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollContainer>
              )}

            <form
              onSubmit={onAdd}
              className="field-grid mt-5 border-t border-border pt-5"
            >
              <h4 className="col-span-full text-sm font-semibold">
                Add MCP server
              </h4>
              <Field id="mcp-id" label="ID" required>
                <Input
                  id="mcp-id"
                  required
                  placeholder="weather"
                  value={formId}
                  onChange={(e) => setFormId(e.target.value)}
                />
              </Field>
              <Field id="mcp-url" label="URL" required>
                <Input
                  id="mcp-url"
                  type="url"
                  required
                  placeholder="https://mcp.example.com/rpc"
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                />
              </Field>
              <Field id="mcp-transport" label="Transport">
                <NativeSelect
                  id="mcp-transport"
                  value={formTransport}
                  onChange={(e) => setFormTransport(e.target.value)}
                >
                  {TRANSPORTS.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </NativeSelect>
              </Field>
              <div className="col-span-full">
                <button
                  type="button"
                  className="text-sm font-medium text-primary hover:underline"
                  onClick={() => setAdvanced((a) => !a)}
                >
                  {advanced ? "Hide advanced" : "Advanced"}
                </button>
              </div>
              {advanced && (
                <>
                  <Field id="mcp-timeout" label="Request timeout (ms)">
                    <Input
                      id="mcp-timeout"
                      type="number"
                      placeholder="30000"
                      value={formTimeout}
                      onChange={(e) => setFormTimeout(e.target.value)}
                    />
                  </Field>
                  <div className="col-span-full flex flex-col gap-2">
                    <Label>Headers</Label>
                    {formHeaders.map((row, i) => (
                      <div key={i} className="flex gap-2">
                        <Input
                          aria-label={`Header name ${i + 1}`}
                          placeholder="Authorization"
                          value={row.name}
                          onChange={(e) =>
                            setFormHeaders((prev) =>
                              prev.map((r, idx) =>
                                idx === i ? { ...r, name: e.target.value } : r
                              )
                            )}
                        />
                        <Input
                          aria-label={`Header value ${i + 1}`}
                          type="password"
                          autoComplete="off"
                          value={row.value}
                          onChange={(e) =>
                            setFormHeaders((prev) =>
                              prev.map((r, idx) =>
                                idx === i ? { ...r, value: e.target.value } : r
                              )
                            )}
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove header ${row.name || i + 1}`}
                          onClick={() =>
                            setFormHeaders((prev) =>
                              prev.filter((_, idx) => idx !== i)
                            )}
                        >
                          <X />
                        </Button>
                      </div>
                    ))}
                    <div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setFormHeaders((
                            prev,
                          ) => [...prev, { name: "", value: "" }])}
                      >
                        Add header
                      </Button>
                    </div>
                  </div>
                </>
              )}
              <div className="col-span-full flex justify-end">
                <Button type="submit">
                  <Plus />
                  Add MCP server
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {tab === "tools" && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle id="tools">Synced tools</CardTitle>
            <span className="text-sm text-muted-foreground">
              Tools without a read-only annotation require per-call confirmation
              at execution time.
            </span>
          </CardHeader>
          <CardContent>
            {!loaded
              ? <TableSkeleton cols={4} />
              : tools.length === 0
              ? (
                <p className="text-sm text-muted-foreground">
                  No tools synced yet. Add an MCP server or run Sync.
                </p>
              )
              : (
                <ScrollContainer label="Synced tools" minWidth="40rem">
                  <Table>
                    <TableCaption>Synced tools</TableCaption>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tool</TableHead>
                        <TableHead>Server</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>Side effects</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tools.map((t) => (
                        <TableRow key={`${t.clientId}/${t.name}`}>
                          <TableCell className="font-mono">{t.name}</TableCell>
                          <TableCell>{t.clientId}</TableCell>
                          <TableCell
                            className="max-w-xs truncate"
                            title={t.description}
                          >
                            {t.description ?? "-"}
                          </TableCell>
                          <TableCell>
                            <Badge
                              tone={t.annotations?.readOnlyHint ? "ok" : "warn"}
                            >
                              {t.annotations?.readOnlyHint
                                ? "read-only"
                                : "needs confirmation"}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollContainer>
              )}
          </CardContent>
        </Card>
      )}

      {tab === "plugins" && (
        <Card>
          <CardHeader>
            <CardTitle id="plugins">Plugins</CardTitle>
          </CardHeader>
          <CardContent>
            {plugins.length === 0
              ? (
                <p className="text-sm text-muted-foreground">
                  No plugins loaded. Plugins register at gateway boot.
                </p>
              )
              : (
                <ul className="flex flex-col gap-1">
                  {plugins.map((p) => (
                    <li key={p} className="font-mono text-sm">{p}</li>
                  ))}
                </ul>
              )}
          </CardContent>
        </Card>
      )}

      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `Edit MCP server "${editing.id}"` : "Edit MCP server"}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!editing) return;
                void run(
                  () => updateMCPClient(editing.id, editDraft),
                  () => {
                    toast.success(`MCP server "${editing.id}" saved`);
                    setEditing(null);
                  },
                );
              }}
            >
              Save changes
            </Button>
          </>
        }
      >
        {editing && (
          <EditMCPForm
            key={editing.id}
            client={editing}
            onChange={setEditDraft}
          />
        )}
      </Sheet>
    </div>
  );
}

function EditMCPForm(
  { client, onChange }: {
    client: MCPClientView;
    onChange: (draft: Partial<MCPClientInput>) => void;
  },
) {
  const isStdio = client.transport === "stdio";
  const [url, setUrl] = useState(client.url ?? "");
  const [transport, setTransport] = useState<string>(
    client.transport ?? "http-sse",
  );
  const [enabled, setEnabled] = useState(client.enabled);
  const [timeout, setTimeoutMs] = useState(
    client.requestTimeoutMs ? String(client.requestTimeoutMs) : "",
  );
  // Values are NEVER prefilled from the stored config (security #16); only the
  // header keys are surfaced. Adding rows replaces the header set on save.
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const existingKeys = client.headerNames;

  // Report the draft up to the owning view (a pure effect, not a render-time
  // mutation of a shared object) so the Save button reads current values.
  useEffect(() => {
    const headerMap = Object.fromEntries(
      headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value]),
    );
    onChange({
      ...(url !== (client.url ?? "") ? { url: url || undefined } : {}),
      transport: isStdio ? undefined : transport,
      enabled,
      requestTimeoutMs: timeout ? Number(timeout) : undefined,
      ...(Object.keys(headerMap).length > 0 ? { headers: headerMap } : {}),
    });
  }, [url, transport, enabled, timeout, headers, isStdio, client, onChange]);

  return (
    <div className="flex flex-col gap-4">
      <Field id="edit-mcp-url" label="URL">
        <Input
          id="edit-mcp-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={isStdio}
        />
      </Field>
      {isStdio
        ? (
          <div className="text-sm text-muted-foreground">
            Transport: stdio. stdio servers are managed via the API.
          </div>
        )
        : (
          <Field id="edit-mcp-transport" label="Transport">
            <NativeSelect
              id="edit-mcp-transport"
              value={transport}
              onChange={(e) => setTransport(e.target.value)}
            >
              {TRANSPORTS.map((t) => <option key={t} value={t}>{t}</option>)}
            </NativeSelect>
          </Field>
        )}
      <Field id="edit-mcp-enabled" label="Enabled">
        <div className="flex h-9 items-center">
          <Switch
            id="edit-mcp-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label="Enabled"
          />
        </div>
      </Field>
      <Field id="edit-mcp-timeout" label="Request timeout (ms)">
        <Input
          id="edit-mcp-timeout"
          type="number"
          placeholder="30000"
          value={timeout}
          onChange={(e) => setTimeoutMs(e.target.value)}
        />
      </Field>
      <div className="flex flex-col gap-2">
        <Label>Headers</Label>
        {existingKeys.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
            <p className="text-xs text-muted-foreground">
              Stored header values are hidden. Re-enter a value to change it;
              saving headers replaces the whole set.
            </p>
            <div className="flex flex-wrap gap-1">
              {existingKeys.map((key) => (
                <Badge key={key} tone="muted">{key}</Badge>
              ))}
            </div>
          </div>
        )}
        {headers.map((row, i) => (
          <div key={i} className="flex gap-2">
            <Input
              aria-label={`Header name ${i + 1}`}
              placeholder="Authorization"
              value={row.name}
              onChange={(e) =>
                setHeaders((prev) =>
                  prev.map((r, idx) =>
                    idx === i ? { ...r, name: e.target.value } : r
                  )
                )}
            />
            <Input
              aria-label={`Header value ${i + 1}`}
              type="password"
              autoComplete="off"
              value={row.value}
              onChange={(e) =>
                setHeaders((prev) =>
                  prev.map((r, idx) =>
                    idx === i ? { ...r, value: e.target.value } : r
                  )
                )}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove header ${row.name || i + 1}`}
              onClick={() =>
                setHeaders((prev) => prev.filter((_, idx) => idx !== i))}
            >
              <X />
            </Button>
          </div>
        ))}
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setHeaders((prev) => [...prev, { name: "", value: "" }])}
          >
            Add header
          </Button>
        </div>
      </div>
    </div>
  );
}
