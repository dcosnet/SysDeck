export type SortDir = "asc" | "desc";

/**
 * Stable-ish sort by a derived key. Strings compare with localeCompare so
 * casing and accents order naturally; numbers compare numerically. The input
 * array is never mutated.
 */
export function sortRows<T>(
  rows: T[],
  key: (row: T) => string | number,
  dir: SortDir,
): T[] {
  const decorated = rows.map((row, index) => ({ row, index, k: key(row) }));
  decorated.sort((a, b) => {
    let cmp: number;
    if (typeof a.k === "number" && typeof b.k === "number") {
      cmp = a.k - b.k;
    } else {
      cmp = String(a.k).localeCompare(String(b.k), undefined, {
        numeric: true,
        sensitivity: "base",
      });
    }
    // Fall back to original order to keep the sort stable.
    return cmp !== 0 ? cmp : a.index - b.index;
  });
  const ordered = decorated.map((d) => d.row);
  return dir === "asc" ? ordered : ordered.reverse();
}

/** Slice `rows` to a single zero-based page. */
export function paginate<T>(rows: T[], page: number, pageSize: number): T[] {
  if (pageSize <= 0) {
    return rows;
  }
  const start = page * pageSize;
  return rows.slice(start, start + pageSize);
}

export interface PageInfo {
  start: number;
  end: number;
  pageCount: number;
  /** Human label, e.g. "Showing 1-10 of 42". */
  label: string;
}

/** Clamp a page index into range for a given total and page size. */
export function clampPage(
  page: number,
  total: number,
  pageSize: number,
): number {
  const count = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  return Math.min(Math.max(0, page), count - 1);
}

/** 1-based display bounds + label for the pagination footer. */
export function pageInfo(
  total: number,
  page: number,
  pageSize: number,
): PageInfo {
  const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  if (total === 0) {
    return { start: 0, end: 0, pageCount, label: "Showing 0 of 0" };
  }
  const start = page * pageSize + 1;
  const end = Math.min(total, (page + 1) * pageSize);
  return {
    start,
    end,
    pageCount,
    label: `Showing ${start}-${end} of ${total}`,
  };
}
