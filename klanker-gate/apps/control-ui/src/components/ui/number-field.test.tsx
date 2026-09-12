import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NumberField } from "./number-field";

describe("NumberField", () => {
  it("renders label, constraints, unit and help text", () => {
    render(
      <NumberField
        label="Timeout"
        value="30"
        onChange={vi.fn()}
        min={0}
        max={120}
        step={5}
        unit="seconds"
        help="Idle timeout"
      />,
    );
    const input = screen.getByRole("spinbutton", { name: "Timeout" });
    expect(input).toHaveValue(30);
    expect(input).toHaveAttribute("min", "0");
    expect(input).toHaveAttribute("max", "120");
    expect(screen.getByText("seconds")).toBeInTheDocument();
    expect(screen.getByText("Idle timeout")).toBeInTheDocument();
  });

  it("emits the raw string on change", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<NumberField label="Retries" value="3" onChange={onChange} />);
    await user.type(screen.getByRole("spinbutton", { name: "Retries" }), "1");
    expect(onChange).toHaveBeenCalledWith("31");
  });
});
