import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KeyValueRows } from "./key-value-rows";

const rows = [{ name: "X-Test", value: "1" }];

describe("KeyValueRows", () => {
  it("appends a blank pair on Add", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<KeyValueRows value={rows} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Add row" }));
    expect(onChange).toHaveBeenCalledWith([
      { name: "X-Test", value: "1" },
      { name: "", value: "" },
    ]);
  });

  it("edits a cell and removes a row through onChange", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<KeyValueRows value={rows} onChange={onChange} />);

    await user.type(screen.getByRole("textbox", { name: "Name 1" }), "!");
    expect(onChange).toHaveBeenCalledWith([{ name: "X-Test!", value: "1" }]);

    onChange.mockClear();
    await user.click(
      screen.getByRole("button", { name: "Remove name row 1" }),
    );
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
