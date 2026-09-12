import { type ReactNode, useMemo, useState } from "react";
import { ArrowLeft, Plus } from "lucide-react";
import type { ProviderAccountConfig, ProviderAccountPublic } from "../../api";
import { UnderlineTabs } from "../ui/nav-tabs";
import { tabPanelProps } from "../ui/tabs";
import { NumberField } from "../ui/number-field";
import { Switch } from "../ui/switch";
import { type KeyValuePair, KeyValueRows } from "../ui/key-value-rows";
import { PemTextarea } from "../ui/pem-textarea";
import { Combobox } from "../ui/combobox";
import { SegmentedSelect } from "../ui/segmented-select";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Banner } from "../ui/banner";
import { DataTable } from "../ui/data-table";
import { ProviderIcon } from "../ui/provider-icon";
import { SecretReenter } from "./SecretReenter";
import {
  BETA_OVERRIDES,
  type BetaHeaderDef,
  isCustomProvider,
  KNOWN_BETA_HEADERS,
  PROVIDER_LABELS,
  PROXY_TYPES,
  RESET_PERIODS,
} from "./constants";
import { cn } from "../../lib/utils";
import { eurToUsd, usdToEur } from "../../lib/currency";

type ProviderType = ProviderAccountConfig["type"];
type BetaOverride = "default" | "enabled" | "disabled";

interface ConfigForm {
  baseUrl: string;
  // network
  timeoutSec: string;
  streamIdleTimeoutSec: string;
  maxRetries: string;
  initialBackoffMs: string;
  maxBackoffMs: string;
  maxConnectionsPerHost: string;
  enforceHttp2: boolean;
  extraHeaders: KeyValuePair[];
  skipTlsVerify: boolean;
  caCertPem: string;
  // proxy
  proxyUrl: string;
  proxyType: "" | "http" | "https" | "socks5";
  proxyUsername: string;
  proxyPassword: string;
  noProxy: string;
  // performance
  maxConcurrentRequests: string;
  // governance
  budgetUsd: string;
  budgetResetPeriod: string;
  maxTokens: string;
  tokensResetPeriod: string;
  maxRequests: string;
  requestsResetPeriod: string;
  // beta headers
  betaOverrides: Record<string, BetaOverride>;
  // debugging
  sendBackRawRequest: boolean;
  sendBackRawResponse: boolean;
  storeRawReqResp: boolean;
}

const TABS = [
  { value: "network", label: "Network" },
  { value: "proxy", label: "Proxy" },
  { value: "performance", label: "Performance" },
  { value: "governance", label: "Governance" },
  { value: "beta", label: "Beta Headers" },
  { value: "debugging", label: "Debugging" },
];

function numStr(value: number | undefined): string {
  return value === undefined || value === null ? "" : String(value);
}

function numOrUndef(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function seedForm(p: ProviderAccountPublic): ConfigForm {
  const net = p.network ?? {};
  const proxy: NonNullable<ProviderAccountPublic["proxy"]> = p.proxy ?? {
    noProxyCount: 0,
  };
  const gov = p.governance ?? {};
  const perf = p.performance ?? {};
  const dbg = p.debugging ?? {};
  return {
    baseUrl: p.baseUrl ?? "",
    timeoutSec: numStr(net.timeoutSec),
    streamIdleTimeoutSec: numStr(net.streamIdleTimeoutSec),
    maxRetries: numStr(net.maxRetries),
    initialBackoffMs: numStr(net.initialBackoffMs),
    maxBackoffMs: numStr(net.maxBackoffMs),
    maxConnectionsPerHost: numStr(net.maxConnectionsPerHost),
    enforceHttp2: net.enforceHttp2 ?? false,
    // Header values are intentionally write-only. Existing names are rendered
    // as metadata below; replacement values start blank.
    extraHeaders: [],
    skipTlsVerify: net.skipTlsVerify ?? false,
    caCertPem: "",
    proxyUrl: "",
    proxyType: proxy.proxyType ?? "",
    proxyUsername: proxy.proxyUsername ?? "",
    proxyPassword: "",
    noProxy: "",
    maxConcurrentRequests: numStr(perf.maxConcurrentRequests),
    // Stored canonical USD budget shown to the operator in euros (2dp).
    budgetUsd: gov.budgetUsd === undefined
      ? ""
      : numStr(Math.round(usdToEur(gov.budgetUsd) * 100) / 100),
    budgetResetPeriod: gov.budgetResetPeriod ?? "",
    maxTokens: numStr(gov.maxTokens),
    tokensResetPeriod: gov.tokensResetPeriod ?? "",
    maxRequests: numStr(gov.maxRequests),
    requestsResetPeriod: gov.requestsResetPeriod ?? "",
    betaOverrides: { ...(p.betaHeaders?.overrides ?? {}) } as Record<
      string,
      BetaOverride
    >,
    sendBackRawRequest: dbg.sendBackRawRequest ?? false,
    sendBackRawResponse: dbg.sendBackRawResponse ?? false,
    storeRawReqResp: dbg.storeRawReqResp ?? false,
  };
}

/* --- group assemblers: produce the persisted shape from the form ------- */

type NetworkCfg = NonNullable<ProviderAccountConfig["network"]>;
type ProxyCfg = NonNullable<ProviderAccountConfig["proxy"]>;
type GovCfg = NonNullable<ProviderAccountConfig["governance"]>;
type ResetPeriod = GovCfg["budgetResetPeriod"];

function assembleNetwork(f: ConfigForm): NetworkCfg {
  const out: NetworkCfg = {
    enforceHttp2: f.enforceHttp2,
    skipTlsVerify: f.skipTlsVerify,
  };
  const timeoutSec = numOrUndef(f.timeoutSec);
  if (timeoutSec !== undefined) out.timeoutSec = timeoutSec;
  const streamIdle = numOrUndef(f.streamIdleTimeoutSec);
  if (streamIdle !== undefined) out.streamIdleTimeoutSec = streamIdle;
  const maxRetries = numOrUndef(f.maxRetries);
  if (maxRetries !== undefined) out.maxRetries = maxRetries;
  const initialBackoff = numOrUndef(f.initialBackoffMs);
  if (initialBackoff !== undefined) out.initialBackoffMs = initialBackoff;
  const maxBackoff = numOrUndef(f.maxBackoffMs);
  if (maxBackoff !== undefined) out.maxBackoffMs = maxBackoff;
  const maxConns = numOrUndef(f.maxConnectionsPerHost);
  if (maxConns !== undefined) out.maxConnectionsPerHost = maxConns;
  const headers = f.extraHeaders.filter((h) => h.name.trim() !== "");
  if (headers.length > 0) out.extraHeaders = headers;
  if (f.caCertPem.trim() !== "") out.caCertPem = f.caCertPem;
  return out;
}

function assembleProxy(f: ConfigForm): ProxyCfg {
  const out: ProxyCfg = {};
  if (f.proxyType !== "") out.proxyType = f.proxyType;
  if (f.proxyUsername.trim() !== "") out.proxyUsername = f.proxyUsername.trim();
  if (f.proxyPassword !== "") out.proxyPassword = f.proxyPassword;
  const noProxy = f.noProxy.split(",").map((value) => value.trim()).filter(
    Boolean,
  );
  if (noProxy.length > 0) out.noProxy = noProxy;
  return out;
}

function assembleGovernance(f: ConfigForm): GovCfg {
  const out: GovCfg = {};
  // The field is entered in euros; store the canonical USD budget.
  const budgetEur = numOrUndef(f.budgetUsd);
  if (budgetEur !== undefined) out.budgetUsd = eurToUsd(budgetEur);
  if (f.budgetResetPeriod) {
    out.budgetResetPeriod = f.budgetResetPeriod as ResetPeriod;
  }
  const maxTokens = numOrUndef(f.maxTokens);
  if (maxTokens !== undefined) out.maxTokens = maxTokens;
  if (f.tokensResetPeriod) {
    out.tokensResetPeriod = f.tokensResetPeriod as ResetPeriod;
  }
  const maxRequests = numOrUndef(f.maxRequests);
  if (maxRequests !== undefined) out.maxRequests = maxRequests;
  if (f.requestsResetPeriod) {
    out.requestsResetPeriod = f.requestsResetPeriod as ResetPeriod;
  }
  return out;
}

function stable(obj: object): string {
  // The assemblers build keys in a fixed order and omit empty fields, so a
  // plain stringify is a deterministic, comparable signature for the diff.
  return JSON.stringify(obj);
}

export interface ProviderConfigPanelProps {
  provider: ProviderAccountPublic;
  busy: boolean;
  onSave: (patch: Partial<ProviderAccountConfig>) => void;
  onRemove: () => void;
  onBack: () => void;
}

/**
 * Full-width 6-tab provider configuration panel (Network / Proxy / Performance
 * / Governance / Beta Headers / Debugging) wired to ProviderAccountConfig with
 * a sticky Save / Remove footer. Groups are diffed against the loaded state so
 * unchanged groups (which still hold server-side secrets the browser never
 * sees) are never re-sent through the gateway's shallow-merge PUT.
 */
export function ProviderConfigPanel(
  { provider, busy, onSave, onRemove, onBack }: ProviderConfigPanelProps,
) {
  const initial = useMemo(() => seedForm(provider), [provider]);
  const [form, setForm] = useState<ConfigForm>(initial);
  const [tab, setTab] = useState("network");
  const [customPrefix, setCustomPrefix] = useState("");

  const set = <K extends keyof ConfigForm>(key: K, value: ConfigForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const networkDirty = stable(assembleNetwork(form)) !==
    stable(assembleNetwork(initial));
  const proxyDirty = stable(assembleProxy(form)) !==
    stable(assembleProxy(initial));
  const govDirty = stable(assembleGovernance(form)) !==
    stable(assembleGovernance(initial));
  const betaDirty = JSON.stringify(form.betaOverrides) !==
    JSON.stringify(initial.betaOverrides);
  const perfDirty =
    form.maxConcurrentRequests !== initial.maxConcurrentRequests;
  const dbgDirty = form.sendBackRawRequest !== initial.sendBackRawRequest ||
    form.sendBackRawResponse !== initial.sendBackRawResponse ||
    form.storeRawReqResp !== initial.storeRawReqResp;
  const baseUrlDirty = form.baseUrl !== initial.baseUrl;
  const proxyUrlDirty = form.proxyUrl !== "";

  const certAtRisk = networkDirty && (provider.hasCaCert ?? false) &&
    form.caCertPem.trim() === "";
  const headersAtRisk = networkDirty &&
    (provider.network?.extraHeaders ?? []).some((stored) =>
      !form.extraHeaders.some(
        (replacement) =>
          replacement.name.trim().toLowerCase() === stored.name.toLowerCase() &&
          replacement.value !== "",
      )
    );
  const proxyPassAtRisk = proxyDirty && (provider.hasProxyPassword ?? false) &&
    form.proxyPassword === "";
  const noProxyAtRisk = proxyDirty && (provider.proxy?.noProxyCount ?? 0) > 0 &&
    form.noProxy.trim() === "";

  function save() {
    const patch: Partial<ProviderAccountConfig> = {};
    if (baseUrlDirty) {
      patch.baseUrl = form.baseUrl.trim();
    }
    if (networkDirty) {
      patch.network = assembleNetwork(form);
    }
    if (proxyUrlDirty) {
      patch.proxyUrl = form.proxyUrl.trim();
    }
    if (proxyDirty) {
      patch.proxy = assembleProxy(form);
    }
    if (perfDirty) {
      const mc = numOrUndef(form.maxConcurrentRequests);
      patch.performance = mc === undefined ? {} : { maxConcurrentRequests: mc };
    }
    if (govDirty) {
      patch.governance = assembleGovernance(form);
    }
    if (betaDirty) {
      patch.betaHeaders = { overrides: form.betaOverrides };
    }
    if (dbgDirty) {
      patch.debugging = {
        sendBackRawRequest: form.sendBackRawRequest,
        sendBackRawResponse: form.sendBackRawResponse,
        storeRawReqResp: form.storeRawReqResp,
      };
    }
    onSave(patch);
  }

  const label = PROVIDER_LABELS[provider.type as ProviderType] ?? provider.type;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="mb-4 flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back to provider keys"
          onClick={onBack}
        >
          <ArrowLeft />
        </Button>
        <ProviderIcon
          provider={provider.type}
          name={provider.id}
          custom={isCustomProvider(provider.type as ProviderType)}
          size="sm"
        />
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold text-foreground">
            {provider.id}
          </h3>
          <p className="text-xs text-muted-foreground">{label} configuration</p>
        </div>
      </div>

      <UnderlineTabs
        label="Provider configuration"
        value={tab}
        onValueChange={setTab}
        tabs={TABS}
        className="mb-5"
      />

      <div {...tabPanelProps(tab)} className="min-h-0">
        {tab === "network" && (
          <NetworkTab
            form={form}
            set={set}
            hasCaCert={provider.hasCaCert ?? false}
            certAtRisk={certAtRisk}
            existingHeaders={provider.network?.extraHeaders ?? []}
            headersAtRisk={headersAtRisk}
          />
        )}
        {tab === "proxy" && (
          <ProxyTab
            form={form}
            set={set}
            hasProxy={provider.hasProxy ?? false}
            hasProxyPassword={provider.hasProxyPassword ?? false}
            proxyPassAtRisk={proxyPassAtRisk}
            noProxyCount={provider.proxy?.noProxyCount ?? 0}
            noProxyAtRisk={noProxyAtRisk}
          />
        )}
        {tab === "performance" && <PerformanceTab form={form} set={set} />}
        {tab === "governance" && <GovernanceTab form={form} set={set} />}
        {tab === "beta" && (
          <BetaHeadersTab
            form={form}
            set={set}
            customPrefix={customPrefix}
            setCustomPrefix={setCustomPrefix}
          />
        )}
        {tab === "debugging" && <DebuggingTab form={form} set={set} />}
      </div>

      <div className="sticky bottom-0 z-(--z-sticky) -mx-6 mt-6 flex items-center justify-between gap-2 border-t border-border bg-background px-6 py-3">
        <Button
          type="button"
          variant="destructive-outline"
          onClick={onRemove}
          disabled={busy}
        >
          Remove configuration
        </Button>
        <Button type="button" onClick={save} isLoading={busy}>
          Save configuration
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------- tabs ---------------------------------- */

interface TabProps {
  form: ConfigForm;
  set: <K extends keyof ConfigForm>(key: K, value: ConfigForm[K]) => void;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h4 className="text-sm font-semibold text-foreground">{children}</h4>;
}

function NetworkTab(
  { form, set, hasCaCert, certAtRisk, existingHeaders, headersAtRisk }:
    & TabProps
    & {
      hasCaCert: boolean;
      certAtRisk: boolean;
      existingHeaders: Array<{ name: string; hasValue: boolean }>;
      headersAtRisk: boolean;
    },
) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="cfg-baseurl">Base URL (Optional)</Label>
        <Input
          id="cfg-baseurl"
          placeholder="https://api.example.com"
          value={form.baseUrl}
          onChange={(e) => set("baseUrl", e.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <NumberField
          label="Timeout"
          unit="sec"
          min={1}
          value={form.timeoutSec}
          onChange={(v) => set("timeoutSec", v)}
          placeholder="30"
        />
        <NumberField
          label="Stream Idle Timeout"
          unit="sec"
          min={1}
          value={form.streamIdleTimeoutSec}
          onChange={(v) => set("streamIdleTimeoutSec", v)}
          placeholder="60"
          help="Max wait for the next chunk before closing a stalled stream."
        />
        <NumberField
          label="Max Retries"
          min={0}
          value={form.maxRetries}
          onChange={(v) => set("maxRetries", v)}
          placeholder="0"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <NumberField
          label="Initial Backoff"
          unit="ms"
          min={0}
          value={form.initialBackoffMs}
          onChange={(v) => set("initialBackoffMs", v)}
          placeholder="500"
        />
        <NumberField
          label="Max Backoff"
          unit="ms"
          min={0}
          value={form.maxBackoffMs}
          onChange={(v) => set("maxBackoffMs", v)}
          placeholder="5000"
        />
        <NumberField
          label="Max Connections Per Host"
          min={1}
          value={form.maxConnectionsPerHost}
          onChange={(v) => set("maxConnectionsPerHost", v)}
          placeholder="5000"
          help="Max TCP connections per provider host."
        />
      </div>

      <ToggleRow
        id="cfg-http2"
        label="Enforce HTTP/2"
        description="Force HTTP/2 on provider connections. Each HTTP/2 connection supports ~100 concurrent streams."
        checked={form.enforceHttp2}
        onCheckedChange={(v) => set("enforceHttp2", v)}
      />

      <div className="flex flex-col gap-2">
        <SectionTitle>Extra Headers</SectionTitle>
        {existingHeaders.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Stored (values hidden): {existingHeaders.map((header) =>
              header.name
            ).join(", ")}
          </p>
        )}
        <KeyValueRows
          value={form.extraHeaders}
          onChange={(rows) => set("extraHeaders", rows)}
          namePlaceholder="Header name"
          valuePlaceholder="Header value"
          valueInputType="password"
          addLabel="Add header"
          idPrefix="cfg-hdr"
        />
        {headersAtRisk && (
          <Banner tone="warn">
            Saving network changes without re-entering the stored headers will
            clear them. Add replacement values to keep them.
          </Banner>
        )}
      </div>

      <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
        <SectionTitle>TLS / Certificate</SectionTitle>
        <ToggleRow
          id="cfg-skiptls"
          label="Skip TLS verification"
          description="Disable certificate verification for provider connections. Use only as a last resort; prefer a CA certificate for self-signed or private CA deployments."
          checked={form.skipTlsVerify}
          onCheckedChange={(v) => set("skipTlsVerify", v)}
        />
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Label htmlFor="cfg-cacert">CA Certificate (PEM) (Optional)</Label>
            {hasCaCert && form.caCertPem.trim() === "" && (
              <Badge tone="muted">Configured</Badge>
            )}
          </div>
          <PemTextarea
            id="cfg-cacert"
            value={form.caCertPem}
            onChange={(v) => set("caCertPem", v)}
            hint={hasCaCert
              ? "A certificate is already stored (not shown). Paste a new one to replace it."
              : "PEM-encoded CA certificate to trust for provider connections."}
          />
          {certAtRisk && (
            <Banner tone="warn">
              Saving network changes without re-entering the certificate will
              clear the stored one. Paste it again to keep it.
            </Banner>
          )}
        </div>
      </div>
    </div>
  );
}

function ProxyTab(
  {
    form,
    set,
    hasProxy,
    hasProxyPassword,
    proxyPassAtRisk,
    noProxyCount,
    noProxyAtRisk,
  }: TabProps & {
    hasProxy: boolean;
    hasProxyPassword: boolean;
    proxyPassAtRisk: boolean;
    noProxyCount: number;
    noProxyAtRisk: boolean;
  },
) {
  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Label htmlFor="cfg-proxyurl">Proxy URL</Label>
          {hasProxy && form.proxyUrl === "" && (
            <Badge tone="muted">Configured</Badge>
          )}
        </div>
        <SecretReenter
          id="cfg-proxyurl"
          label="Proxy URL"
          configured={hasProxy}
          value={form.proxyUrl}
          onChange={(v) => set("proxyUrl", v)}
          placeholder="http://user:pass@proxy.internal:8080"
          configuredHint="A proxy URL is already stored (it may embed credentials, so it is not shown). Replace it or leave it as is."
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Label htmlFor="cfg-noproxy">No-proxy hosts</Label>
          {noProxyCount > 0 && form.noProxy.trim() === "" && (
            <Badge tone="muted">{noProxyCount} configured</Badge>
          )}
        </div>
        <Input
          id="cfg-noproxy"
          autoComplete="off"
          value={form.noProxy}
          onChange={(e) => set("noProxy", e.target.value)}
          placeholder=".internal, *.corp.example"
        />
        <p className="text-sm text-muted-foreground">
          Comma-separated hosts that bypass this provider's proxy. Existing
          rules are hidden; enter replacements to change them.
        </p>
        {noProxyAtRisk && (
          <Banner tone="warn">
            Saving proxy changes without re-entering the bypass rules will clear
            them.
          </Banner>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Proxy Type</Label>
        <SegmentedSelect
          label="Proxy type"
          options={PROXY_TYPES}
          value={form.proxyType === "" ? "http" : form.proxyType}
          onChange={(v) => set("proxyType", v)}
        />
        <p className="text-sm text-muted-foreground">
          Advisory: the transport is taken from the proxy URL scheme.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="cfg-proxyuser">Proxy Username</Label>
        <Input
          id="cfg-proxyuser"
          autoComplete="off"
          value={form.proxyUsername}
          onChange={(e) => set("proxyUsername", e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Label htmlFor="cfg-proxypass">Proxy Password</Label>
          {hasProxyPassword && form.proxyPassword === "" && (
            <Badge tone="muted">Configured</Badge>
          )}
        </div>
        <SecretReenter
          id="cfg-proxypass"
          label="Proxy password"
          configured={hasProxyPassword}
          value={form.proxyPassword}
          onChange={(v) => set("proxyPassword", v)}
        />
        {proxyPassAtRisk && (
          <Banner tone="warn">
            Saving proxy changes without re-entering the password will clear the
            stored one.
          </Banner>
        )}
      </div>
    </div>
  );
}

function PerformanceTab({ form, set }: TabProps) {
  return (
    <div className="max-w-md">
      <NumberField
        label="Max Concurrent Requests"
        min={1}
        value={form.maxConcurrentRequests}
        onChange={(v) => set("maxConcurrentRequests", v)}
        placeholder="Unlimited"
        help="Cap on in-flight requests to this provider."
      />
    </div>
  );
}

function GovernanceTab({ form, set }: TabProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <SectionTitle>Budget Configuration</SectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_12rem]">
          <NumberField
            label="Maximum Spend (EUR)"
            min={0}
            step={0.01}
            value={form.budgetUsd}
            onChange={(v) => set("budgetUsd", v)}
            placeholder="100"
          />
          <ResetPeriodField
            id="cfg-budget-period"
            value={form.budgetResetPeriod}
            onChange={(v) => set("budgetResetPeriod", v)}
          />
        </div>
      </div>

      <div className="h-px bg-border" />

      <div className="flex flex-col gap-3">
        <SectionTitle>Rate Limiting Configuration</SectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_12rem]">
          <NumberField
            label="Maximum Tokens"
            min={0}
            value={form.maxTokens}
            onChange={(v) => set("maxTokens", v)}
            placeholder="100"
          />
          <ResetPeriodField
            id="cfg-tokens-period"
            value={form.tokensResetPeriod}
            onChange={(v) => set("tokensResetPeriod", v)}
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_12rem]">
          <NumberField
            label="Maximum Requests"
            min={0}
            value={form.maxRequests}
            onChange={(v) => set("maxRequests", v)}
            placeholder="100"
          />
          <ResetPeriodField
            id="cfg-requests-period"
            value={form.requestsResetPeriod}
            onChange={(v) => set("requestsResetPeriod", v)}
          />
        </div>
      </div>
    </div>
  );
}

function ResetPeriodField(
  { id, value, onChange }: {
    id: string;
    value: string;
    onChange: (value: string) => void;
  },
) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Reset Period</Label>
      <Combobox
        id={id}
        label="Reset period"
        options={RESET_PERIODS}
        value={value || null}
        onChange={onChange}
        placeholder="Select period"
      />
    </div>
  );
}

interface BetaRow extends BetaHeaderDef {
  custom: boolean;
}

function BetaHeadersTab(
  { form, set, customPrefix, setCustomPrefix }: TabProps & {
    customPrefix: string;
    setCustomPrefix: (value: string) => void;
  },
) {
  const rows = useMemo<BetaRow[]>(() => {
    const known = KNOWN_BETA_HEADERS.map((h) => ({ ...h, custom: false }));
    const extra = Object.keys(form.betaOverrides)
      .filter((prefix) => !KNOWN_BETA_HEADERS.some((h) => h.prefix === prefix))
      .map((prefix) => ({
        prefix,
        description: "Custom prefix",
        custom: true,
      }));
    return [...known, ...extra];
  }, [form.betaOverrides]);

  function setOverride(prefix: string, value: BetaOverride) {
    const next = { ...form.betaOverrides };
    if (value === "default") {
      delete next[prefix];
    } else {
      next[prefix] = value;
    }
    set("betaOverrides", next);
  }

  function addCustom() {
    const prefix = customPrefix.trim();
    if (prefix === "") {
      return;
    }
    set("betaOverrides", { ...form.betaOverrides, [prefix]: "enabled" });
    setCustomPrefix("");
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Configure which Anthropic beta headers are allowed for this provider.
        Override the defaults when a provider adds or removes support for a beta
        feature.
      </p>
      <DataTable
        caption="Beta headers"
        rows={rows}
        getRowId={(row) => row.prefix}
        minWidth="42rem"
        columns={[
          {
            key: "header",
            header: "Beta Header",
            cell: (row) => (
              <div className="flex flex-col">
                <span className="font-mono text-sm text-foreground">
                  {row.prefix}*
                </span>
                <span className="text-xs text-muted-foreground">
                  {row.description}
                </span>
              </div>
            ),
          },
          {
            key: "default",
            header: "Default",
            width: "8rem",
            cell: (row) =>
              row.custom
                ? <span className="text-sm text-muted-foreground">-</span>
                : <Badge tone="muted">Supported</Badge>,
          },
          {
            key: "override",
            header: "Override",
            width: "16rem",
            cell: (row) => (
              <SegmentedSelect
                size="sm"
                label={`${row.prefix} override`}
                options={BETA_OVERRIDES}
                value={form.betaOverrides[row.prefix] ?? "default"}
                onChange={(v) => setOverride(row.prefix, v)}
              />
            ),
          },
        ]}
      />
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="cfg-beta-custom">Add custom beta header prefix</Label>
          <Input
            id="cfg-beta-custom"
            placeholder="new-feature-"
            value={customPrefix}
            onChange={(e) => setCustomPrefix(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCustom();
              }
            }}
          />
        </div>
        <Button variant="outline" onClick={addCustom}>
          <Plus aria-hidden="true" />
          Add
        </Button>
      </div>
    </div>
  );
}

function DebuggingTab({ form, set }: TabProps) {
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <ToggleRow
        id="cfg-raw-req"
        label="Send Back Raw Request"
        description="Include the raw provider request alongside the parsed request in the API response."
        checked={form.sendBackRawRequest}
        onCheckedChange={(v) => set("sendBackRawRequest", v)}
      />
      <ToggleRow
        id="cfg-raw-resp"
        label="Send Back Raw Response"
        description="Include the raw provider response alongside the parsed response in the API response."
        checked={form.sendBackRawResponse}
        onCheckedChange={(v) => set("sendBackRawResponse", v)}
      />
      <ToggleRow
        id="cfg-store-raw"
        label="Store Raw Request/Response"
        description="Persist raw request and response payloads in log records."
        checked={form.storeRawReqResp}
        onCheckedChange={(v) => set("storeRawReqResp", v)}
      />
    </div>
  );
}

function ToggleRow(
  { id, label, description, checked, onCheckedChange }: {
    id: string;
    label: string;
    description: string;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  },
) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 rounded-md border border-border",
        "bg-card px-4 py-3",
      )}
    >
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-sm font-medium text-foreground">
          {label}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {description}
        </span>
      </label>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={label}
      />
    </div>
  );
}
