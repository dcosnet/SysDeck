import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ToggleGridItem } from "./toggle-grid-item";

describe("ToggleGridItem", () => {
  it("toggles the switch and invokes the settings action", async () => {
    const onCheckedChange = vi.fn();
    const onSettings = vi.fn();
    const user = userEvent.setup();
    render(
      <ToggleGridItem
        label="Chat Completion"
        checked={false}
        onCheckedChange={onCheckedChange}
        onSettings={onSettings}
      />,
    );

    const toggle = screen.getByRole("switch", { name: "Chat Completion" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    expect(onCheckedChange).toHaveBeenCalledWith(true);

    await user.click(
      screen.getByRole("button", { name: "Settings: Chat Completion" }),
    );
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it("omits the settings button when no handler is provided", () => {
    render(
      <ToggleGridItem label="Speech" checked onCheckedChange={vi.fn()} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
