import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { type Column, DataTable } from "./data-table";

interface Row {
  id: string;
  name: string;
  used: number;
}

const rows: Row[] = [
  { id: "a", name: "beta", used: 30 },
  { id: "b", name: "alpha", used: 10 },
  { id: "c", name: "gamma", used: 20 },
];

const columns: Column<Row>[] = [
  {
    key: "name",
    header: "Name",
    cell: (r) => r.name,
    sortValue: (r) => r.name,
  },
  {
    key: "used",
    header: "Used",
    cell: (r) => r.used,
    sortValue: (r) => r.used,
  },
];

function firstBodyName(): string {
  const bodyRows = screen.getAllByRole("row").slice(1);
  return bodyRows[0].textContent ?? "";
}

describe("DataTable", () => {
  it("sorts on header click and reflects aria-sort", async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        caption="Keys"
        pageSize={10}
      />,
    );

    const nameHeader = screen.getByRole("columnheader", { name: /Name/ });
    expect(nameHeader).toHaveAttribute("aria-sort", "none");

    await user.click(screen.getByRole("button", { name: "Name" }));
    expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
    expect(firstBodyName()).toContain("alpha");

    await user.click(screen.getByRole("button", { name: "Name" }));
    expect(nameHeader).toHaveAttribute("aria-sort", "descending");
    expect(firstBodyName()).toContain("gamma");
  });

  it("paginates with the footer controls", async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        caption="Keys"
        pageSize={2}
      />,
    );

    expect(screen.getByText("Showing 1-2 of 3")).toBeInTheDocument();
    expect(screen.queryByText("gamma")).toBeNull();

    await user.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getByText("gamma")).toBeInTheDocument();
    expect(screen.getByText("Showing 3-3 of 3")).toBeInTheDocument();
  });

  it("renders a custom empty state and no data rows while loading", () => {
    const { rerender } = render(
      <DataTable
        columns={columns}
        rows={[]}
        getRowId={(r) => r.id}
        caption="Keys"
        empty={<span>Nothing here.</span>}
      />,
    );
    expect(screen.getByText("Nothing here.")).toBeInTheDocument();

    rerender(
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        caption="Keys"
        loading
      />,
    );
    expect(screen.queryByText("beta")).toBeNull();
  });
});
