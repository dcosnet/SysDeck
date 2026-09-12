import { useCallback, useEffect, useState } from "react";
import {
  getSettings,
  putSettings,
  type SettingsGroup,
  type SettingsView as SettingsTree,
} from "../api";
import { PageHeader } from "../components/ui/page-header";
import { Banner } from "../components/ui/banner";
import { Card, CardContent } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { UnderlineTabs } from "../components/ui/nav-tabs";
import { tabPanelProps } from "../components/ui/tabs";
import { useToast } from "../components/ui/toast";
import { SecurityPanel } from "../components/settings/SecurityPanel";
import { CompatibilityPanel } from "../components/settings/CompatibilityPanel";
import { CachingPanel } from "../components/settings/CachingPanel";
import { PerformancePanel } from "../components/settings/PerformancePanel";
import { McpPanel } from "../components/settings/McpPanel";
import { ConfigPanel } from "../components/settings/ConfigPanel";

const SUB_TABS = [
  { value: "security", label: "Security" },
  { value: "compatibility", label: "Compatibility" },
  { value: "caching", label: "Caching" },
  { value: "performance", label: "Performance" },
  { value: "mcp", label: "MCP" },
  { value: "config", label: "Config" },
];

const VALID = new Set(SUB_TABS.map((t) => t.value));

/** Read the settings sub-route ("#/settings/<sub>") from the hash. */
function subFromHash(): string {
  const raw = location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/");
  const sub = parts[1] ?? "";
  return VALID.has(sub) ? sub : "security";
}

/**
 * Settings view: the shared sub-navigation (Security / Compatibility / Caching
 * / Performance / MCP) plus the filled panels. Each panel binds to one group's
 * `values`; on save it PUTs only the changed fields of that group so the
 * gateway's shallow top-level merge never drops a sibling group's redacted
 * secret. The active sub-page is reflected in the hash for deep links.
 */
export function SettingsView() {
  const toast = useToast();
  const [sub, setSub] = useState<string>(() => subFromHash());
  const [tree, setTree] = useState<SettingsTree | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onHash() {
      setSub(subFromHash());
    }
    globalThis.addEventListener("hashchange", onHash);
    return () => globalThis.removeEventListener("hashchange", onHash);
  }, []);

  const reload = useCallback(async () => {
    try {
      const next = await getSettings();
      setTree(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function select(next: string) {
    setSub(next);
    try {
      history.replaceState(null, "", `#/settings/${next}`);
    } catch {
      // hash write unavailable: state is still authoritative
    }
  }

  async function saveGroup(
    group: SettingsGroup,
    values: Record<string, unknown>,
  ) {
    if (Object.keys(values).length === 0) {
      return;
    }
    setBusy(true);
    try {
      const next = await putSettings({ [group]: values });
      setTree(next);
      setError(null);
      toast.success("Changes saved");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  const settings = tree?.settings ?? {};

  function renderPanel() {
    switch (sub) {
      case "compatibility":
        return (
          <CompatibilityPanel
            section={settings.compatibility}
            busy={busy}
            onSave={(v) => void saveGroup("compatibility", v)}
          />
        );
      case "caching":
        return (
          <CachingPanel
            section={settings.caching}
            busy={busy}
            onSave={(v) => void saveGroup("caching", v)}
          />
        );
      case "performance":
        return (
          <PerformancePanel
            section={settings.performance}
            busy={busy}
            onSave={(v) => void saveGroup("performance", v)}
          />
        );
      case "mcp":
        return (
          <McpPanel
            section={settings.mcp}
            busy={busy}
            onSave={(v) => void saveGroup("mcp", v)}
          />
        );
      case "config":
        // Owns its own loading and error state (raw config export/import), so
        // it renders outside the settings-tree gate below.
        return <ConfigPanel />;
      default:
        return (
          <SecurityPanel
            section={settings.security}
            busy={busy}
            onSave={(v) => void saveGroup("security", v)}
          />
        );
    }
  }

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Gateway security, compatibility, caching, performance, MCP, and raw configuration"
      />
      <UnderlineTabs
        label="Settings sections"
        value={sub}
        onValueChange={select}
        tabs={SUB_TABS}
        className="mb-5"
      />
      {error && <Banner tone="error" className="mb-5">{error}</Banner>}
      <div {...tabPanelProps(sub)}>
        {
          /* The Config panel loads its own data, so it must not wait on the
            settings tree - gating it would show a skeleton forever if
            /api/settings were the failing call. */
        }
        {sub === "config" || loaded ? renderPanel() : <LoadingPanel />}
      </div>
    </div>
  );
}

function LoadingPanel() {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4" aria-hidden="true">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-2/3" />
      </CardContent>
    </Card>
  );
}
