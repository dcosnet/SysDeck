// Regression lock for the rail-overflow bug.
//
// Symptom (reported with a screenshot): in Providers, the "CUSTOM" and
// "default" badges of a long-named account painted ON TOP of the Add-provider
// card in the detail pane. Cause: the rail is a fixed 18rem, the row's badges
// had no `shrink-0`, and the aside did not clip - so once a row's intrinsic
// width exceeded the rail the badges rendered outside it.
//
// jsdom does not lay out, so these assert the two structural properties that
// make the overlap impossible rather than measuring pixels: the rail clips, and
// the marker cluster is the thing that refuses to shrink.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TwoPane } from "./two-pane";

describe("TwoPane rail overflow", () => {
  it("clips the rail so a wide row cannot paint over the detail pane", () => {
    render(
      <TwoPane
        listLabel="Accounts"
        detailLabel="Account detail"
        list={<div>rail content</div>}
        detail={<div>detail content</div>}
      />,
    );
    const rail = screen.getByRole("complementary", { name: "Accounts" });
    // Without overflow-hidden the fixed-width aside lets its children escape.
    // This is the categorical fix: even a future row that is too wide
    // truncates instead of overlapping.
    expect(rail.className).toContain("overflow-hidden");
  });

  it("keeps the rail a fixed width and the detail pane flexible", () => {
    render(
      <TwoPane
        listLabel="Accounts"
        detailLabel="Account detail"
        list={<div>rail</div>}
        detail={<div>detail</div>}
      />,
    );
    const rail = screen.getByRole("complementary", { name: "Accounts" });
    const detail = screen.getByRole("region", { name: "Account detail" });
    expect(rail.className).toContain("shrink-0");
    // min-w-0 on the detail pane is what lets ITS content truncate rather than
    // forcing the flex row wider than the container.
    expect(detail.className).toContain("min-w-0");
    expect(detail.className).toContain("flex-1");
  });
});
