import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProvidersView } from "./ProvidersView";
import { ToastProvider } from "../components/ui/toast";

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface MockOptions {
  providers?: Record<string, unknown>[];
}

function mockGateway(options: MockOptions = {}) {
  const providers = options.providers ?? [{
    id: "openai",
    type: "openai",
    enabled: true,
    models: ["gpt-4o"],
    priority: 0,
    hasApiKey: true,
  }];
  const posts: Array<Record<string, unknown>> = [];
  const puts: Array<{ id: string; body: Record<string, unknown> }> = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
    (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api/providers") && method === "POST") {
        posts.push(JSON.parse(String(init?.body)));
        return Promise.resolve(jsonOk({ id: "x", type: "openai" }, 201));
      }
      const putMatch = url.match(/\/api\/providers\/([^/?]+)$/);
      if (putMatch && method === "PUT") {
        puts.push({ id: putMatch[1], body: JSON.parse(String(init?.body)) });
        return Promise.resolve(jsonOk({ id: putMatch[1], type: "openai" }));
      }
      if (putMatch && method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.includes("/api/config")) {
        return Promise.resolve(
          jsonOk({ defaultProvider: "openai", providers }),
        );
      }
      return Promise.resolve(jsonOk({}));
    },
  );
  return { spy, posts, puts };
}

function renderView() {
  return render(
    <ToastProvider>
      <ProvidersView />
    </ToastProvider>,
  );
}

describe("ProvidersView landing (pinned add form G6/G7)", () => {
  it("keeps one 'Add provider' button, one 'ID' field, and an 'Add Custom Provider' action", async () => {
    mockGateway();
    renderView();

    // Inline add form (detail pane, no provider selected on load).
    expect(await screen.findByRole("button", { name: "Add provider" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Custom Provider" }))
      .toBeInTheDocument();
    // Exactly one "ID" field on the landing (required marker is aria-hidden).
    expect(screen.getAllByLabelText(/^ID/)).toHaveLength(1);
    expect(screen.getByPlaceholderText("openai")).toBeInTheDocument();
  });

  it("lists configured providers with key-presence status", async () => {
    mockGateway({
      providers: [
        {
          id: "openai",
          type: "openai",
          enabled: true,
          models: [],
          priority: 0,
          hasApiKey: true,
        },
        {
          id: "byo",
          type: "openai-compatible",
          enabled: true,
          models: [],
          priority: 0,
          hasApiKey: false,
        },
      ],
    });
    renderView();

    expect(await screen.findByRole("button", { name: "openai" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "byo" })).toBeInTheDocument();
    // Traffic-light status badge: green "online" (enabled + key) vs red "no key".
    expect(screen.getByText("online")).toBeInTheDocument();
    expect(screen.getByText("no key")).toBeInTheDocument();
    // Custom (bring-your-own) chip.
    expect(screen.getByText("Custom")).toBeInTheDocument();
  });
});

describe("ProvidersView configured keys", () => {
  it("shows the key table for a selected provider without rendering secrets", async () => {
    mockGateway();
    const user = userEvent.setup();
    renderView();

    await user.click(await screen.findByRole("button", { name: "openai" }));

    // Right pane switches to the keys table.
    expect(await screen.findByRole("button", { name: "Edit Provider Config" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add new key" }))
      .toBeInTheDocument();
    // Enabled toggle uses a generic label so it never re-introduces the id.
    expect(screen.getByRole("switch", { name: "Provider enabled" }))
      .toBeInTheDocument();

    // Pinned browser contract: with both panes visible, exactly one row still
    // carries the provider id (the left rail), so getByRole("row", /id/) stays
    // unambiguous. The keys-table row is deliberately id-free.
    const idRows = screen.getAllByRole("row").filter((row) =>
      /openai/i.test(row.textContent ?? "")
    );
    expect(idRows).toHaveLength(1);
    expect(within(idRows[0]).getByText("online")).toBeInTheDocument();
    expect(within(idRows[0]).getByRole("button", { name: "Delete openai" }))
      .toBeInTheDocument();
  });
});

describe("ProvidersView custom provider inline form", () => {
  it("creates a provider from the inline Name + Base URL fields (no modal)", async () => {
    const { posts } = mockGateway();
    const user = userEvent.setup();
    renderView();

    await user.click(
      await screen.findByRole("button", { name: "Add Custom Provider" }),
    );
    // Integrated into the detail pane, not a popup dialog.
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.type(await screen.findByLabelText(/^Name/), "my-gw");
    await user.type(screen.getByLabelText(/^Base URL/), "https://host/v1");
    await user.click(screen.getByRole("button", { name: "Add provider" }));

    await vi.waitFor(() =>
      expect(
        posts.some((p) =>
          p.id === "my-gw" && p.baseUrl === "https://host/v1" &&
          p.type === "openai-compatible"
        ),
      ).toBe(true)
    );
  });
});

describe("ProvidersView Azure add form", () => {
  it("drops Base URL and posts models from the deployment + model names", async () => {
    const { posts } = mockGateway({ providers: [] });
    const user = userEvent.setup();
    renderView();

    // Empty state renders the inline add form; switch its type to Azure.
    const typeSelect = await screen.findByLabelText("Type");
    await user.selectOptions(typeSelect, "azure");

    // Base URL is redundant with the Azure endpoint and must not be offered.
    expect(screen.queryByLabelText(/^Base URL/)).toBeNull();

    await user.type(screen.getByPlaceholderText("openai"), "azure");
    await user.type(
      screen.getByLabelText(/^Endpoint/),
      "https://res.openai.azure.com",
    );
    await user.type(screen.getByLabelText(/^Deployment name/), "my-gpt4o");
    await user.type(screen.getByLabelText(/^Model name/), "gpt-4o");
    await user.click(screen.getByRole("button", { name: "Add provider" }));

    await vi.waitFor(() =>
      expect(
        posts.some((p) =>
          p.type === "azure" &&
          p.endpoint === "https://res.openai.azure.com" &&
          Array.isArray(p.models) &&
          (p.models as string[]).includes("my-gpt4o") &&
          (p.models as string[]).includes("gpt-4o") &&
          p.baseUrl === undefined
        ),
      ).toBe(true)
    );
  });
});

describe("ProvidersView 6-tab config panel", () => {
  it("opens Network/Proxy/.../Debugging tabs with a sticky Save/Remove footer", async () => {
    mockGateway();
    const user = userEvent.setup();
    renderView();

    await user.click(await screen.findByRole("button", { name: "openai" }));
    await user.click(
      await screen.findByRole("button", { name: "Edit Provider Config" }),
    );

    const tablist = await screen.findByRole("tablist", {
      name: "Provider configuration",
    });
    for (
      const name of [
        "Network",
        "Proxy",
        "Performance",
        "Governance",
        "Beta Headers",
        "Debugging",
      ]
    ) {
      expect(within(tablist).getByRole("tab", { name })).toBeInTheDocument();
    }

    // Network tab is default and reveals the base URL + TLS fields.
    expect(screen.getByLabelText("Base URL (Optional)")).toBeInTheDocument();

    // Proxy tab reveals the proxy URL secret re-entry.
    await user.click(within(tablist).getByRole("tab", { name: "Proxy" }));
    expect(screen.getByLabelText("Proxy URL")).toBeInTheDocument();

    // Sticky footer actions.
    expect(screen.getByRole("button", { name: "Save configuration" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove configuration" }))
      .toBeInTheDocument();
  });

  it("saves only changed groups (debugging) as a patch", async () => {
    const { puts } = mockGateway();
    const user = userEvent.setup();
    renderView();

    await user.click(await screen.findByRole("button", { name: "openai" }));
    await user.click(
      await screen.findByRole("button", { name: "Edit Provider Config" }),
    );
    const tablist = await screen.findByRole("tablist", {
      name: "Provider configuration",
    });
    await user.click(within(tablist).getByRole("tab", { name: "Debugging" }));
    await user.click(
      screen.getByRole("switch", { name: "Send Back Raw Request" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );

    await vi.waitFor(() => expect(puts.length).toBeGreaterThan(0));
    expect(puts[0].id).toBe("openai");
    const patch = puts[0].body;
    expect((patch.debugging as Record<string, unknown>).sendBackRawRequest)
      .toBe(true);
    // Untouched secret-bearing groups are not re-sent (shallow-merge safety).
    expect(patch.network).toBeUndefined();
    expect(patch.proxy).toBeUndefined();
  });
});
