export type CsvValue = string | number | boolean | null | undefined;

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => CsvValue;
}

const NEEDS_QUOTE = /[",\r\n]/;
// Leading characters a spreadsheet may interpret as a formula.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Escape a single cell to RFC-4180 rules. String values that begin with a
 * spreadsheet formula character are prefixed with a quote to blunt CSV
 * injection; numbers pass through untouched so exports stay numeric.
 */
export function escapeCsvCell(input: CsvValue): string {
  if (input === null || input === undefined) {
    return "";
  }
  let text = String(input);
  if (typeof input === "string" && FORMULA_LEAD.test(text)) {
    text = `'${text}`;
  }
  if (NEEDS_QUOTE.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Serialize rows to a CSV string with a header line (CRLF terminated). */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const header = columns.map((column) => escapeCsvCell(column.header)).join(
    ",",
  );
  if (rows.length === 0) {
    return header;
  }
  const body = rows
    .map((row) =>
      columns.map((column) => escapeCsvCell(column.value(row))).join(",")
    )
    .join("\r\n");
  return `${header}\r\n${body}`;
}

/** Trigger a browser download of `csv` under `filename`. */
export function downloadCsv(filename: string, csv: string): void {
  const bom = String.fromCharCode(0xFEFF);
  // Prepend a BOM (U+FEFF) so Excel reads UTF-8 correctly.
  const blob = new Blob([bom + csv], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
