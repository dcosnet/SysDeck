import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Collapsible } from "./collapsible";

describe("Collapsible", () => {
  it("toggles content and aria-expanded (uncontrolled)", async () => {
    const user = userEvent.setup();
    render(
      <Collapsible title="Providers">
        <p>panel body</p>
      </Collapsible>,
    );

    const toggle = screen.getByRole("button", { name: "Providers" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("panel body")).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("panel body")).toBeInTheDocument();
  });

  it("respects the controlled open prop and reports changes", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Collapsible title="Filters" open={false} onOpenChange={onOpenChange}>
        <p>hidden</p>
      </Collapsible>,
    );

    expect(screen.queryByText("hidden")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Filters" }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    // still closed because the parent owns the state
    expect(screen.queryByText("hidden")).toBeNull();
  });
});
