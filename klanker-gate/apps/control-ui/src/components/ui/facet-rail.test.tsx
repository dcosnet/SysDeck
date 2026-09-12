import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type FacetGroup, FacetRail } from "./facet-rail";

const groups: FacetGroup[] = [
  {
    id: "provider",
    label: "Provider",
    searchable: true,
    options: [
      { value: "openai", label: "OpenAI", count: 12 },
      { value: "anthropic", label: "Anthropic", count: 4 },
    ],
  },
];

describe("FacetRail", () => {
  it("reports checkbox selections through the controlled model", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<FacetRail groups={groups} value={{}} onChange={onChange} />);

    await user.click(
      screen.getByRole("checkbox", { name: "Provider: OpenAI" }),
    );
    expect(onChange).toHaveBeenCalledWith("provider", ["openai"]);
  });

  it("filters options with the inner search box", async () => {
    const user = userEvent.setup();
    render(<FacetRail groups={groups} value={{}} onChange={vi.fn()} />);

    await user.type(
      screen.getByRole("searchbox", { name: "Filter Provider" }),
      "anth",
    );
    expect(screen.getByRole("checkbox", { name: "Provider: Anthropic" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Provider: OpenAI" }))
      .toBeNull();
  });
});
