import { useEffect, useMemo, useState } from "react";
import type { CodeModeBinding, SettingsSection } from "../../api";
import { Card, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import { Combobox } from "../ui/combobox";
import { Label } from "../ui/label";
import {
  asBool,
  asNumStr,
  asString,
  FieldBlock,
  NumberCard,
  numOrUndef,
  PanelFooter,
  PanelIntro,
  sourceOf,
  ToggleRow,
} from "./helpers";
import { CodeModeVfsPreview } from "./CodeModeVfsPreview";

interface McpForm {
  maxAgentDepth: string;
  toolExecutionTimeoutSec: string;
  toolSyncIntervalMin: string;
  disableAutoToolInjection: boolean;
  externalServerUrl: string;
  externalClientUrl: string;
}

function seed(values: Record<string, unknown> | undefined): McpForm {
  const v = values ?? {};
  return {
    maxAgentDepth: asNumStr(v.maxAgentDepth),
    toolExecutionTimeoutSec: asNumStr(v.toolExecutionTimeoutSec),
    toolSyncIntervalMin: asNumStr(v.toolSyncIntervalMin),
    disableAutoToolInjection: asBool(v.disableAutoToolInjection),
    externalServerUrl: asString(v.externalServerUrl),
    externalClientUrl: asString(v.externalClientUrl),
  };
}

const BINDING_OPTIONS = [
  { value: "server", label: "Server-Level" },
  { value: "tool", label: "Tool-Level" },
];

export interface McpPanelProps {
  section: SettingsSection | undefined;
  busy: boolean;
  onSave: (values: Record<string, unknown>) => void;
}

export function McpPanel({ section, busy, onSave }: McpPanelProps) {
  const initial = useMemo(() => seed(section?.values), [section]);
  const [form, setForm] = useState<McpForm>(initial);
  useEffect(() => setForm(initial), [initial]);

  // Binding level is a preview control only; it drives getCodeModeVfs() and is
  // never part of the persisted mcp settings group.
  const [binding, setBinding] = useState<CodeModeBinding>("server");

  const sources = section?.sources;

  const set = <K extends keyof McpForm>(key: K, value: McpForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const changed = useMemo(() => {
    const out: Record<string, unknown> = {};
    const depth = numOrUndef(form.maxAgentDepth);
    if (depth !== undefined && depth !== numOrUndef(initial.maxAgentDepth)) {
      out.maxAgentDepth = depth;
    }
    const timeout = numOrUndef(form.toolExecutionTimeoutSec);
    if (
      timeout !== undefined &&
      timeout !== numOrUndef(initial.toolExecutionTimeoutSec)
    ) {
      out.toolExecutionTimeoutSec = timeout;
    }
    const sync = numOrUndef(form.toolSyncIntervalMin);
    if (
      sync !== undefined && sync !== numOrUndef(initial.toolSyncIntervalMin)
    ) {
      out.toolSyncIntervalMin = sync;
    }
    if (form.disableAutoToolInjection !== initial.disableAutoToolInjection) {
      out.disableAutoToolInjection = form.disableAutoToolInjection;
    }
    if (form.externalServerUrl.trim() !== initial.externalServerUrl) {
      out.externalServerUrl = form.externalServerUrl.trim();
    }
    if (form.externalClientUrl.trim() !== initial.externalClientUrl) {
      out.externalClientUrl = form.externalClientUrl.trim();
    }
    return out;
  }, [form, initial]);

  const dirty = Object.keys(changed).length > 0;

  return (
    <div className="flex flex-col gap-5">
      <PanelIntro>
        Configure MCP (Model Context Protocol) agent and tool behavior.
      </PanelIntro>

      <NumberCard
        id="mcp-max-depth"
        label="Max Agent Depth"
        description="Maximum depth for MCP agent execution."
        min={0}
        value={form.maxAgentDepth}
        onChange={(v) => set("maxAgentDepth", v)}
        source={sourceOf(sources, "maxAgentDepth")}
      />
      <NumberCard
        id="mcp-timeout"
        label="Tool Execution Timeout (seconds)"
        description="Maximum time in seconds for tool execution."
        min={0}
        value={form.toolExecutionTimeoutSec}
        onChange={(v) => set("toolExecutionTimeoutSec", v)}
        source={sourceOf(sources, "toolExecutionTimeoutSec")}
      />
      <NumberCard
        id="mcp-sync-interval"
        label="Tool Sync Interval (minutes)"
        description="How often to refresh tool lists from MCP servers. Set to 0 to disable."
        min={0}
        value={form.toolSyncIntervalMin}
        onChange={(v) => set("toolSyncIntervalMin", v)}
        source={sourceOf(sources, "toolSyncIntervalMin")}
      />

      <Card>
        <CardContent>
          <ToggleRow
            id="mcp-disable-injection"
            label="Disable Auto Tool Injection"
            description={
              <>
                When enabled, MCP tools are not automatically included in every
                request. Tools are only injected when explicitly specified via
                the{" "}
                <code className="font-mono">x-frosty-mcp-include-tools</code>
                {" "}
                request header, and still must be allowed by the virtual key MCP
                configuration.
              </>
            }
            checked={form.disableAutoToolInjection}
            onCheckedChange={(v) => set("disableAutoToolInjection", v)}
            source={sourceOf(sources, "disableAutoToolInjection")}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-binding-level" className="font-semibold">
              Code Mode Binding Level
            </Label>
            <p className="text-sm text-muted-foreground">
              How tools are exposed in the VFS: server-level (all tools per
              server) or tool-level (individual tools).
            </p>
            <div className="max-w-xs">
              <Combobox
                id="mcp-binding-level"
                label="Code Mode Binding Level"
                options={BINDING_OPTIONS}
                value={binding}
                onChange={(v) => setBinding(v as CodeModeBinding)}
              />
            </div>
          </div>
          <CodeModeVfsPreview binding={binding} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-foreground">
              External Base URLs
            </span>
            <p className="text-sm text-muted-foreground">
              Override the gateway's public base URL when it runs behind a
              reverse proxy. In most setups both URLs are the same; leave them
              blank to derive the URL from the incoming Host header. Both fields
              support env var syntax (e.g. env.FROSTY_EXTERNAL_URL).
            </p>
          </div>

          <FieldBlock
            id="mcp-server-url"
            label="Server URL"
            source={sourceOf(sources, "externalServerUrl")}
            hint="Advertised in OAuth server metadata that downstream clients read (the .well-known authorization-server document and the WWW-Authenticate header on /mcp)."
          >
            <Input
              id="mcp-server-url"
              value={form.externalServerUrl}
              onChange={(e) => set("externalServerUrl", e.target.value)}
              placeholder="https://frosty.example.com or env.FROSTY_EXTERNAL_URL"
            />
          </FieldBlock>

          <FieldBlock
            id="mcp-client-url"
            label="Client URL"
            source={sourceOf(sources, "externalClientUrl")}
            hint="Used as the redirect_uri the gateway registers with upstream OAuth providers (<URL>/api/oauth/callback). Changing it after clients complete OAuth will break them until they re-authorize."
          >
            <Input
              id="mcp-client-url"
              value={form.externalClientUrl}
              onChange={(e) => set("externalClientUrl", e.target.value)}
              placeholder="https://frosty.example.com or env.FROSTY_OAUTH_REDIRECT_URL"
            />
          </FieldBlock>
        </CardContent>
      </Card>

      <PanelFooter dirty={dirty} busy={busy} onSave={() => onSave(changed)} />
    </div>
  );
}
