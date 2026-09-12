import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DropdownMenu } from "./dropdown-menu";

function items(onEdit = vi.fn(), onDelete = vi.fn()) {
  return [
    { id: "edit", label: "Edit", onSelect: onEdit },
    { id: "delete", label: "Delete", onSelect: onDelete, destructive: true },
  ];
}

describe("DropdownMenu", () => {
  it("opens, roves focus with arrows, and activates with Enter", async () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const user = userEvent.setup();
    render(
      <DropdownMenu items={items(onEdit, onDelete)} label="Row actions" />,
    );

    const trigger = screen.getByRole("button", { name: "Row actions" });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<DropdownMenu items={items()} label="Row actions" />);
    const trigger = screen.getByRole("button", { name: "Row actions" });

    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("selects an item on click", async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(<DropdownMenu items={items(onEdit)} label="Row actions" />);

    await user.click(screen.getByRole("button", { name: "Row actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
