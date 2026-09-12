import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TwoPane } from "./two-pane";

describe("TwoPane", () => {
  it("exposes labelled list and detail regions", () => {
    render(
      <TwoPane
        listLabel="Providers"
        detailLabel="Configuration"
        list={<p>rail content</p>}
        detail={<p>pane content</p>}
      />,
    );
    expect(screen.getByRole("complementary", { name: "Providers" }))
      .toHaveTextContent("rail content");
    expect(screen.getByRole("region", { name: "Configuration" }))
      .toHaveTextContent("pane content");
  });

  it("resizes the rail from the keyboard within its bounds", () => {
    render(
      <TwoPane
        listLabel="Providers"
        detailLabel="Configuration"
        listWidth="18rem"
        minListWidth={224}
        maxListWidth={512}
        list={<p>rail</p>}
        detail={<p>pane</p>}
      />,
    );
    const handle = screen.getByRole("separator", { name: "Resize providers" });
    // 18rem at the jsdom-default 16px root = 288px.
    expect(handle).toHaveAttribute("aria-valuenow", "288");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "304");

    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle).toHaveAttribute("aria-valuenow", "224");

    fireEvent.keyDown(handle, { key: "End" });
    expect(handle).toHaveAttribute("aria-valuenow", "512");
  });
});
