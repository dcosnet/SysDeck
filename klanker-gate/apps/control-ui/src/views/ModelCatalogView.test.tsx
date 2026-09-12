import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelCatalogView } from "./ModelCatalogView";
import { resetEurRate } from "../lib/currency";

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function populatedCatalog() {
  return {
    providers: [
      {
        id: "OpenAI",
        type: "openai",
        custom: false,
        models: ["gpt-4o", "gpt-4o-mini"],
        traffic24h: 1234,
        cost24h: 12.3456,
      },
      {
        id: "lm-studio",
        type: "lmstudio",
        custom: true,
        // Eight models exercises the "+N more" overflow (limit is 6).
        models: [
          "m-one",
          "m-two",
          "m-three",
          "m-four",
          "m-five",
          "m-six",
          "m-seven",
          "m-eight",
        ],
        traffic24h: 8,
        cost24h: 0,
      },
    ],
    totals: { providers: 6, models: 1103, requests24h: 12345, cost24h: 7.5 },
  };
}

function mockCatalog(view: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url.includes("/api/catalog")) {
      return Promise.resolve(jsonOk(view, status));
    }
    return Promise.resolve(jsonOk({}));
  });
}

describe("ModelCatalogView", () => {
  // Reset the memoized EUR rate so each test starts at the default 0.92 (the
  // fetch mock returns {} for /api/config, so ensureEurRate keeps the default).
  beforeEach(() => resetEurRate());

  it("renders KPI tiles and a provider row per catalog entry", async () => {
    mockCatalog(populatedCatalog());
    render(<ModelCatalogView />);

    // KPI tiles: labels plus their formatted (grouped / €x.xxxx) values.
    expect(await screen.findByText("Total Providers")).toBeInTheDocument();
    expect(screen.getByText("6")).toBeInTheDocument();
    expect(screen.getByText("Total Models")).toBeInTheDocument();
    expect(screen.getByText("1,103")).toBeInTheDocument();
    expect(screen.getByText("Total Requests (24h)")).toBeInTheDocument();
    expect(screen.getByText("12,345")).toBeInTheDocument();
    // "Total Cost (24h)" labels both the KPI tile and the sortable column, so
    // it legitimately appears twice; the unique EUR value proves the tile
    // (7.5 USD * 0.92 default rate -> €6.9000).
    expect(screen.getAllByText("Total Cost (24h)").length)
      .toBeGreaterThanOrEqual(1);
    expect(screen.getByText("€6.9000")).toBeInTheDocument();

    // Provider rows: name, custom badge, model chips, mono traffic/cost.
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("lm-studio")).toBeInTheDocument();
    expect(screen.getByText("Custom")).toBeInTheDocument();
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
    // 12.3456 USD * 0.92 -> 11.357952 -> toFixed(4) "€11.3580"; 0 -> "€0.0000".
    expect(screen.getByText("€11.3580")).toBeInTheDocument();
    expect(screen.getByText("€0.0000")).toBeInTheDocument();
  });

  it("collapses long model lists behind a +N more toggle", async () => {
    mockCatalog(populatedCatalog());
    const user = userEvent.setup();
    render(<ModelCatalogView />);

    // First six models show; the seventh/eighth hide behind "+2 more".
    expect(await screen.findByText("m-six")).toBeInTheDocument();
    expect(screen.queryByText("m-seven")).toBeNull();
    const toggle = screen.getByRole("button", { name: "+2 more" });

    await user.click(toggle);
    expect(screen.getByText("m-seven")).toBeInTheDocument();
    expect(screen.getByText("m-eight")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show less" }))
      .toBeInTheDocument();
  });

  it("filters the table to a single provider via the combobox", async () => {
    mockCatalog(populatedCatalog());
    const user = userEvent.setup();
    render(<ModelCatalogView />);

    // Both providers present before filtering.
    expect(await screen.findByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("lm-studio")).toBeInTheDocument();

    await user.click(
      screen.getByRole("combobox", { name: "Filter by provider" }),
    );
    await user.click(await screen.findByRole("option", { name: "lm-studio" }));

    // Only the chosen provider remains in the table.
    await waitFor(() => expect(screen.queryByText("OpenAI")).toBeNull());
    expect(screen.getByText("lm-studio")).toBeInTheDocument();
  });

  it("refreshes a provider's models via the per-row button", async () => {
    const fetchMock = mockCatalog(populatedCatalog());
    const user = userEvent.setup();
    render(<ModelCatalogView />);

    // One refresh button per row; click the OpenAI row's control.
    const refresh = await screen.findByRole("button", {
      name: "Refresh models for OpenAI",
    });
    await user.click(refresh);

    // The POST to refresh-models fires, and the catalog is re-fetched after.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/providers/OpenAI/refresh-models")
        ),
      ).toBe(true)
    );
    const catalogCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/api/catalog")
    );
    expect(catalogCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("shows the honest empty state when the catalog is unavailable (404)", async () => {
    mockCatalog({ error: "not found" }, 404);
    render(<ModelCatalogView />);

    // 404 normalizes to an empty catalog: no tiles, just the feature-off notice.
    expect(await screen.findByText("No data available")).toBeInTheDocument();
    expect(screen.queryByText("Total Providers")).toBeNull();
  });

  it("opens a model toggle grid on row click and saves the enabled subset", async () => {
    const puts: Array<{ id: string; body: Record<string, unknown> }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/available-models")) {
        return Promise.resolve(
          jsonOk({
            id: "OpenAI",
            models: ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"],
          }),
        );
      }
      if (url.includes("/api/catalog")) {
        return Promise.resolve(jsonOk(populatedCatalog()));
      }
      const putMatch = url.match(/\/api\/providers\/([^/?]+)$/);
      if (putMatch && method === "PUT") {
        puts.push({ id: putMatch[1], body: JSON.parse(String(init?.body)) });
        return Promise.resolve(jsonOk({ id: putMatch[1], type: "openai" }));
      }
      return Promise.resolve(jsonOk({}));
    });
    const user = userEvent.setup();
    render(<ModelCatalogView />);

    await user.click(await screen.findByText("OpenAI"));

    // Modal lists the full live model set; enabled ones are on, extras are off.
    const dialog = await screen.findByRole("dialog");
    const extra = await within(dialog).findByRole("switch", {
      name: "gpt-3.5-turbo",
    });
    expect(extra).toHaveAttribute("aria-checked", "false");
    expect(within(dialog).getByRole("switch", { name: "gpt-4o" }))
      .toHaveAttribute("aria-checked", "true");

    // Enable the extra model, then persist the enabled subset.
    await user.click(extra);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(puts.length).toBeGreaterThan(0));
    expect(puts[0].id).toBe("OpenAI");
    expect(puts[0].body.models).toEqual([
      "gpt-3.5-turbo",
      "gpt-4o",
      "gpt-4o-mini",
    ]);
  });
});
