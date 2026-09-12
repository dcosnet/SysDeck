import { RefreshCw } from "lucide-react";
import type { LogEntry } from "../../api";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { type Column, DataTable } from "../ui/data-table";
import {
  ALL_COLUMNS,
  classifyOutcome,
  type ColumnKey,
  entryTokens,
  formatCostUsd,
  formatLatency,
  formatTimestamp,
  requestType,
} from "./logs-model";
import { cn } from "../../lib/utils";

export type Connection = "connecting" | "streaming" | "disconnected";

type Row = LogEntry & { _id: string };

const reduceMotion = () =>
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

/**
 * Honest placeholder for a row that carries no value in this column. Inference
 * requests record provider/model/tokens; a health probe or an admin API call
 * has none, so those rows keep saying N/A rather than borrowing a value.
 */
function NaCell({ mono }: { mono?: boolean }) {
  return (
    <span
      title="Not recorded"
      className={cn("text-muted-foreground", mono && "font-mono")}
    >
      N/A
    </span>
  );
}

/** Tokens cell: total, with the prompt/completion split and cost in the title. */
function TokensCell({ entry }: { entry: LogEntry }) {
  const total = entryTokens(entry);
  if (total === null) {
    return <NaCell mono />;
  }
  const parts = [
    `${entry.promptTokens ?? 0} prompt`,
    `${entry.completionTokens ?? 0} completion`,
  ];
  if (typeof entry.costMicroUsd === "number") {
    parts.push(formatCostUsd(entry.costMicroUsd));
  }
  return (
    <span
      className="whitespace-nowrap font-mono text-xs"
      title={parts.join(", ")}
    >
      {total.toLocaleString()}
    </span>
  );
}

function MessageCell({ entry }: { entry: LogEntry }) {
  const head = [entry.method, entry.path].filter(Boolean).join(" ");
  return (
    <div className="min-w-0 max-w-lg">
      {head && (
        <div
          className="truncate font-mono text-xs text-foreground"
          title={head}
        >
          {head}
        </div>
      )}
      <div
        className={cn(
          "truncate text-xs",
          head ? "text-muted-foreground" : "text-foreground",
        )}
        title={entry.message}
      >
        {entry.message}
      </div>
    </div>
  );
}

function StatusCell({ entry }: { entry: LogEntry }) {
  const outcome = classifyOutcome(entry);
  if (outcome === "success") {
    return <Badge tone="ok">success</Badge>;
  }
  if (outcome === "error") {
    return (
      <Badge tone="err">
        {typeof entry.status === "number" ? entry.status : "error"}
      </Badge>
    );
  }
  if (outcome === "cancelled") {
    return <Badge tone="warn">cancelled</Badge>;
  }
  return <Badge tone="muted">processing</Badge>;
}

const COLUMN_DEFS: Record<ColumnKey, Column<Row>> = {
  time: {
    key: "time",
    header: "Time",
    sortValue: (row) => Date.parse(row.ts) || 0,
    cell: (row) => (
      <span className="whitespace-nowrap font-mono text-xs">
        {formatTimestamp(row.ts)}
      </span>
    ),
  },
  type: {
    key: "type",
    header: "Type",
    sortValue: (row) => requestType(row) ?? "",
    cell: (row) => {
      const type = requestType(row);
      return type
        ? <span className="whitespace-nowrap text-xs">{type}</span>
        : <NaCell />;
    },
  },
  provider: {
    key: "provider",
    header: "Provider",
    sortValue: (row) => row.provider ?? "",
    cell: (row) =>
      row.provider
        ? (
          <span className="whitespace-nowrap text-xs" title={row.provider}>
            {row.provider}
          </span>
        )
        : <NaCell />,
  },
  model: {
    key: "model",
    header: "Model",
    sortValue: (row) => row.model ?? "",
    cell: (row) =>
      row.model
        ? (
          <span
            className="block max-w-56 truncate font-mono text-xs"
            title={row.model}
          >
            {row.model}
          </span>
        )
        : <NaCell mono />,
  },
  message: {
    key: "message",
    header: "Message",
    cell: (row) => <MessageCell entry={row} />,
  },
  latency: {
    key: "latency",
    header: "Latency",
    sortValue: (row) => row.durationMs ?? -1,
    cell: (row) => {
      const latency = formatLatency(row.durationMs);
      return latency
        ? <span className="whitespace-nowrap font-mono text-xs">{latency}</span>
        : <NaCell mono />;
    },
  },
  tokens: {
    key: "tokens",
    header: "Tokens",
    sortValue: (row) => entryTokens(row) ?? -1,
    cell: (row) => <TokensCell entry={row} />,
  },
  status: {
    key: "status",
    header: "Status",
    cell: (row) => <StatusCell entry={row} />,
  },
};

export interface LogsTableProps {
  entries: LogEntry[];
  visibleColumns: Set<string>;
  live: boolean;
  connection: Connection;
  loading: boolean;
  onReconnect: () => void;
}

export function LogsTable(
  { entries, visibleColumns, live, connection, loading, onReconnect }:
    LogsTableProps,
) {
  const rows: Row[] = entries.map((entry, index) => ({
    ...entry,
    _id: `${index}-${entry.ts}-${entry.requestId ?? ""}`,
  }));

  const columns = ALL_COLUMNS
    .filter((column) => visibleColumns.has(column.key))
    .map((column) => COLUMN_DEFS[column.key]);

  return (
    <div className="flex flex-col gap-2">
      {live && <LiveBar connection={connection} onReconnect={onReconnect} />}
      <DataTable<Row>
        caption="Request logs"
        rows={rows}
        columns={columns}
        getRowId={(row) => row._id}
        pageSize={25}
        loading={loading}
        initialSort={{ key: "time", dir: "desc" }}
        minWidth="60rem"
        empty={
          <div className="flex flex-col items-center gap-1 py-4">
            <p className="text-sm font-medium text-foreground">
              No results found
            </p>
            <p className="text-xs text-muted-foreground">
              Try adjusting your filters and/or time range.
            </p>
          </div>
        }
      />
    </div>
  );
}

function LiveBar(
  { connection, onReconnect }: {
    connection: Connection;
    onReconnect: () => void;
  },
) {
  const label = connection === "streaming"
    ? "Listening for logs"
    : connection === "connecting"
    ? "Connecting to log stream"
    : "Disconnected from log stream";

  return (
    <div
      aria-live="polite"
      className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
    >
      <RefreshCw
        aria-hidden="true"
        className={cn(
          "size-3.5",
          connection === "streaming" && !reduceMotion() && "animate-spin",
        )}
      />
      <span className="flex-1">{label}</span>
      {connection === "disconnected" && (
        <Button variant="outline" size="sm" onClick={onReconnect}>
          Reconnect
        </Button>
      )}
    </div>
  );
}
