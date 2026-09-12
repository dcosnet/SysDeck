import { type ReactNode, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
} from "lucide-react";
import { cn } from "../../lib/utils";
import {
  clampPage,
  pageInfo,
  paginate,
  type SortDir,
  sortRows,
} from "../../lib/table";
import {
  ScrollContainer,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";
import { TableSkeleton } from "./skeleton";
import { Button } from "./button";

export interface Column<T> {
  /** Stable id: sort-state key and React key for the column. */
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Provide to make the column sortable. */
  sortValue?: (row: T) => string | number;
  /** Accessible label for the sort button when `header` is not plain text. */
  headerLabel?: string;
  align?: "left" | "right" | "center";
  className?: string;
  headClassName?: string;
  width?: string;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  /** Screen-reader caption; also labels the horizontal scroll region. */
  caption: string;
  /** Rows per page; omit to render every row without a footer. */
  pageSize?: number;
  loading?: boolean;
  /** Rendered when there are zero rows (and not loading). */
  empty?: ReactNode;
  /** Optional trailing actions cell (kebab menu, buttons) per row. */
  rowMenu?: (row: T) => ReactNode;
  /** Accessible label for the trailing actions column. */
  rowMenuLabel?: string;
  initialSort?: { key: string; dir: SortDir };
  onRowClick?: (row: T) => void;
  minWidth?: string;
  stickyHeader?: boolean;
  className?: string;
}

const ALIGN: Record<"left" | "right" | "center", string> = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
};

/**
 * Generic columned table over the presentational table primitives (spec:
 * replaces per-view hand-rolled SortableHead). Owns sort and pagination state
 * via lib/table helpers; exposes sticky header, horizontal scroll, loading and
 * empty states, and an optional row-actions slot.
 */
export function DataTable<T>(
  {
    columns,
    rows,
    getRowId,
    caption,
    pageSize,
    loading = false,
    empty,
    rowMenu,
    rowMenuLabel = "Actions",
    initialSort,
    onRowClick,
    minWidth,
    stickyHeader = true,
    className,
  }: DataTableProps<T>,
) {
  const [sortKey, setSortKey] = useState<string | null>(
    initialSort?.key ?? null,
  );
  const [sortDir, setSortDir] = useState<SortDir>(initialSort?.dir ?? "asc");
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    const column = columns.find((c) => c.key === sortKey);
    if (!column?.sortValue) {
      return rows;
    }
    return sortRows(rows, column.sortValue, sortDir);
  }, [rows, columns, sortKey, sortDir]);

  const total = sorted.length;
  const size = pageSize ?? total;
  const safePage = clampPage(page, total, size);
  const pageRows = pageSize ? paginate(sorted, safePage, size) : sorted;
  const info = pageInfo(total, safePage, size);
  const colCount = columns.length + (rowMenu ? 1 : 0);

  function onSort(column: Column<T>) {
    if (!column.sortValue) {
      return;
    }
    if (sortKey === column.key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(column.key);
      setSortDir("asc");
    }
    setPage(0);
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <ScrollContainer
        label={caption}
        minWidth={minWidth}
        className="border border-border"
      >
        <Table>
          <TableCaption>{caption}</TableCaption>
          <TableHeader
            className={cn(
              stickyHeader && "sticky top-0 z-(--z-sticky)",
              "bg-card",
            )}
          >
            <TableRow className="hover:bg-transparent">
              {columns.map((column) => {
                const active = sortKey === column.key;
                const Icon = !column.sortValue
                  ? null
                  : !active
                  ? ChevronsUpDown
                  : sortDir === "asc"
                  ? ArrowUp
                  : ArrowDown;
                return (
                  <TableHead
                    key={column.key}
                    style={column.width ? { width: column.width } : undefined}
                    aria-sort={column.sortValue
                      ? active
                        ? sortDir === "asc" ? "ascending" : "descending"
                        : "none"
                      : undefined}
                    className={cn(
                      column.align && ALIGN[column.align],
                      column.headClassName,
                    )}
                  >
                    {column.sortValue
                      ? (
                        <button
                          type="button"
                          onClick={() => onSort(column)}
                          aria-label={column.headerLabel
                            ? `Sort by ${column.headerLabel}`
                            : undefined}
                          className={cn(
                            "hit-target -mx-1 inline-flex items-center gap-1",
                            "rounded px-1 uppercase tracking-wide",
                            "hover:text-foreground",
                            active && "text-foreground",
                            column.align === "right" && "flex-row-reverse",
                          )}
                        >
                          {column.header}
                          {Icon && (
                            <Icon aria-hidden="true" className="size-3" />
                          )}
                        </button>
                      )
                      : column.header}
                  </TableHead>
                );
              })}
              {rowMenu && (
                <TableHead className="w-0 text-right">
                  <span className="sr-only-focusable">{rowMenuLabel}</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading
              ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={colCount} className="py-3">
                    <TableSkeleton cols={colCount} />
                  </TableCell>
                </TableRow>
              )
              : total === 0
              ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={colCount}
                    className="py-10 text-center text-muted-foreground"
                  >
                    {empty ?? "No results."}
                  </TableCell>
                </TableRow>
              )
              : (
                pageRows.map((row) => (
                  <TableRow
                    key={getRowId(row)}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={onRowClick ? "cursor-pointer" : undefined}
                  >
                    {columns.map((column) => (
                      <TableCell
                        key={column.key}
                        className={cn(
                          column.align && ALIGN[column.align],
                          column.className,
                        )}
                      >
                        {column.cell(row)}
                      </TableCell>
                    ))}
                    {rowMenu && (
                      <TableCell className="text-right">
                        {rowMenu(row)}
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
          </TableBody>
        </Table>
      </ScrollContainer>
      {pageSize && total > 0 && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{info.label}</p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={safePage <= 0}
              onClick={() => setPage(safePage - 1)}
            >
              <ChevronLeft aria-hidden="true" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={safePage >= info.pageCount - 1}
              onClick={() => setPage(safePage + 1)}
            >
              Next
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
