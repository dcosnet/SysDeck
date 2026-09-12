import { useState } from "react";
import { PanelLeftClose, Search } from "lucide-react";
import { type FacetGroup, FacetRail } from "../ui/facet-rail";
import { Collapsible } from "../ui/collapsible";
import { Checkbox } from "../ui/checkbox";
import type { LogEntry } from "../../api";
import {
  type FacetSelection,
  facetValues,
  HONEST_FACETS,
  OUTCOME_LABEL,
  OUTCOME_ORDER,
  type OutcomeCounts,
  VALUE_FACETS,
  type ValueFacet,
} from "./logs-model";

export interface LogsFacetRailProps {
  /** Selected outcome classes (facet-rail controlled model). */
  outcome: string[];
  onOutcomeChange: (values: string[]) => void;
  /** Per-class counts over the currently loaded (time+search filtered) logs. */
  counts: OutcomeCounts;
  /** Entries the live value facets enumerate their options from. */
  entries: LogEntry[];
  /** Selected values per live facet (model / provider / type). */
  selection: FacetSelection;
  onSelectionChange: (id: ValueFacet["id"], values: string[]) => void;
  onHide: () => void;
}

/**
 * Left filter rail for the Logs view. Outcome, Models, Provider, and Type are
 * live facets backed by recorded fields (Type is projected from the recorded
 * path). The groups below them are the faithful professional shell shown
 * honest-empty, because the gateway records none of those dimensions on a log
 * entry - except Cost, which is recorded per entry but has no range filter.
 */
export function LogsFacetRail(
  {
    outcome,
    onOutcomeChange,
    counts,
    entries,
    selection,
    onSelectionChange,
    onHide,
  }: LogsFacetRailProps,
) {
  const outcomeGroup: FacetGroup = {
    id: "outcome",
    label: "Outcome",
    defaultOpen: true,
    options: OUTCOME_ORDER.map((value) => ({
      value,
      label: OUTCOME_LABEL[value],
      count: counts[value],
    })),
  };

  return (
    <div className="flex flex-col">
      <div className="mb-1 flex items-center justify-between px-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Filters
        </p>
        <button
          type="button"
          aria-label="Hide filters"
          onClick={onHide}
          className="hit-target inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-accent hover:text-foreground [&_svg]:size-4"
        >
          <PanelLeftClose aria-hidden="true" />
        </button>
      </div>

      {
        /* Wrapped so the group keeps a bottom divider: FacetRail strips the
          border on its last group, which is the only group we pass it. */
      }
      <div className="border-b border-border">
        <FacetRail
          groups={[outcomeGroup]}
          value={{ outcome }}
          onChange={(_, values) => onOutcomeChange(values)}
        />
      </div>

      {VALUE_FACETS.map((facet) => (
        <ValueFacetGroup
          key={facet.id}
          facet={facet}
          entries={entries}
          selected={selection[facet.id] ?? []}
          onChange={(values) => onSelectionChange(facet.id, values)}
        />
      ))}

      {HONEST_FACETS.map((facet) => (
        <Collapsible key={facet.id} title={facet.label}>
          <div className="pl-6">
            <NotRecorded recorded={facet.recorded} />
          </div>
        </Collapsible>
      ))}
    </div>
  );
}

/**
 * One live facet: distinct recorded values over the loaded entries, each with
 * an occurrence count. Renders the same empty affordance as the honest groups
 * when the current window happens to contain no entry carrying the dimension.
 */
function ValueFacetGroup(
  { facet, entries, selected, onChange }: {
    facet: ValueFacet;
    entries: LogEntry[];
    selected: string[];
    onChange: (values: string[]) => void;
  },
) {
  const [query, setQuery] = useState("");
  const options = facetValues(entries, facet);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? options.filter((option) => option.value.toLowerCase().includes(needle))
    : options;

  const toggle = (value: string, checked: boolean) => {
    onChange(
      checked
        ? [...selected, value]
        : selected.filter((entry) => entry !== value),
    );
  };

  return (
    <Collapsible title={facet.label} defaultOpen={facet.id === "model"}>
      <div className="flex flex-col gap-2 pl-6">
        {facet.searchable && (
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              aria-label={`Filter ${facet.label}`}
              value={query}
              disabled={options.length === 0}
              placeholder={`Search ${facet.label.toLowerCase()}`}
              onChange={(event) => setQuery(event.target.value)}
              className="h-(--control-h-sm) w-full rounded-md border border-input bg-card pl-7 pr-2 text-sm text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>
        )}
        {options.length === 0
          ? <NoneInWindow />
          : (
            <ul className="flex flex-col gap-0.5">
              {shown.map((option) => (
                <li key={option.value}>
                  <label className="hit-target flex cursor-pointer items-center gap-2 rounded-sm text-sm">
                    <Checkbox
                      checked={selected.includes(option.value)}
                      aria-label={`${facet.label}: ${option.value}`}
                      onChange={(event) =>
                        toggle(option.value, event.target.checked)}
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-foreground"
                      title={option.value}
                    >
                      {option.value}
                    </span>
                    <span className="tabular-nums text-xs text-muted-foreground">
                      {option.count}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
      </div>
    </Collapsible>
  );
}

/** A recorded dimension that simply has no values in the current window. */
function NoneInWindow() {
  return (
    <p
      className="text-xs text-muted-foreground"
      title="No log entry in this window records this dimension"
    >
      None in this range
    </p>
  );
}

/**
 * Affordance for a group with no filter. `recorded` distinguishes "the gateway
 * stores nothing for this" from "it is stored per entry but has no control".
 */
function NotRecorded({ recorded }: { recorded?: boolean }) {
  return recorded
    ? (
      <p
        className="text-xs text-muted-foreground"
        title="Recorded per entry; no filter control"
      >
        No filter yet
      </p>
    )
    : (
      <p className="text-xs text-muted-foreground" title="Not recorded on logs">
        Not recorded yet
      </p>
    );
}
