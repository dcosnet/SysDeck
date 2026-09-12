import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SubTabs, UnderlineTabs } from "./nav-tabs";

const tabs = [
  { value: "overview", label: "Overview" },
  { value: "usage", label: "Provider Usage" },
  { value: "rankings", label: "Model Rankings" },
];

describe("NavTabs", () => {
  it("marks the active pill tab and moves selection with arrow keys", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <SubTabs
        value="overview"
        onValueChange={onChange}
        tabs={tabs}
        label="Dashboard sections"
      />,
    );

    const active = screen.getByRole("tab", { name: "Overview" });
    expect(active).toHaveAttribute("aria-selected", "true");

    active.focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith("usage");
  });

  it("selects a tab on click", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <SubTabs
        value="overview"
        onValueChange={onChange}
        tabs={tabs}
        label="Dashboard sections"
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Model Rankings" }));
    expect(onChange).toHaveBeenCalledWith("rankings");
  });

  it("renders the underline variant as a tablist", () => {
    render(
      <UnderlineTabs
        value="usage"
        onValueChange={vi.fn()}
        tabs={tabs}
        label="Provider config"
      />,
    );
    expect(screen.getByRole("tablist", { name: "Provider config" }))
      .toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Provider Usage" }))
      .toHaveAttribute("aria-selected", "true");
  });
});
