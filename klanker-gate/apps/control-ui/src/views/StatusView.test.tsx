import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StatusView } from "./StatusView";
import type { RuntimeView } from "../api";

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function runtime(overrides: Partial<RuntimeView> = {}): RuntimeView {
  return {
    workers: {
      configured: 1,
      effective: 1,
      index: null,
      reusePortSupported: true,
      platform: "linux",
      reason: "single process (FROSTY_WORKERS unset or 1)",
    },
    concurrency: {
      active: 0,
      peak: 0,
      total: 0,
      completed: 0,
      avgLifetimeMs: 0,
      maxLifetimeMs: 0,
      longestOpenMs: 0,
      dispatching: 0,
      peakDispatching: 0,
      since: "2026-07-29T00:00:00.000Z",
      scope: "per-process",
    },
    rateLimit: {
      enforced: false,
      keysWithLimits: 0,
      totalKeys: 0,
      scope: "per-process",
      windows: [],
    },
    postgres: {
      poolSize: 8,
      estimatedFleetConnections: 9,
      target: "db:5432/frosty",
      listenerActive: true,
    },
    cache: { mode: "semantic", sharedTier: true, localEntries: 0 },
    process: { uptimeSeconds: 42, denoVersion: "2.9.3", v8Version: "14" },
    ...overrides,
  };
}

/** Routes every fetch StatusView makes; `runtimeBody` is the case under test. */
function mockFetch(runtimeBody: RuntimeView | "reject") {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(typeof input === "string" ? input : input.toString());
      if (url.includes("/api/runtime")) {
        return runtimeBody === "reject"
          ? Promise.reject(new Error("boom"))
          : Promise.resolve(jsonOk(runtimeBody));
      }
      if (url.includes("/healthz")) {
        return Promise.resolve(jsonOk({
          status: "ok",
          version: "0.9.0",
          timestamp: "2026-07-29T00:00:00.000Z",
        }));
      }
      if (url.includes("/api/version")) {
        return Promise.resolve(jsonOk({ version: "0.9.0", deno: "2.9.3" }));
      }
      if (url.includes("/api/logs")) {
        return Promise.resolve(jsonOk({ logs: [] }));
      }
      if (url.includes("/api/mcp/clients")) {
        return Promise.resolve(jsonOk({ clients: [] }));
      }
      if (url.includes("/api/virtual-keys")) {
        return Promise.resolve(jsonOk({ virtualKeys: [] }));
      }
      if (url.includes("/v1/models")) {
        return Promise.resolve(jsonOk({ data: [] }));
      }
      if (url.includes("/api/config")) {
        return Promise.resolve(jsonOk({ providers: [] }));
      }
      return Promise.resolve(jsonOk({}));
    }),
  );
}

/** StatTile renders its label and value as siblings; read the value. */
function tileValue(label: string): string {
  const node = screen.getByText(label);
  const value = node.parentElement?.children[1];
  return value?.textContent ?? "";
}

describe("StatusView runtime section", () => {
  beforeEach(() => {
    mockFetch(runtime());
  });

  it("renders the connection-lifetime tiles", async () => {
    mockFetch(runtime({
      concurrency: {
        ...runtime().concurrency,
        active: 6,
        peak: 9,
        total: 120,
        completed: 114,
        avgLifetimeMs: 1250,
        maxLifetimeMs: 25003,
        longestOpenMs: 13575,
        dispatching: 1,
        peakDispatching: 3,
      },
    }));
    render(<StatusView />);

    await waitFor(() => expect(tileValue("Connections open")).toBe("6"));
    // Dispatch is a SEPARATE, strictly shorter window: a streamed response
    // returns its handler at once but holds the connection, so these two
    // numbers disagreeing is the normal, correct reading.
    expect(tileValue("Dispatching")).toBe("1");
    expect(tileValue("Longest open")).toBe("13.6s");
    expect(tileValue("Avg lifetime")).toBe("1.3s");
  });

  it("labels sub-second lifetimes in milliseconds", async () => {
    mockFetch(runtime({
      concurrency: {
        ...runtime().concurrency,
        active: 1,
        completed: 3,
        avgLifetimeMs: 4,
        maxLifetimeMs: 19,
        longestOpenMs: 1,
      },
    }));
    render(<StatusView />);
    await waitFor(() => expect(tileValue("Avg lifetime")).toBe("4 ms"));
    expect(tileValue("Longest open")).toBe("1 ms");
  });

  it("says so when nothing is open rather than showing a stale age", async () => {
    render(<StatusView />);
    await waitFor(() =>
      expect(screen.getByText("nothing open")).toBeInTheDocument()
    );
    expect(screen.getByText("no completed connections")).toBeInTheDocument();
  });

  it("warns that counts are per-worker under multiple workers", async () => {
    mockFetch(runtime({
      workers: {
        configured: 4,
        effective: 4,
        index: 2,
        reusePortSupported: true,
        platform: "linux",
        reason: "4 worker processes sharing the port via SO_REUSEPORT",
      },
    }));
    render(<StatusView />);

    await waitFor(() => expect(tileValue("Worker processes")).toBe("4"));
    expect(screen.getByText("worker 2")).toBeInTheDocument();
    // Without the qualifier an operator reads one worker's load as fleet-wide
    // and under-reports by a factor of N.
    expect(screen.getAllByText(/this worker only/).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/admits up to 4 times its stated value/),
    ).toBeInTheDocument();
  });

  it("explains a platform that refused to fan out", async () => {
    mockFetch(runtime({
      workers: {
        configured: 4,
        effective: 1,
        index: null,
        reusePortSupported: false,
        platform: "windows",
        reason: "FROSTY_WORKERS=4 ignored: windows has no SO_REUSEPORT",
      },
    }));
    render(<StatusView />);
    await waitFor(() => expect(tileValue("Worker processes")).toBe("1"));
    expect(screen.getByText("4 requested, windows limit")).toBeInTheDocument();
  });

  it("never renders database credentials", async () => {
    render(<StatusView />);
    await waitFor(() =>
      expect(screen.getByText("db:5432/frosty")).toBeInTheDocument()
    );
    expect(document.body.textContent).not.toMatch(/postgres:\/\//);
  });

  it("degrades to placeholders when the runtime endpoint fails", async () => {
    mockFetch("reject");
    render(<StatusView />);
    // One failing panel must not blank the page: every fetch goes through
    // Promise.allSettled, so the rest of Status still renders.
    await waitFor(() =>
      expect(screen.getByText("Connections open")).toBeInTheDocument()
    );
    expect(screen.getAllByText("unavailable").length).toBeGreaterThan(0);
    expect(screen.getByText("Runtime")).toBeInTheDocument();
  });
});
