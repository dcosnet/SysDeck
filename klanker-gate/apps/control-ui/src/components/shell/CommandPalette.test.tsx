import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

const items = [
  { id: "providers", label: "Providers", group: "Gateway" },
  { id: "logs", label: "Logs", group: "Gateway" },
  { id: "dashboard", label: "Dashboard", group: "Analytics" },
];

describe("CommandPalette", () => {
  it("filters views by query and selects with Enter", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        open
        items={items}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    // The search input's accessible name is "Command menu" (no pinned token).
    const input = screen.getByRole("textbox", { name: "Command menu" });
    await user.type(input, "dash");

    expect(screen.getByRole("option", { name: /Dashboard/ }))
      .toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Providers/ })).toBeNull();

    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("dashboard");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("navigates on click", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <CommandPalette
        open
        items={items}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("option", { name: /Logs/ }));
    expect(onSelect).toHaveBeenCalledWith("logs");
  });

  it("shows an empty message when nothing matches", async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette
        open
        items={items}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.type(
      screen.getByRole("textbox", { name: "Command menu" }),
      "zzzz",
    );
    expect(screen.getByText("No matching views.")).toBeInTheDocument();
  });

  it("renders nothing while closed", () => {
    const { container } = render(
      <CommandPalette
        open={false}
        items={items}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
