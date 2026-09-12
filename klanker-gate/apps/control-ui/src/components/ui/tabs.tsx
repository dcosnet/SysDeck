import { cn } from "../../lib/utils";

export interface TabItem {
  value: string;
  label: string;
}

export interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  tabs: TabItem[];
  label: string;
  className?: string;
}

/** Controlled tablist with roving focus (Logs Live/Stored, spec 2.3). */
export function Tabs(
  { value, onValueChange, tabs, label, className }: TabsProps,
) {
  function onKeyDown(event: React.KeyboardEvent, index: number) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = (index + delta + tabs.length) % tabs.length;
    onValueChange(tabs[next].value);
  }
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-1 rounded-lg bg-muted p-1",
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
            id={`tab-${tab.value}`}
            aria-selected={active}
            aria-controls={`panel-${tab.value}`}
            tabIndex={active ? 0 : -1}
            onKeyDown={(event) => onKeyDown(event, index)}
            onClick={() => onValueChange(tab.value)}
            className={cn(
              "hit-target rounded-md px-3 py-1.5 text-sm font-medium",
              "transition-colors duration-(--motion-fast)",
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** Props to spread onto the matching tabpanel container. */
export function tabPanelProps(value: string) {
  return {
    role: "tabpanel" as const,
    id: `panel-${value}`,
    "aria-labelledby": `tab-${value}`,
  };
}
