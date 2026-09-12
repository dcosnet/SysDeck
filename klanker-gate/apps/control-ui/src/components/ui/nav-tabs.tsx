import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "../../lib/utils";
import type { TabItem } from "./tabs";

export type NavTabsVariant = "pill" | "underline";

export interface NavTabsProps {
  value: string;
  onValueChange: (value: string) => void;
  tabs: TabItem[];
  /** Accessible name for the tablist. */
  label: string;
  variant?: NavTabsVariant;
  className?: string;
}

/**
 * Horizontal tab navigation distinct from the segmented `Tabs` control:
 * "pill" is the Dashboard sub-tab bar (Overview / Provider Usage / ...),
 * "underline" is the provider-config bar (Network / Proxy / ...). Roving focus
 * with Arrow/Home/End, aria-selected, monochrome active indicator.
 */
export function NavTabs(
  { value, onValueChange, tabs, label, variant = "pill", className }:
    NavTabsProps,
) {
  function onKeyDown(event: ReactKeyboardEvent, index: number) {
    let next = index;
    if (event.key === "ArrowRight") {
      next = (index + 1) % tabs.length;
    } else if (event.key === "ArrowLeft") {
      next = (index - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = tabs.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    onValueChange(tabs[next].value);
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "flex items-center",
        variant === "pill" ? "flex-wrap gap-1" : "gap-4 border-b border-border",
        className,
      )}
    >
      {tabs.map((tab, index) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={`navtab-${tab.value}`}
            aria-selected={active}
            aria-controls={`panel-${tab.value}`}
            tabIndex={active ? 0 : -1}
            onKeyDown={(event) => onKeyDown(event, index)}
            onClick={() => onValueChange(tab.value)}
            className={variant === "pill"
              ? cn(
                "hit-target rounded-md px-3 py-1.5 text-sm font-medium",
                "transition-colors duration-(--motion-fast)",
                active
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )
              : cn(
                "hit-target -mb-px border-b-2 px-1 py-2 text-sm font-medium",
                "transition-colors duration-(--motion-fast)",
                active
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground " +
                    "hover:text-foreground",
              )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** Dashboard-style sub-tab bar (pill-on-row). */
export function SubTabs(props: Omit<NavTabsProps, "variant">) {
  return <NavTabs {...props} variant="pill" />;
}

/** Provider-config-style tab bar (underline active). */
export function UnderlineTabs(props: Omit<NavTabsProps, "variant">) {
  return <NavTabs {...props} variant="underline" />;
}
