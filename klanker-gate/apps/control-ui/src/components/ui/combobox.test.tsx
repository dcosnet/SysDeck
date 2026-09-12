import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Combobox, type ComboboxOption } from "./combobox";

const options: ComboboxOption[] = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry" },
];

describe("Combobox", () => {
  it("filters by type-ahead and commits the active option with Enter", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Combobox
        options={options}
        value={null}
        onChange={onChange}
        label="Fruit"
      />,
    );

    const input = screen.getByRole("combobox", { name: "Fruit" });
    await user.type(input, "ban");
    expect(screen.getByRole("option", { name: "Banana" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Apple" })).toBeNull();

    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("banana");
  });

  it("navigates with arrow keys and selects on click", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Combobox
        options={options}
        value={null}
        onChange={onChange}
        label="Fruit"
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Fruit" }));
    await user.click(screen.getByRole("option", { name: "Cherry" }));
    expect(onChange).toHaveBeenCalledWith("cherry");
  });

  it("shows the empty message when nothing matches", async () => {
    const user = userEvent.setup();
    render(
      <Combobox
        options={options}
        value={null}
        onChange={vi.fn()}
        label="Fruit"
        emptyText="No fruit."
      />,
    );
    await user.type(screen.getByRole("combobox", { name: "Fruit" }), "zzz");
    expect(screen.getByText("No fruit.")).toBeInTheDocument();
  });
});
