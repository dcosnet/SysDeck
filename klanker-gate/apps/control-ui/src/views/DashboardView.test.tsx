import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardView } from "./DashboardView";
import { resetEurRate } from "../lib/currency";

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function recentEntries() {
  const now = Date.now();
  return Array.from({ length: 6 }, (_, i) => ({
    ts: new Date(now - i * 1000).toISOString(),
    level: i === 0 ? "error" : "info",
    message: "req",
    method: "GET",
    path: "/v1/models",
    status: i === 0 ? 500 : 200,
    durationMs: 10 + i * 5,
  }));
}

function trackedRollup() {
  return {
    tracked: true,
    window: "24h",
    generatedAt: "2026-07-15T00:00:00.000Z",
    totals: {
      requests: 30,
      promptTokens: 300,
      completionTokens: 150,
      totalTokens: 450,
      costMicroUsd: 4_500_000,
      costUsd: 4.5,
      errorRatePct: 10,
      cacheHits: 8,
      cacheMisses: 2,
    },
    series: Array.from({ length: 12 }, (_, i) => ({
      label: String(i + 1),
      requests: i + 1,
      promptTokens: 10 + i,
      completionTokens: 5 + i,
      totalTokens: 15 + 2 * i,
      costMicroUsd: 100_000 * (i + 1),
      errors: i % 4 === 0 ? 1 : 0,
    })),
    byModel: [
      {
        model: "openai/gpt-4o",
        provider: "openai",
        requests: 20,
        promptTokens: 200,
        completionTokens: 100,
        totalTokens: 300,
        costMicroUsd: 3_000_000,
      },
      {
        model: "anthropic/claude-3-5",
        provider: "anthropic",
        requests: 10,
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        costMicroUsd: 1_500_000,
      },
    ],
    byProvider: [
      {
        provider: "openai",
        requests: 20,
        totalTokens: 300,
        costMicroUsd: 3_000_000,
      },
      {
        provider: "anthropic",
        requests: 10,
        totalTokens: 150,
        costMicroUsd: 1_500_000,
      },
    ],
  };
}

function mockDash(storedOn: boolean, analytics?: unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url.includes("/api/analytics")) {
      return analytics === undefined
        ? Promise.resolve(jsonOk({ error: "analytics not tracked" }, 404))
        : Promise.resolve(jsonOk(analytics));
    }
    if (url.includes("/api/logs/stored")) {
      return storedOn
        ? Promise.resolve(jsonOk({ entries: recentEntries(), total: 6 }))
        : Promise.resolve(jsonOk({ error: "stored logs are off" }, 404));
    }
    return Promise.resolve(jsonOk({}));
  });
}

describe("DashboardView", () => {
  beforeEach(() => {
    resetEurRate();
  });

  it("renders the Dashboard heading and section tabs", async () => {
    mockDash(true, trackedRollup());
    render(<DashboardView />);

    expect(
      await screen.findByRole("heading", { name: "Dashboard" }),
    ).toBeInTheDocument();
    for (const tab of ["Overview", "Provider Usage", "Model Rankings"]) {
      expect(screen.getByRole("tab", { name: tab })).toBeInTheDocument();
    }
  });

  it("paints the overview charts from a tracked rollup", async () => {
    mockDash(true, trackedRollup());
    render(<DashboardView />);

    // Analytics-driven cards render real SVG charts (role=img).
    expect(
      await screen.findByRole("img", { name: "Request volume chart" }),
    ).toBeInTheDocument();
    for (
      const name of ["Token usage chart", "Cost chart", "Model usage chart"]
    ) {
      expect(screen.getByRole("img", { name })).toBeInTheDocument();
    }
    // Latency is supplemented from stored request logs.
    expect(screen.getByRole("img", { name: "Latency chart" }))
      .toBeInTheDocument();
    // Both cache-rate cards are honestly empty (no per-bucket cache series).
    expect(screen.getAllByText("No data available").length)
      .toBeGreaterThanOrEqual(2);
  });

  it("keeps analytics cards empty when the rollup is untracked (404)", async () => {
    mockDash(true); // stored logs on, analytics 404
    render(<DashboardView />);

    // Latency still renders from stored logs...
    expect(
      await screen.findByRole("img", { name: "Latency chart" }),
    ).toBeInTheDocument();
    // ...but every analytics-derived card falls back to the honest empty state.
    expect(screen.getAllByText("No data available").length)
      .toBeGreaterThanOrEqual(5);
  });

  it("surfaces the stored-logs-off note on the latency card", async () => {
    mockDash(false, trackedRollup());
    render(<DashboardView />);

    expect(
      await screen.findByText(/Stored logs are off/),
    ).toBeInTheDocument();
    // Analytics cards are unaffected.
    expect(screen.getByRole("img", { name: "Token usage chart" }))
      .toBeInTheDocument();
  });

  it("ranks models by usage on the Model Rankings tab", async () => {
    mockDash(true, trackedRollup());
    render(<DashboardView />);

    fireEvent.click(await screen.findByRole("tab", { name: "Model Rankings" }));

    // Model names surface in both the ranked bars legend and the table.
    await waitFor(() =>
      expect(screen.getAllByText("openai/gpt-4o").length).toBeGreaterThan(0)
    );
    expect(screen.getAllByText("anthropic/claude-3-5").length)
      .toBeGreaterThan(0);
  });

  it("renders honest empty states for the unrecorded MCP and User tabs", async () => {
    mockDash(true, trackedRollup());
    render(<DashboardView />);

    fireEvent.click(await screen.findByRole("tab", { name: "MCP usage" }));
    expect(
      await screen.findByText(/MCP-level usage is not recorded/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "User Rankings" }));
    expect(
      await screen.findByText(/Per-user usage is not recorded/),
    ).toBeInTheDocument();
  });

  it("marks the per-provider latency card as unrecorded", async () => {
    mockDash(true, trackedRollup());
    render(<DashboardView />);

    fireEvent.click(await screen.findByRole("tab", { name: "Provider Usage" }));
    expect(
      await screen.findByText(/Per-provider latency is not recorded/),
    ).toBeInTheDocument();
    // Provider cost renders from the by-provider rollup.
    expect(screen.getByRole("img", { name: "Provider cost chart" }))
      .toBeInTheDocument();
  });
});
