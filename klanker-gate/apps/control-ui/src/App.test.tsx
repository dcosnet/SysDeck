import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import { ProvidersView } from "./views/ProvidersView";
import { StatusView } from "./views/StatusView";

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockGateway() {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url.includes("/api/config")) {
      return Promise.resolve(jsonOk({
        defaultProvider: "openai",
        providers: [
          {
            id: "openai",
            type: "openai",
            enabled: true,
            models: ["gpt-4o", "gpt-4o-mini"],
            priority: 0,
            hasApiKey: true,
          },
          {
            id: "anthropic",
            type: "anthropic",
            enabled: false,
            models: [],
            priority: 0,
            hasApiKey: false,
          },
        ],
      }));
    }
    if (url.includes("/healthz")) {
      return Promise.resolve(jsonOk({
        status: "ok",
        version: "0.7.0",
        timestamp: "2026-07-13T00:00:00Z",
      }));
    }
    if (url.includes("/api/version")) {
      return Promise.resolve(jsonOk({ version: "0.7.0", deno: "2.9.2" }));
    }
    if (url.includes("/v1/models")) {
      return Promise.resolve(jsonOk({
        object: "list",
        data: [{ id: "openai/gpt-4o", object: "model", owned_by: "openai" }],
      }));
    }
    if (url.includes("/api/mcp/clients")) {
      return Promise.resolve(jsonOk({
        clients: [{
          id: "weather",
          url: "https://mcp.example.com/rpc",
          enabled: true,
          transport: "http-sse",
          toolCount: 2,
          lastSyncAt: "2026-07-13T00:00:00Z",
        }],
      }));
    }
    if (url.includes("/api/mcp/tools")) {
      return Promise.resolve(jsonOk({
        tools: [{
          name: "get_weather",
          clientId: "weather",
          annotations: { readOnlyHint: true },
        }, {
          name: "delete_notes",
          clientId: "weather",
        }],
      }));
    }
    if (url.includes("/api/plugins")) {
      return Promise.resolve(jsonOk({ plugins: ["tagger"] }));
    }
    return Promise.resolve(jsonOk({}));
  });
}

describe("ProvidersView", () => {
  it("renders the configured providers list from the gateway config", async () => {
    mockGateway();
    render(<ProvidersView />);

    expect((await screen.findAllByText("openai")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("anthropic").length).toBeGreaterThan(0);
    expect(screen.getByText("default")).toBeInTheDocument();
    // Traffic-light status badge: green "online" (enabled + key) vs red "disabled".
    expect(screen.getByText("online")).toBeInTheDocument();
    expect(screen.getByText("disabled")).toBeInTheDocument();
  });

  it("shows an add-provider form", async () => {
    mockGateway();
    render(<ProvidersView />);
    expect(
      await screen.findByRole("button", { name: "Add provider" }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("openai")).toBeInTheDocument();
  });
});

describe("StatusView", () => {
  it("shows health, runtime version, and the model catalog", async () => {
    mockGateway();
    render(<StatusView />);

    expect(await screen.findByText("ok")).toBeInTheDocument();
    expect(screen.getByText(/gateway v0\.7\.0/)).toBeInTheDocument();
    expect(screen.getByText(/Deno 2\.9\.2/)).toBeInTheDocument();
    expect(await screen.findByText("openai/gpt-4o")).toBeInTheDocument();
  });
});

describe("ExtensionsView", () => {
  it("shows MCP servers, synced tools with safety badges, and plugins", async () => {
    mockGateway();
    const user = userEvent.setup();
    const { ExtensionsView } = await import("./views/ExtensionsView");
    render(<ExtensionsView />);

    // Default tab renders MCP servers: the client row plus the transport
    // column and the add-form selector (default http-sse, decision D11).
    expect((await screen.findAllByText("weather")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("http-sse").length).toBeGreaterThan(1);

    // Synced tools tab: tool names and per-call safety badges.
    await user.click(screen.getByRole("tab", { name: "Synced tools" }));
    expect(await screen.findByText("get_weather")).toBeInTheDocument();
    expect(screen.getByText("read-only")).toBeInTheDocument();
    expect(screen.getByText("needs confirmation")).toBeInTheDocument();

    // Plugins tab: built-in plugin names from GET /api/plugins.
    await user.click(screen.getByRole("tab", { name: "Plugins" }));
    expect(await screen.findByText("tagger")).toBeInTheDocument();
  });
});

describe("App", () => {
  it("switches between tabs", async () => {
    mockGateway();
    const user = userEvent.setup();
    render(<App />);

    expect(
      await screen.findByText("Configured Providers"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Logs" }));
    expect(screen.getByText(/Live request stream and stored history/))
      .toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Status" }));
    expect(await screen.findByText("Gateway health")).toBeInTheDocument();
  });
});
