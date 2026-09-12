import { useId, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "../../lib/utils";
import { Collapsible } from "./collapsible";
import { Checkbox } from "./checkbox";
import { Badge } from "./badge";

export interface FacetOption {
  value: string;
  label: string;
  count?: number;
}

export interface FacetGroup {
  id: string;
  label: string;
  options: FacetOption[];
  /** Show an inner filter box above the checkbox list. */
  searchable?: boolean;
  defaultOpen?: boolean;
}

export interface FacetRailProps {
  groups: FacetGroup[];
  /** groupId -> selected option values. */
  value: Record<string, string[]>;
  onChange: (groupId: string, values: string[]) => void;
  title?: string;
  className?: string;
}

/**
 * Collapsible facet groups with checkbox lists (spec: Logs filters). Fully
 * controlled selection model; each group is a Disclosure with an optional
 * inner search. The selected count surfaces as a badge in the group header.
 */
export function FacetRail(
  { groups, value, onChange, title, className }: FacetRailProps,
) {
  const [queries, setQueries] = useState<Record<string, string>>({});

  function toggle(groupId: string, option: string, checked: boolean) {
    const current = value[groupId] ?? [];
    const next = checked
      ? [...current, option]
      : current.filter((item) => item !== option);
    onChange(groupId, next);
  }

  return (
    <div className={cn("flex flex-col", className)}>
      {title && (
        <p className="px-1 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
      )}
      {groups.map((group) => {
        const selected = value[group.id] ?? [];
        const query = (queries[group.id] ?? "").toLowerCase();
        const options = query
          ? group.options.filter((option) =>
            option.label.toLowerCase().includes(query)
          )
          : group.options;
        return (
          <Collapsible
            key={group.id}
            title={group.label}
            defaultOpen={group.defaultOpen ?? true}
            aside={selected.length > 0
              ? <Badge tone="muted">{selected.length}</Badge>
              : undefined}
          >
            <div className="flex flex-col gap-2 pl-6">
              {group.searchable && (
                <FacetSearch
                  label={`Filter ${group.label}`}
                  value={queries[group.id] ?? ""}
                  onChange={(next) =>
                    setQueries((prev) => ({ ...prev, [group.id]: next }))}
                />
              )}
              <ul className="flex flex-col gap-1.5">
                {options.length === 0
                  ? (
                    <li className="text-xs text-muted-foreground">
                      No matches.
                    </li>
                  )
                  : options.map((option) => (
                    <li key={option.value}>
                      <FacetCheckbox
                        groupLabel={group.label}
                        option={option}
                        checked={selected.includes(option.value)}
                        onToggle={(checked) =>
                          toggle(group.id, option.value, checked)}
                      />
                    </li>
                  ))}
              </ul>
            </div>
          </Collapsible>
        );
      })}
    </div>
  );
}

function FacetSearch(
  { label, value, onChange }: {
    label: string;
    value: string;
    onChange: (value: string) => void;
  },
) {
  const id = useId();
  return (
    <div className="relative">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <input
        id={id}
        type="search"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "h-(--control-h-sm) w-full rounded-md border border-input bg-card",
          "pl-7 pr-2 text-sm text-foreground placeholder:text-muted-foreground",
        )}
        placeholder="Filter..."
      />
    </div>
  );
}

function FacetCheckbox(
  { groupLabel, option, checked, onToggle }: {
    groupLabel: string;
    option: FacetOption;
    checked: boolean;
    onToggle: (checked: boolean) => void;
  },
) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className="hit-target flex cursor-pointer items-center gap-2 text-sm"
    >
      <Checkbox
        id={id}
        checked={checked}
        aria-label={`${groupLabel}: ${option.label}`}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <span className="flex-1 min-w-0 truncate text-foreground">
        {option.label}
      </span>
      {option.count !== undefined && (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {option.count}
        </span>
      )}
    </label>
  );
}
