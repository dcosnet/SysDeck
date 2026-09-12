import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LogsView } from "./views/LogsView";
import { apiFetch, clearAdminToken, saveAdminToken } from "./api";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("LogsView fetch-SSE (security #9: no EventSource)", () => {
  it("streams the log via fetch and renders replayed frames", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (input) => {
        const url = String(input);
        if (url.includes("/api/logs/stream")) {
          const entry = {
            ts: "12:00:00",
            level: "info",
            message: "GET /v1/models",
            status: 200,
          };
          return Promise.resolve(
            sseResponse([`data: ${JSON.stringify(entry)}\n\n`]),
          );
        }
        if (url.includes("/api/logs/stored")) {
          return Promise.resolve(jsonResponse({ entries: [], total: 0 }));
        }
        return Promise.resolve(jsonResponse({}));
      },
    );

    render(<LogsView />);

    // The Logs view renders immediately (Live is the default source).
    expect(screen.getByText(/Live request stream and stored history/))
      .toBeInTheDocument();

    // The replayed SSE frame is decoded and rendered.
    await waitFor(() =>
      expect(screen.getByText(/GET \/v1\/models/)).toBeInTheDocument()
    );

    // The stream was consumed via fetch, and no EventSource was constructed.
    expect(
      fetchSpy.mock.calls.some((call) =>
        String(call[0]).includes("/api/logs/stream")
      ),
    ).toBe(true);
    const fake = (globalThis as Record<string, unknown>).__FakeEventSource as {
      instances: unknown[];
    };
    expect(fake.instances.length).toBe(0);
  });
});

describe("apiFetch auth scope (security #2)", () => {
  it("attaches Bearer only to /api/* and not to /healthz or /v1/*", async () => {
    saveAdminToken("secret-token-value");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(jsonResponse({})));

    await apiFetch("/api/config");
    await apiFetch("/healthz");
    await apiFetch("/v1/models");

    const authFor = (path: string): string | null => {
      const call = fetchSpy.mock.calls.find((c) => String(c[0]) === path);
      return new Headers(call?.[1]?.headers).get("Authorization");
    };

    expect(authFor("/api/config")).toBe("Bearer secret-token-value");
    expect(authFor("/healthz")).toBeNull();
    expect(authFor("/v1/models")).toBeNull();

    clearAdminToken();
  });
});
