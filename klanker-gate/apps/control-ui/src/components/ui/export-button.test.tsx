import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExportButton } from "./export-button";
import type { CsvColumn } from "../../lib/csv";

interface Row {
  name: string;
  used: number;
}

const rows: Row[] = [{ name: "alpha", used: 3 }];
const columns: CsvColumn<Row>[] = [
  { header: "Name", value: (r) => r.name },
  { header: "Used", value: (r) => r.used },
];

beforeEach(() => {
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(
    () => "blob:mock",
  );
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

describe("ExportButton", () => {
  it("builds CSV from rows and reports it via onExport", async () => {
    const onExport = vi.fn();
    const user = userEvent.setup();
    render(
      <ExportButton
        rows={rows}
        columns={columns}
        filename="keys.csv"
        onExport={onExport}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Export CSV/ }));
    expect(onExport).toHaveBeenCalledWith("Name,Used\r\nalpha,3");
  });

  it("is disabled when there is nothing to export", () => {
    render(<ExportButton rows={[]} columns={columns} filename="keys.csv" />);
    expect(screen.getByRole("button", { name: /Export CSV/ })).toBeDisabled();
  });
});
