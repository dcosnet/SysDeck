import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { SettingsSection } from "../../api";
import { Banner } from "../ui/banner";
import { Badge } from "../ui/badge";
import { Card, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { TagInput } from "../ui/tag-input";
import { SecretReenter } from "../providers/SecretReenter";
import {
  asBool,
  asStrArray,
  asString,
  EnvHint,
  PanelFooter,
  PanelIntro,
  sourceOf,
  SourceTag,
  ToggleRow,
} from "./helpers";

interface SecurityForm {
  passwordProtectEnabled: boolean;
  passwordUsername: string;
  /** Write-only: always seeded empty; only sent when the operator types one. */
  password: string;
  disableInferenceAuth: boolean;
  enforceVirtualKeys: boolean;
  allowedOrigins: string[];
  allowedHeaders: string[];
  requiredHeaders: string[];
  whitelistedRoutes: string[];
}

function seed(values: Record<string, unknown> | undefined): SecurityForm {
  const v = values ?? {};
  return {
    passwordProtectEnabled: asBool(v.passwordProtectEnabled),
    passwordUsername: asString(v.passwordUsername),
    password: "",
    disableInferenceAuth: asBool(v.disableInferenceAuth),
    enforceVirtualKeys: asBool(v.enforceVirtualKeys),
    allowedOrigins: asStrArray(v.allowedOrigins),
    allowedHeaders: asStrArray(v.allowedHeaders),
    requiredHeaders: asStrArray(v.requiredHeaders),
    whitelistedRoutes: asStrArray(v.whitelistedRoutes),
  };
}

function arrEq(a: string[], b: string[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface SecurityPanelProps {
  section: SettingsSection | undefined;
  busy: boolean;
  onSave: (values: Record<string, unknown>) => void;
}

export function SecurityPanel(
  { section, busy, onSave }: SecurityPanelProps,
) {
  const initial = useMemo(() => seed(section?.values), [section]);
  const [form, setForm] = useState<SecurityForm>(initial);
  useEffect(() => setForm(initial), [initial]);

  const sources = section?.sources;
  const hasPassword = asBool(section?.values?.hasPassword);

  const set = <K extends keyof SecurityForm>(key: K, value: SecurityForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const changed = useMemo(() => {
    const out: Record<string, unknown> = {};
    if (form.passwordProtectEnabled !== initial.passwordProtectEnabled) {
      out.passwordProtectEnabled = form.passwordProtectEnabled;
    }
    if (form.passwordUsername.trim() !== initial.passwordUsername) {
      out.passwordUsername = form.passwordUsername.trim();
    }
    // Write-only: only send a password the operator actually typed, so an
    // untouched save preserves the stored one (shallow-merge safe).
    if (form.password !== "") {
      out.password = form.password;
    }
    if (form.disableInferenceAuth !== initial.disableInferenceAuth) {
      out.disableInferenceAuth = form.disableInferenceAuth;
    }
    if (form.enforceVirtualKeys !== initial.enforceVirtualKeys) {
      out.enforceVirtualKeys = form.enforceVirtualKeys;
    }
    if (!arrEq(form.allowedOrigins, initial.allowedOrigins)) {
      out.allowedOrigins = form.allowedOrigins;
    }
    if (!arrEq(form.allowedHeaders, initial.allowedHeaders)) {
      out.allowedHeaders = form.allowedHeaders;
    }
    if (!arrEq(form.requiredHeaders, initial.requiredHeaders)) {
      out.requiredHeaders = form.requiredHeaders;
    }
    if (!arrEq(form.whitelistedRoutes, initial.whitelistedRoutes)) {
      out.whitelistedRoutes = form.whitelistedRoutes;
    }
    return out;
  }, [form, initial]);

  const dirty = Object.keys(changed).length > 0;

  return (
    <div className="flex flex-col gap-5">
      <PanelIntro>
        Configure authentication and access control for the gateway.
      </PanelIntro>

      <Banner tone="info">
        Basic Auth protects every inference call (including MCP tool execution)
        when enabled. Turn it off below if another mechanism guards your
        traffic.
      </Banner>

      <Card>
        <CardContent className="flex flex-col gap-5">
          <ToggleRow
            id="sec-password-protect"
            label="Password protect the control plane"
            badge={<Badge tone="muted">Beta</Badge>}
            description="Set up credentials to protect admin access. Once configured, use the generated token for all admin API calls."
            checked={form.passwordProtectEnabled}
            onCheckedChange={(v) => set("passwordProtectEnabled", v)}
            source={sourceOf(sources, "passwordProtectEnabled")}
          />

          <div className="field-grid">
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-2">
                <Label htmlFor="sec-username">Username</Label>
                <SourceTag source={sourceOf(sources, "passwordUsername")} />
              </span>
              <Input
                id="sec-username"
                autoComplete="off"
                value={form.passwordUsername}
                onChange={(e) => set("passwordUsername", e.target.value)}
              />
              <EnvHint source={sourceOf(sources, "passwordUsername")} />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-2">
                <Label htmlFor="sec-password">Password</Label>
                <SourceTag source={sourceOf(sources, "password")} />
              </span>
              <SecretReenter
                id="sec-password"
                label="Password"
                configured={hasPassword}
                value={form.password}
                onChange={(v) => set("password", v)}
                placeholder="Enter a password"
                configuredHint="A password is already stored (never shown). Replace it or leave it as is."
              />
            </div>
          </div>

          <div className="h-px bg-border" />

          <ToggleRow
            id="sec-disable-inference-auth"
            label="Disable authentication on inference calls"
            badge={<Badge tone="muted">Deprecating soon</Badge>}
            description="When enabled, inference API calls (chat completions, embeddings, etc.) will not require authentication. Admin API calls still require authentication."
            checked={form.disableInferenceAuth}
            onCheckedChange={(v) => set("disableInferenceAuth", v)}
            source={sourceOf(sources, "disableInferenceAuth")}
          >
            {form.disableInferenceAuth && (
              <Caution>
                Inference endpoints will accept unauthenticated traffic. Only
                enable this behind a trusted network boundary.
              </Caution>
            )}
          </ToggleRow>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <ToggleRow
            id="sec-enforce-vk"
            label="Enforce Virtual Keys on Inference"
            description="Require a virtual key for all inference requests."
            checked={form.enforceVirtualKeys}
            onCheckedChange={(v) => set("enforceVirtualKeys", v)}
            source={sourceOf(sources, "enforceVirtualKeys")}
          />
        </CardContent>
      </Card>

      <TagField
        id="sec-allowed-origins"
        title="Allowed Origins"
        description="Comma-separated list of allowed origins for CORS and WebSocket connections. Localhost origins are always allowed. Each origin must be a complete URL with protocol; wildcards are supported for subdomains, or use * to allow all."
        placeholder="https://app.example.com"
        value={form.allowedOrigins}
        onChange={(v) => set("allowedOrigins", v)}
        source={sourceOf(sources, "allowedOrigins")}
      />
      <TagField
        id="sec-allowed-headers"
        title="Allowed Headers"
        description="Comma-separated list of allowed headers for CORS."
        placeholder="X-Request-Context"
        value={form.allowedHeaders}
        onChange={(v) => set("allowedHeaders", v)}
        source={sourceOf(sources, "allowedHeaders")}
      />
      <TagField
        id="sec-required-headers"
        title="Required Headers"
        description="Comma-separated list of headers that must be present on every request. Requests missing any of these are rejected with a 400. Header names are case-insensitive."
        placeholder="X-Tenant-Key"
        value={form.requiredHeaders}
        onChange={(v) => set("requiredHeaders", v)}
        source={sourceOf(sources, "requiredHeaders")}
      />
      <TagField
        id="sec-whitelisted-routes"
        title="Whitelisted Routes"
        description="Comma-separated list of routes that bypass the auth middleware. System routes such as /health and the session login route are always whitelisted regardless of this setting."
        placeholder="/health"
        value={form.whitelistedRoutes}
        onChange={(v) => set("whitelistedRoutes", v)}
        source={sourceOf(sources, "whitelistedRoutes")}
      />

      <PanelFooter dirty={dirty} busy={busy} onSave={() => onSave(changed)} />
    </div>
  );
}

function Caution({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-sm text-destructive">
      <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function TagField(
  { id, title, description, placeholder, value, onChange, source }: {
    id: string;
    title: string;
    description: string;
    placeholder: string;
    value: string[];
    onChange: (value: string[]) => void;
    source?: ReturnType<typeof sourceOf>;
  },
) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <span className="flex items-center gap-2">
          <Label htmlFor={id} className="font-semibold">{title}</Label>
          <SourceTag source={source} />
        </span>
        <p className="text-sm text-muted-foreground">{description}</p>
        <TagInput
          id={id}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
        />
        <EnvHint source={source} />
      </CardContent>
    </Card>
  );
}
