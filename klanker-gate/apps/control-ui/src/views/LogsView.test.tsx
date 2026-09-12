import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the transport: LogsView owns all runtime api calls (probe, stored query,
// SSE stream, clear). Components under components/logs only import api types.
vi.mock("../api", () => {
  class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
      this.name = "ApiError";
    }
  }
  return {
    ApiError,
    getStoredLogs: vi.fn(),
    readLogStream: vi.fn(),
    clearStoredLogs: vi.fn(),
  };
});

import * as api from "../api";
import type { LogEntry } from "../api";
import { LogsView } from "./LogsView";

function streamEntries(): LogEntry[] {
  const now = Date.now();
  return [
    {
      ts: new Date(now - 3000).toISOString(),
      level: "info",
      message: "chat completion ok",
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      durationMs: 120,
      requestId: "req-success",
      // Inference enrichment the gateway records via the telemetry bridge.
      provider: "openai",
      model: "gpt-4o",
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      costMicroUsd: 7500,
    },
    {
      ts: new Date(now - 1500).toISOString(),
      level: "error",
      message: "upstream failed",
      method: "POST",
      path: "/v1/embeddings",
      status: 500,
      durationMs: 80,
      requestId: "req-error",
    },
  ];
}

beforeEach(() => {
  vi.mocked(api.getStoredLogs).mockResolvedValue({ entries: [], total: 0 });
  vi.mocked(api.clearStoredLogs).mockResolvedValue({ deleted: 0 });
  const stream = streamEntries();
  vi.mocked(api.readLogStream).mockImplementation(
    (onEntry, _signal, onOpen) => {
      onOpen?.();
      for (const entry of stream) {
        onEntry(entry);
      }
      // Never resolves: the stream stays "connected" for the test's lifetime.
      return new Promise<void>(() => {});
    },
  );
});

describe("LogsView", () => {
  it("streams live logs and renders the recorded inference fields", async () => {
    render(<LogsView />);

    expect(await screen.findByRole("heading", { name: "Logs", level: 2 }))
      .toBeInTheDocument();
    expect(await screen.findByText("Listening for logs")).toBeInTheDocument();
    expect(await screen.findByText("chat completion ok")).toBeInTheDocument();
    expect(screen.getByText("upstream failed")).toBeInTheDocument();

    // Real status mapping: 200 -> success pill, 500 -> error pill.
    expect(screen.getByText("success")).toBeInTheDocument();
    expect(screen.getByText("500")).toBeInTheDocument();

    // Enriched row: provider, model, derived type, and total tokens.
    expect(screen.getByRole("cell", { name: "openai" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "gpt-4o" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "chat" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "1,500" })).toBeInTheDocument();

    // The unenriched row still says N/A: row-level honesty, not a fabricated 0.
    expect(screen.getAllByText("N/A").length).toBeGreaterThan(0);
  });

  it("totals tokens and cost across the visible logs", async () => {
    render(<LogsView />);
    await screen.findByText("chat completion ok");

    // 1500 tokens over the one entry that recorded usage: once in the KPI
    // tile, once in that entry's Tokens cell.
    expect(screen.getAllByText("1,500")).toHaveLength(2);
    expect(screen.getByText("over 1 request")).toBeInTheDocument();
    // 7500 micro-USD -> $0.0075, kept sub-cent rather than rounded to $0.00.
    expect(screen.getByText("$0.007500")).toBeInTheDocument();
  });

  it("replaces a row in place when the gateway patches it mid-stream", async () => {
    // A streamed response is logged before its usage exists, then republished
    // with the same requestId once the stream completes. The view must upsert:
    // appending would duplicate the row, and discarding would lose the usage.
    const [first] = streamEntries();
    vi.mocked(api.readLogStream).mockImplementation((onEntry, _s, onOpen) => {
      onOpen?.();
      const { provider: _p, model: _m, totalTokens: _t, ...pending } = first;
      onEntry({ ...pending, promptTokens: undefined } as LogEntry);
      onEntry(first); // the late patch, same requestId
      return new Promise<void>(() => {});
    });

    render(<LogsView />);
    await screen.findByText("chat completion ok");

    // One row, and it carries the patched values.
    expect(screen.getAllByText("chat completion ok")).toHaveLength(1);
    expect(screen.getByRole("cell", { name: "gpt-4o" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "1,500" })).toBeInTheDocument();
  });

  it("filters the table by a live Model facet", async () => {
    const user = userEvent.setup();
    render(<LogsView />);
    await screen.findByText("chat completion ok");

    await user.click(screen.getByRole("checkbox", { name: "Models: gpt-4o" }));

    // Only the entry recording that model survives.
    expect(screen.getByText("chat completion ok")).toBeInTheDocument();
    expect(screen.queryByText("upstream failed")).toBeNull();
  });

  it("filters the table by the Outcome facet", async () => {
    const user = userEvent.setup();
    render(<LogsView />);
    await screen.findByText("chat completion ok");

    await user.click(screen.getByRole("checkbox", { name: "Outcome: Error" }));

    expect(screen.queryByText("chat completion ok")).toBeNull();
    expect(screen.getByText("upstream failed")).toBeInTheDocument();
  });

  it("shows and hides table columns via the column picker", async () => {
    const user = userEvent.setup();
    render(<LogsView />);
    await screen.findByText("chat completion ok");

    expect(screen.getByRole("columnheader", { name: "Latency" }))
      .toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Choose columns" }));
    await user.click(screen.getByRole("checkbox", { name: "Latency" }));

    expect(screen.queryByRole("columnheader", { name: "Latency" })).toBeNull();
  });

  it("renders honest-empty facets for dimensions logs do not record", async () => {
    const user = userEvent.setup();
    render(<LogsView />);
    await screen.findByText("chat completion ok");

    // Models is live now that the gateway records the dimension.
    const modelsSearch = screen.getByRole("searchbox", {
      name: "Filter Models",
    });
    expect(modelsSearch).toBeEnabled();

    // A dimension the gateway genuinely does not record stays honest-empty.
    await user.click(screen.getByRole("button", { name: "Session" }));
    expect(screen.getByText("Not recorded yet")).toBeInTheDocument();

    // Cost IS recorded per entry, it just has no range filter, so it must not
    // claim to be unrecorded.
    await user.click(screen.getByRole("button", { name: "Cost" }));
    expect(screen.getByText("No filter yet")).toBeInTheDocument();
  });

  it("switches to stored history and queries the server", async () => {
    const user = userEvent.setup();
    const stored: LogEntry[] = [
      {
        ts: new Date().toISOString(),
        level: "info",
        message: "stored history line",
        method: "GET",
        path: "/api/models",
        status: 200,
        durationMs: 5,
        requestId: "req-stored",
      },
    ];
    vi.mocked(api.getStoredLogs).mockResolvedValue({
      entries: stored,
      total: stored.length,
    });

    render(<LogsView />);
    await screen.findByText("chat completion ok");

    await user.click(screen.getByRole("button", { name: "Live" }));

    expect(
      await screen.findByText("stored history line", undefined, {
        timeout: 3000,
      }),
    ).toBeInTheDocument();
    expect(vi.mocked(api.getStoredLogs)).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 500 }),
    );
  });
});
