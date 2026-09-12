import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SegmentedSelect } from "./segmented-select";

const options = [
  { value: "default", label: "Default" },
  { value: "override", label: "Override" },
];

describe("SegmentedSelect", () => {
  it("exposes a radiogroup with the selected segment checked", () => {
    render(
      <SegmentedSelect
        options={options}
        value="default"
        onChange={vi.fn()}
        label="Override mode"
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Override mode" }))
      .toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Default" }))
      .toHaveAttribute("aria-checked", "true");
  });

  it("selects on click and on arrow-key roving", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <SegmentedSelect
        options={options}
        value="default"
        onChange={onChange}
        label="Override mode"
      />,
    );

    await user.click(screen.getByRole("radio", { name: "Override" }));
    expect(onChange).toHaveBeenCalledWith("override");

    onChange.mockClear();
    screen.getByRole("radio", { name: "Default" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith("override");
  });
});
