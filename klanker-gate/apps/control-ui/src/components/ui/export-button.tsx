import { Download } from "lucide-react";
import { Button, type ButtonSize, type ButtonVariant } from "./button";
import { type CsvColumn, downloadCsv, toCsv } from "../../lib/csv";

export interface ExportButtonProps<T> {
  rows: T[];
  columns: CsvColumn<T>[];
  /** Download file name, e.g. "virtual-keys.csv". */
  filename: string;
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  className?: string;
  /** Called with the generated CSV text after the download is triggered. */
  onExport?: (csv: string) => void;
}

/**
 * Client-side CSV export trigger (spec: "Export CSV"). Builds the CSV from the
 * given rows/columns and hands it to the browser as a same-origin download.
 * Disabled when there is nothing to export.
 */
export function ExportButton<T>(
  {
    rows,
    columns,
    filename,
    label = "Export CSV",
    variant = "outline",
    size = "sm",
    disabled,
    className,
    onExport,
  }: ExportButtonProps<T>,
) {
  function run() {
    const csv = toCsv(rows, columns);
    downloadCsv(filename, csv);
    onExport?.(csv);
  }

  return (
    <Button
      variant={variant}
      size={size}
      disabled={disabled || rows.length === 0}
      onClick={run}
      className={className}
    >
      <Download aria-hidden="true" />
      {label}
    </Button>
  );
}
