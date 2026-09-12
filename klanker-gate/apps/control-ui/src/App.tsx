import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Boxes,
  Building2,
  CircleDollarSign,
  KeyRound,
  LayoutDashboard,
  Menu,
  Plug,
  Puzzle,
  ScrollText,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import { ProvidersView } from "./views/ProvidersView";
import { StatusView } from "./views/StatusView";
import { LogsView } from "./views/LogsView";
import { ExtensionsView } from "./views/ExtensionsView";
import { ModelCatalogView } from "./views/ModelCatalogView";
import { SettingsView } from "./views/SettingsView";
import { VirtualKeysView } from "./views/VirtualKeysView";
import { TeamsView } from "./views/TeamsView";
import { CustomersView } from "./views/CustomersView";
import { PricingView } from "./views/PricingView";
import { DashboardView } from "./views/DashboardView";
import { type NavItem, Sidebar } from "./components/shell/Sidebar";
import { CommandPalette } from "./components/shell/CommandPalette";
import { AdminTokenDialog } from "./components/shell/AdminTokenDialog";
import { ToastProvider } from "./components/ui/toast";
import { Banner } from "./components/ui/banner";
import { Button } from "./components/ui/button";
import { type AuthState, hasAdminToken, subscribeAuth } from "./api";

const NAV: NavItem[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    group: "Overview",
    icon: LayoutDashboard,
  },
  { id: "logs", label: "Logs", group: "Overview", icon: ScrollText },
  { id: "status", label: "Status", group: "Overview", icon: Activity },
  { id: "providers", label: "Providers", group: "Gateway", icon: Plug },
  {
    id: "model-catalog",
    label: "Model Catalog",
    group: "Gateway",
    icon: Boxes,
  },
  { id: "extensions", label: "Extensions", group: "Gateway", icon: Puzzle },
  {
    id: "virtual-keys",
    label: "Virtual keys",
    group: "Governance",
    icon: KeyRound,
  },
  { id: "teams", label: "Teams", group: "Governance", icon: Users },
  { id: "customers", label: "Customers", group: "Governance", icon: Building2 },
  {
    id: "pricing",
    label: "Pricing",
    group: "Governance",
    icon: CircleDollarSign,
  },
  {
    id: "settings",
    label: "Settings",
    group: "System",
    icon: SlidersHorizontal,
  },
];

const IDS = NAV.map((item) => item.id);

/**
 * Hashes that pointed at views which are now Settings tabs. Without this a
 * bookmarked #/cache would fall through to the default view, which looks like a
 * broken link rather than a reorganization.
 */
const REDIRECTS: Record<string, string> = {
  cache: "settings/caching",
  config: "settings/config",
};

/** Resolve a legacy hash to its replacement route, or null when current. */
export function redirectFor(hash: string): string | null {
  const raw = hash.replace(/^#\/?/, "");
  const base = raw.split("/")[0];
  const target = REDIRECTS[base];
  // Only redirect a BARE legacy hash. "#/cache/anything" is not a route this
  // app ever minted, so rewriting it would invent a destination.
  return target && raw === base ? target : null;
}

/** First hash segment -> view id, tolerating sub-routes like "settings/mcp". */
function baseSegment(hash: string): string {
  return hash.replace(/^#\/?/, "").split("/")[0];
}

function hashToView(hash: string): string {
  const base = baseSegment(hash);
  return IDS.includes(base) ? base : "providers";
}

/**
 * Rewrites a legacy hash in place before routing. Uses replaceState, not a
 * push, so the browser Back button does not bounce between the old hash and
 * its replacement.
 */
function applyRedirect(hash: string): boolean {
  const target = redirectFor(hash);
  if (!target) {
    return false;
  }
  try {
    history.replaceState(null, "", `#/${target}`);
  } catch {
    // hash write unavailable: fall through and route by state alone
  }
  return true;
}

function renderView(id: string) {
  switch (id) {
    case "dashboard":
      return <DashboardView />;
    case "model-catalog":
      return <ModelCatalogView />;
    case "settings":
      return <SettingsView />;
    case "status":
      return <StatusView />;
    case "logs":
      return <LogsView />;
    case "extensions":
      return <ExtensionsView />;
    case "virtual-keys":
      return <VirtualKeysView />;
    case "teams":
      return <TeamsView />;
    case "customers":
      return <CustomersView />;
    case "pricing":
      return <PricingView />;
    default:
      return <ProvidersView />;
  }
}

function App() {
  const [view, setView] = useState<string>(() => {
    applyRedirect(location.hash);
    return hashToView(location.hash);
  });
  const [authState, setAuthState] = useState<AuthState>("unknown");
  const [authNonce, setAuthNonce] = useState(0);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("frosty.sidebar") === "rail";
    } catch {
      return false;
    }
  });
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light"
  );

  useEffect(() => subscribeAuth(setAuthState), []);

  // Global command palette shortcut (Cmd/Ctrl-K); cleaned up on unmount.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    }
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, []);

  const firstRender = useRef(true);
  useEffect(() => {
    // Focus the active view heading on nav change so screen readers announce
    // the new context (spec section 4). Skip the initial mount.
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    document.querySelector<HTMLHeadingElement>("#main h2")?.focus();
  }, [view]);

  useEffect(() => {
    function onHash() {
      // React only to known view hashes; in-page anchors (e.g. Extensions'
      // "#tools") must not hijack the router. Sub-routes ("settings/mcp") map
      // to their base view, which owns the sub-navigation.
      applyRedirect(location.hash);
      const base = baseSegment(location.hash);
      if (IDS.includes(base)) {
        setView(base);
      }
    }
    globalThis.addEventListener("hashchange", onHash);
    return () => globalThis.removeEventListener("hashchange", onHash);
  }, []);

  function navigate(id: string) {
    setView(id);
    setMobileNavOpen(false);
    try {
      history.replaceState(null, "", `#/${id}`);
    } catch {
      // hash write unavailable: state is still authoritative
    }
  }

  function toggleCollapse() {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem("frosty.sidebar", next ? "rail" : "expanded");
      } catch {
        // preference is best-effort
      }
      return next;
    });
  }

  function toggleTheme() {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      const root = document.documentElement;
      root.classList.toggle("dark", next === "dark");
      root.dataset.theme = next;
      try {
        localStorage.setItem("frosty.theme", next);
      } catch {
        // preference is best-effort
      }
      return next;
    });
  }

  const tokenStatus = authState === "denied"
    ? "denied"
    : hasAdminToken()
    ? "ok"
    : "none";

  return (
    <ToastProvider>
      <div className="flex h-screen overflow-hidden">
        <a href="#main" className="sr-only-focusable">Skip to content</a>
        {mobileNavOpen && (
          <div
            className="fixed inset-0 z-(--z-overlay) bg-foreground/40 md:hidden"
            aria-hidden="true"
            onClick={() => setMobileNavOpen(false)}
          />
        )}
        <Sidebar
          items={NAV}
          activeId={view}
          onNavigate={navigate}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapse}
          tokenStatus={tokenStatus}
          onOpenToken={() => setTokenOpen(true)}
          theme={theme}
          onToggleTheme={toggleTheme}
          mobileOpen={mobileNavOpen}
          onMobileClose={() => setMobileNavOpen(false)}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 border-b border-border px-4 py-2 md:hidden">
            <button
              type="button"
              aria-label="Open navigation"
              onClick={() => setMobileNavOpen(true)}
              className="hit-target grid size-9 place-items-center rounded-md hover:bg-accent"
            >
              <Menu aria-hidden="true" className="size-5" />
            </button>
            <span aria-hidden="true" className="font-semibold tracking-tight">
              Klanker Gateway Manager
            </span>
          </div>
          {authState === "denied" && (
            <div className="px-6 pt-4">
              <Banner
                tone="error"
                action={
                  <Button size="sm" onClick={() => setTokenOpen(true)}>
                    Set token
                  </Button>
                }
              >
                Admin token required. The gateway rejected the last request
                (401).
              </Banner>
            </div>
          )}
          <main
            id="main"
            tabIndex={-1}
            className="min-h-0 flex-1 overflow-y-auto py-6 outline-none px-(--gutter)"
          >
            <div
              key={`${view}:${authNonce}`}
              className="mx-auto w-full max-w-(--container-max)"
            >
              {renderView(view)}
            </div>
          </main>
        </div>
      </div>
      <AdminTokenDialog
        open={tokenOpen}
        onClose={() => setTokenOpen(false)}
        onTokenChange={() => setAuthNonce((n) => n + 1)}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={NAV}
        onSelect={navigate}
      />
    </ToastProvider>
  );
}

export default App;
