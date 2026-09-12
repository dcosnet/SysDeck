import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TimeRangePicker } from "./time-range-picker";

describe("TimeRangePicker", () => {
  it("shows the current range and selects another from the menu", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<TimeRangePicker value="1h" onChange={onChange} />);

    const trigger = screen.getByRole("button", {
      name: "Time range: Last hour",
    });
    await user.click(trigger);

    expect(screen.getByRole("menuitemradio", { name: "Last hour" }))
      .toHaveAttribute("aria-checked", "true");

    await user.click(
      screen.getByRole("menuitemradio", { name: "Last 7 days" }),
    );
    expect(onChange).toHaveBeenCalledWith("7d");
  });
});
