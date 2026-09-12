import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VirtualKeysView } from "./VirtualKeysView";
import { ToastProvider } from "../components/ui/toast";

const FULL_TOKEN = "vk-secret-value-1234567890-do-not-leak";
const TOKEN_HINT = "vkhint9";

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Fetch mock that records the create body and grows the list on POST. */
function mockVK() {
  const keys: Array<Record<string, unknown>> = [];
  const state: { lastCreate: Record<string, unknown> | null } = {
    lastCreate: null,
  };
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/api/virtual-keys") && method === "POST") {
      state.lastCreate = init?.body
        ? JSON.parse(String(init.body)) as Record<string, unknown>
        : null;
      const key = {
        id: "k1",
        name: "CI Key",
        enabled: true,
        usedRequests: 0,
        usedCostMicroUsd: 0,
        usedCostUsd: 0,
        tokenHint: TOKEN_HINT,
      };
      keys.push(key);
      return Promise.resolve(jsonOk({ ...key, token: FULL_TOKEN }, 201));
    }
    if (url.includes("/api/virtual-keys")) {
      return Promise.resolve(jsonOk({ virtualKeys: keys }));
    }
    if (url.includes("/api/teams")) {
      return Promise.resolve(jsonOk({ teams: [] }));
    }
    if (url.includes("/api/customers")) {
      return Promise.resolve(jsonOk({ customers: [] }));
    }
    if (url.includes("/api/config")) {
      return Promise.resolve(jsonOk({ providers: [] }));
    }
    return Promise.resolve(jsonOk({}));
  });
  return state;
}

/** Fetch mock that serves a fixed list (no writes). */
function mockList(initial: Array<Record<string, unknown>>) {
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url.includes("/api/virtual-keys")) {
      return Promise.resolve(jsonOk({ virtualKeys: initial }));
    }
    if (url.includes("/api/teams")) {
      return Promise.resolve(jsonOk({ teams: [] }));
    }
    if (url.includes("/api/customers")) {
      return Promise.resolve(jsonOk({ customers: [] }));
    }
    if (url.includes("/api/config")) {
      return Promise.resolve(jsonOk({ providers: [] }));
    }
    return Promise.resolve(jsonOk({}));
  });
}

function renderView() {
  return render(
    <ToastProvider>
      <VirtualKeysView />
    </ToastProvider>,
  );
}

describe("VirtualKeysView one-time token reveal (security #13)", () => {
  it("shows the full token once, wires description, then forgets it", async () => {
    const state = mockVK();
    const user = userEvent.setup();
    renderView();

    // Empty state (governance off) before any key exists.
    expect(await screen.findByText("No virtual keys")).toBeInTheDocument();

    await user.click(
      screen.getAllByRole("button", { name: "Add Virtual Key" })[0],
    );
    // The required marker renders as an aria-hidden " *" the browser omits from
    // the accessible name; match the field by its leading text.
    await user.type(await screen.findByLabelText(/^Name/), "CI Key");
    await user.type(screen.getByLabelText("Description"), "Used by CI");
    await user.click(screen.getByRole("button", { name: "Create" }));

    // The 201 body's full token is revealed exactly once.
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(FULL_TOKEN)).toBeInTheDocument();
    expect(within(dialog).getByText(/shown once and never again/))
      .toBeInTheDocument();

    // Description was wired into the create payload (NEW field).
    expect(state.lastCreate?.description).toBe("Used by CI");

    await user.click(within(dialog).getByRole("button", { name: "Done" }));

    // After close the full token exists nowhere; only the masked hint remains.
    await waitFor(() => expect(screen.queryByText(FULL_TOKEN)).toBeNull());
    expect(screen.getByText(/vkhint9/)).toBeInTheDocument();
  });
});

/** Create-flow mock that seeds enabled + disabled providers with models. */
function mockVKProviders() {
  const state: { lastCreate: Record<string, unknown> | null } = {
    lastCreate: null,
  };
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/api/virtual-keys") && method === "POST") {
      state.lastCreate = init?.body
        ? JSON.parse(String(init.body)) as Record<string, unknown>
        : null;
      return Promise.resolve(jsonOk({
        id: "k1",
        name: "Scoped Key",
        enabled: true,
        usedRequests: 0,
        usedCostMicroUsd: 0,
        usedCostUsd: 0,
        tokenHint: TOKEN_HINT,
        token: FULL_TOKEN,
      }, 201));
    }
    if (url.includes("/api/virtual-keys")) {
      return Promise.resolve(jsonOk({ virtualKeys: [] }));
    }
    if (url.includes("/api/teams")) {
      return Promise.resolve(jsonOk({ teams: [] }));
    }
    if (url.includes("/api/customers")) {
      return Promise.resolve(jsonOk({ customers: [] }));
    }
    if (url.includes("/api/config")) {
      return Promise.resolve(jsonOk({
        providers: [
          {
            id: "prov-enabled",
            type: "openai",
            enabled: true,
            models: ["gpt-4o", "gpt-4o-mini"],
            priority: 0,
            hasApiKey: true,
          },
          {
            id: "prov-disabled",
            type: "openai",
            enabled: false,
            models: ["legacy"],
            priority: 0,
            hasApiKey: true,
          },
        ],
      }));
    }
    return Promise.resolve(jsonOk({}));
  });
  return state;
}

describe("VirtualKeysView provider + model scope", () => {
  it("lists only enabled providers and persists the model allowlist", async () => {
    const state = mockVKProviders();
    const user = userEvent.setup();
    renderView();

    await user.click(
      (await screen.findAllByRole("button", { name: "Add Virtual Key" }))[0],
    );
    await user.type(await screen.findByLabelText(/^Name/), "Scoped Key");

    // Provider dropdown lists only ENABLED providers.
    const provCombo = screen.getByRole("combobox", {
      name: "Provider Configurations",
    });
    await user.click(provCombo);
    expect(screen.getByRole("option", { name: "prov-enabled" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "prov-disabled" })).toBeNull();
    await user.click(screen.getByRole("option", { name: "prov-enabled" }));

    // Model picker appears with the default "All models" tag.
    expect(await screen.findByText("All models")).toBeInTheDocument();

    // Pick a specific model: the "all" default is replaced by the model tag.
    const modelCombo = screen.getByRole("combobox", { name: "Allowed models" });
    await user.click(modelCombo);
    await user.click(screen.getByRole("option", { name: "gpt-4o" }));
    expect(screen.queryByText("All models")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(state.lastCreate).not.toBeNull());
    expect(state.lastCreate?.allowedProviders).toEqual(["prov-enabled"]);
    expect(state.lastCreate?.allowedModels).toEqual(["gpt-4o"]);
  });
});

describe("VirtualKeysView list", () => {
  it("renders status pills and filters by name", async () => {
    mockList([
      {
        id: "a",
        name: "alpha-key",
        enabled: true,
        usedRequests: 0,
        usedCostMicroUsd: 0,
        usedCostUsd: 0,
        tokenHint: "vk-aaa",
      },
      {
        id: "b",
        name: "beta-key",
        enabled: false,
        usedRequests: 0,
        usedCostMicroUsd: 0,
        usedCostUsd: 0,
        tokenHint: "vk-bbb",
      },
    ]);
    const user = userEvent.setup();
    renderView();

    expect(await screen.findByText("alpha-key")).toBeInTheDocument();
    expect(screen.getByText("beta-key")).toBeInTheDocument();
    // Reference status labels.
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Inactive")).toBeInTheDocument();

    // Search narrows the visible rows by name.
    await user.type(screen.getByLabelText("Search by key name"), "alpha");
    expect(screen.getByText("alpha-key")).toBeInTheDocument();
    expect(screen.queryByText("beta-key")).toBeNull();
  });
});
