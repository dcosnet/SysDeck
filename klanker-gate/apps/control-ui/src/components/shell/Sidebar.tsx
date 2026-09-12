import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ChevronRight,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  ShieldCheck,
  Snowflake,
  Sun,
  X,
} from "lucide-react";
import { filterNav, groupsOf } from "../../lib/nav";
import { cn } from "../../lib/utils";

export interface NavItem {
  id: string;
  label: string;
  group: string;
  icon: LucideIcon;
}

export interface SidebarProps {
  items: NavItem[];
  activeId: string;
  onNavigate: (id: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  tokenStatus: "none" | "ok" | "denied";
  onOpenToken: () => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  /** Off-canvas drawer state for < md viewports (spec section 5). */
  mobileOpen: boolean;
  onMobileClose: () => void;
}

const DOT: Record<SidebarProps["tokenStatus"], string> = {
  none: "bg-muted-foreground",
  ok: "bg-success",
  denied: "bg-destructive",
};

const DOT_TITLE: Record<SidebarProps["tokenStatus"], string> = {
  none: "No admin token stored",
  ok: "Admin token accepted",
  denied: "Admin token rejected (401)",
};

export function Sidebar(props: SidebarProps) {
  const {
    items,
    activeId,
    onNavigate,
    collapsed,
    onToggleCollapse,
    tokenStatus,
    onOpenToken,
    theme,
    onToggleTheme,
    mobileOpen,
    onMobileClose,
  } = props;

  const [query, setQuery] = useState("");
  const [roving, setRoving] = useState(activeId);
  const buttonRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const allGroups = useMemo(() => groupsOf(items), [items]);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(allGroups.map((g) => [g, true]))
  );

  useEffect(() => {
    setRoving(activeId);
  }, [activeId]);

  const searching = query.trim().length > 0;
  const filtered = useMemo(() => filterNav(items, query), [items, query]);

  // A group is disclosed when the rail is expanded and either the user has it
  // open or a search is active (search always reveals its matches).
  function groupOpen(group: string): boolean {
    if (collapsed) {
      return true; // icon rail shows every leaf
    }
    return searching || (openGroups[group] ?? true);
  }

  // Flat list of the leaves actually rendered right now, for roving focus.
  const visibleGroups = allGroups
    .map((group) => ({
      group,
      groupItems: filtered.filter((item) => item.group === group),
    }))
    .filter((entry) => entry.groupItems.length > 0);

  const rovingItems: NavItem[] = [];
  for (const { group, groupItems } of visibleGroups) {
    if (groupOpen(group)) {
      rovingItems.push(...groupItems);
    }
  }

  const tabbableId = rovingItems.some((item) => item.id === roving)
    ? roving
    : rovingItems[0]?.id;

  function focusIndex(index: number) {
    if (rovingItems.length === 0) {
      return;
    }
    const clamped = (index + rovingItems.length) % rovingItems.length;
    const id = rovingItems[clamped].id;
    setRoving(id);
    buttonRefs.current.get(id)?.focus();
  }

  function onNavKeyDown(event: React.KeyboardEvent) {
    const current = rovingItems.findIndex((item) => item.id === tabbableId);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusIndex(current + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusIndex(current - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusIndex(rovingItems.length - 1);
    }
  }

  function toggleGroup(group: string) {
    setOpenGroups((prev) => ({ ...prev, [group]: !(prev[group] ?? true) }));
  }

  return (
    <aside
      className={cn(
        "z-(--z-modal) flex flex-col border-r border-sidebar-border bg-sidebar",
        "text-sidebar-foreground",
        "fixed inset-y-0 left-0 w-(--sidebar-width) transition-transform duration-(--motion-default)",
        mobileOpen ? "translate-x-0" : "-translate-x-full",
        "md:static md:z-auto md:shrink-0 md:translate-x-0 md:transition-[width]",
        collapsed ? "md:w-(--sidebar-width-icon)" : "md:w-(--sidebar-width)",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-4">
        <Snowflake
          aria-hidden="true"
          className="size-5 shrink-0 text-sidebar-primary"
        />
        <h1
          className={cn(
            "flex-1 text-base font-semibold tracking-tight",
            collapsed && "md:sr-only",
          )}
        >
          Klanker Gateway Manager
        </h1>
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          className="hit-target hidden size-8 place-items-center rounded-md text-sidebar-foreground hover:bg-sidebar-accent md:grid"
        >
          {collapsed
            ? <PanelLeftOpen aria-hidden="true" className="size-4" />
            : <PanelLeftClose aria-hidden="true" className="size-4" />}
        </button>
        <button
          type="button"
          onClick={onMobileClose}
          aria-label="Close navigation"
          className="hit-target grid size-8 place-items-center rounded-md text-sidebar-foreground hover:bg-sidebar-accent md:hidden"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>

      <div className={cn("px-2 pb-2", collapsed && "md:hidden")}>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="text"
            aria-label="Search views"
            placeholder="Search... (Ctrl K)"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className={cn(
              "h-(--control-h-sm) w-full rounded-md border border-sidebar-border",
              "bg-sidebar-accent/40 pl-8 pr-3 text-sm text-sidebar-foreground",
              "placeholder:text-muted-foreground",
              "focus-visible:border-sidebar-primary",
            )}
          />
        </div>
      </div>

      <nav
        aria-label="Sections"
        onKeyDown={onNavKeyDown}
        className="flex-1 overflow-y-auto px-2 py-1"
      >
        {visibleGroups.length === 0 && (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            No matching views.
          </p>
        )}
        {visibleGroups.map(({ group, groupItems }) => {
          const open = groupOpen(group);
          return (
            <div key={group} className="mb-2">
              <button
                type="button"
                onClick={() => toggleGroup(group)}
                aria-expanded={open}
                className={cn(
                  "flex w-full items-center gap-1 rounded-md px-2 py-1",
                  "text-2xs font-semibold uppercase tracking-wide text-muted-foreground",
                  "hover:text-sidebar-foreground",
                  collapsed && "md:hidden",
                )}
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    "size-3 transition-transform duration-(--motion-fast)",
                    open && "rotate-90",
                  )}
                />
                <span className="flex-1 text-left">{group}</span>
              </button>
              {open && (
                <div className="flex flex-col gap-0.5">
                  {groupItems.map((item) => {
                    const active = item.id === activeId;
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        ref={(el) => {
                          buttonRefs.current.set(item.id, el);
                        }}
                        aria-current={active ? "page" : undefined}
                        tabIndex={item.id === tabbableId ? 0 : -1}
                        title={collapsed ? item.label : undefined}
                        onClick={() => onNavigate(item.id)}
                        className={cn(
                          "hit-target relative flex items-center gap-2.5 rounded-md",
                          "px-2.5 py-2 text-sm font-medium",
                          "transition-colors duration-(--motion-fast)",
                          "before:absolute before:inset-y-1.5 before:left-0",
                          "before:w-0.5 before:rounded-full",
                          active
                            ? "bg-sidebar-accent text-sidebar-accent-foreground before:bg-sidebar-primary"
                            : "text-sidebar-foreground hover:bg-sidebar-accent/60 before:bg-transparent",
                          collapsed && "md:justify-center",
                        )}
                      >
                        <Icon aria-hidden="true" className="size-4 shrink-0" />
                        <span
                          className={cn(
                            "flex-1 text-left",
                            collapsed && "md:sr-only",
                          )}
                        >
                          {item.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="flex flex-col gap-1 border-t border-sidebar-border px-2 py-3">
        <button
          type="button"
          onClick={onOpenToken}
          title={DOT_TITLE[tokenStatus]}
          className={cn(
            "hit-target relative flex items-center gap-2.5 rounded-md px-2.5 py-2",
            "text-sm font-medium hover:bg-sidebar-accent/60",
            collapsed && "md:justify-center",
          )}
        >
          <ShieldCheck aria-hidden="true" className="size-4 shrink-0" />
          <span className={cn("flex-1 text-left", collapsed && "md:sr-only")}>
            Admin token
          </span>
          <span
            aria-hidden="true"
            className={cn("size-2 shrink-0 rounded-full", DOT[tokenStatus])}
          />
        </button>

        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          className={cn(
            "hit-target grid size-8 place-items-center rounded-md",
            "hover:bg-sidebar-accent/60",
            collapsed && "md:mx-auto",
          )}
        >
          {theme === "dark"
            ? <Moon aria-hidden="true" className="size-4" />
            : <Sun aria-hidden="true" className="size-4" />}
        </button>
      </div>
    </aside>
  );
}
