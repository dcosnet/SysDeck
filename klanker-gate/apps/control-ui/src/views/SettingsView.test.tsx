import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView";
import { ToastProvider } from "../components/ui/toast";

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A representative settings tree with env + override provenance markers. */
function baseSettings() {
  return {
    settings: {
      security: {
        values: {
          passwordProtectEnabled: true,
          passwordUsername: "stoff",
          // Redacted write-only marker; the raw password never reaches the UI.
          hasPassword: true,
          disableInferenceAuth: false,
          enforceVirtualKeys: false,
          allowedOrigins: ["http://localhost:3000"],
          allowedHeaders: [],
          requiredHeaders: [],
          whitelistedRoutes: ["/health"],
        },
        sources: {
          passwordUsername: "env",
          enforceVirtualKeys: "override",
        },
      },
      compatibility: {
        values: {
          convertTextToChat: true,
          convertChatToResponses: true,
          dropUnsupportedParams: false,
          convertUnsupportedParameterValues: true,
        },
        sources: {},
      },
      caching: {
        values: {
          enabled: false,
          embeddingProvider: "azure",
          embeddingModel: "text-embedding-3-large",
          ttlSeconds: 300,
          similarityThreshold: 0.85,
          dimension: 1536,
          conversationHistoryThreshold: 3,
          excludeSystemPrompt: false,
          cacheByModel: false,
          cacheByProvider: false,
        },
        sources: {},
      },
      performance: {
        values: { initialPoolSize: 5000, maxRequestBodySizeMb: 100 },
        sources: {},
      },
      mcp: {
        values: {
          maxAgentDepth: 10,
          toolExecutionTimeoutSec: 30,
          toolSyncIntervalMin: 10,
          disableAutoToolInjection: false,
          externalServerUrl: "",
          externalClientUrl: "",
        },
        sources: {},
      },
    },
    enforcement: {},
  };
}

const DEFAULT_VFS = [
  {
    path: "servers/calculator.py",
    server: "calculator",
    tools: ["add", "subtract"],
    sizeBytes: 512,
    sha256: "aaa111",
    source: "def add(a, b):\n    return a + b\n",
  },
  {
    path: "servers/weather.py",
    server: "weather",
    tools: ["forecast"],
    sizeBytes: 900,
    sha256: "bbb222",
    source: "def forecast(city):\n    return {}\n",
  },
];

interface MockOptions {
  vfsFiles?: unknown[];
}

function mockGateway(options: MockOptions = {}) {
  const settings = baseSettings();
  const vfsFiles = options.vfsFiles ?? DEFAULT_VFS;
  const puts: Array<Record<string, unknown>> = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
    (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api/settings") && method === "PUT") {
        puts.push(JSON.parse(String(init?.body)));
        return Promise.resolve(jsonOk(settings));
      }
      if (url.includes("/api/settings")) {
        return Promise.resolve(jsonOk(settings));
      }
      if (url.includes("/api/mcp/codemode/vfs")) {
        const binding = url.includes("binding=tool") ? "tool" : "server";
        return Promise.resolve(
          jsonOk({
            bindingLevel: binding,
            files: vfsFiles,
            generatedAt: "2026-07-15T00:00:00.000Z",
          }),
        );
      }
      if (url.includes("/api/config")) {
        return Promise.resolve(
          jsonOk({
            defaultProvider: "openai",
            providers: [
              { id: "openai", type: "openai", enabled: true, models: [] },
              { id: "azure", type: "azure", enabled: true, models: [] },
              { id: "cohere", type: "cohere", enabled: false, models: [] },
            ],
          }),
        );
      }
      return Promise.resolve(jsonOk({}));
    },
  );
  return { spy, puts };
}

function renderView() {
  return render(
    <ToastProvider>
      <SettingsView />
    </ToastProvider>,
  );
}

/** Move to a sub-page by clicking its tab. */
async function goTo(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("tab", { name }));
}

describe("SettingsView security (write-only password + provenance)", () => {
  it("renders the security form, provenance chips, and never shows the password", async () => {
    mockGateway();
    renderView();

    // The username value is bound; its env provenance shows a chip.
    expect(await screen.findByLabelText("Username")).toHaveValue("stoff");
    expect(screen.getByText("env")).toBeInTheDocument();
    expect(screen.getByText("override")).toBeInTheDocument();

    // Write-only password: a Configured marker + Replace, never an input value.
    expect(screen.getByText("Configured")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace Password" }))
      .toBeInTheDocument();
    // No password field is rendered until the operator opts to replace it.
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("saves only the changed field (no untouched password re-sent)", async () => {
    const { puts } = mockGateway();
    const user = userEvent.setup();
    renderView();

    await user.click(
      await screen.findByRole("switch", {
        name: "Enforce Virtual Keys on Inference",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByText("Changes saved");
    expect(puts.length).toBeGreaterThan(0);
    const values = (puts[0] as Record<string, Record<string, unknown>>)
      .security as Record<string, unknown>;
    expect(values).toEqual({ enforceVirtualKeys: true });
    // Shallow-merge safety: the redacted password is never re-sent.
    expect(values.password).toBeUndefined();
    expect(values.passwordUsername).toBeUndefined();
  });

  it("sends a password only when the operator re-enters one", async () => {
    const { puts } = mockGateway();
    const user = userEvent.setup();
    renderView();

    await user.click(
      await screen.findByRole("button", { name: "Replace Password" }),
    );
    await user.type(screen.getByLabelText("Password"), "new-secret");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByText("Changes saved");
    expect(puts.length).toBeGreaterThan(0);
    const values = (puts[0] as Record<string, Record<string, unknown>>)
      .security as Record<string, unknown>;
    expect(values).toEqual({ password: "new-secret" });
  });
});

describe("SettingsView compatibility", () => {
  it("renders four toggles and saves only the changed one", async () => {
    const { puts } = mockGateway();
    const user = userEvent.setup();
    renderView();

    await goTo(user, "Compatibility");
    expect(
      await screen.findByRole("switch", { name: "Convert Text to Chat" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Drop Unsupported Params" }))
      .toBeInTheDocument();

    // Flip the one that is off -> on.
    await user.click(
      screen.getByRole("switch", { name: "Drop Unsupported Params" }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByText("Changes saved");
    expect(puts.length).toBeGreaterThan(0);
    const values = (puts[0] as Record<string, Record<string, unknown>>)
      .compatibility;
    expect(values).toEqual({ dropUnsupportedParams: true });
  });
});

describe("SettingsView caching (Frosty headers, not x-bf-)", () => {
  it("renders the caching form and references x-frosty-cache-* headers only", async () => {
    mockGateway();
    const user = userEvent.setup();
    renderView();

    await goTo(user, "Caching");
    expect(await screen.findByLabelText(/Embedding Model/)).toHaveValue(
      "text-embedding-3-large",
    );
    // Frosty header identity, never the reference product's x-bf- prefix.
    expect(screen.getByText("x-frosty-cache-key")).toBeInTheDocument();
    expect(screen.getByText("x-frosty-cache-no-store")).toBeInTheDocument();
    expect(screen.queryByText(/x-bf-/)).toBeNull();
  });

  it("saves only changed caching fields", async () => {
    const { puts } = mockGateway();
    const user = userEvent.setup();
    renderView();

    await goTo(user, "Caching");
    await user.click(
      await screen.findByRole("switch", { name: "Enable Semantic Caching" }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByText("Changes saved");
    expect(puts.length).toBeGreaterThan(0);
    const values = (puts[0] as Record<string, Record<string, unknown>>)
      .caching;
    expect(values).toEqual({ enabled: true });
  });

  it("lists active providers in the embedding provider dropdown", async () => {
    mockGateway();
    const user = userEvent.setup();
    renderView();

    await goTo(user, "Caching");
    // Open the combobox; its options come from the gateway's active providers,
    // not a hardcoded list. Disabled providers (cohere) are excluded.
    await user.click(
      await screen.findByRole("combobox", {
        name: "Embedding Provider",
      }),
    );
    // Options render once the active-provider fetch resolves.
    expect(await screen.findByRole("option", { name: "openai" }))
      .toBeInTheDocument();
    expect(screen.getByRole("option", { name: "azure" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "cohere" }))
      .toBeNull();
  });
});

describe("SettingsView performance", () => {
  it("renders the two tuning cards and saves a changed value", async () => {
    const { puts } = mockGateway();
    const user = userEvent.setup();
    renderView();

    await goTo(user, "Performance");
    const pool = await screen.findByLabelText("Initial Pool Size");
    expect(pool).toHaveValue(5000);

    const body = screen.getByLabelText("Max Request Body Size (MB)");
    await user.clear(body);
    await user.type(body, "250");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByText("Changes saved");
    expect(puts.length).toBeGreaterThan(0);
    const values = (puts[0] as Record<string, Record<string, unknown>>)
      .performance;
    expect(values).toEqual({ maxRequestBodySizeMb: 250 });
  });
});

describe("SettingsView MCP + Code Mode VFS", () => {
  it("renders the tuning fields and the generated VFS preview", async () => {
    mockGateway();
    const user = userEvent.setup();
    renderView();

    await goTo(user, "MCP");
    expect(await screen.findByLabelText("Max Agent Depth")).toHaveValue(10);
    expect(
      screen.getByRole("switch", { name: "Disable Auto Tool Injection" }),
    ).toBeInTheDocument();

    // The VFS preview lists the generated files (fetched from getCodeModeVfs).
    expect(await screen.findByText("servers/")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /calculator\.py/ }),
    ).toBeInTheDocument();
  });

  // I4 / S-VFS-5: the untrusted `source` (and path/server/tools) render as
  // escaped TEXT NODES only. A hostile payload must never become live markup.
  it("escapes a hostile VFS source instead of rendering markup", async () => {
    const hostile =
      "<script>alert('xss')</script></pre><img src=x onerror=alert(1)>${danger}";
    mockGateway({
      vfsFiles: [
        {
          path: "servers/notes.py",
          server: "notes",
          tools: ["read"],
          sizeBytes: 64,
          sha256: "ccc333",
          source: hostile,
        },
      ],
    });
    const user = userEvent.setup();
    renderView();

    await goTo(user, "MCP");
    // Expand the file to reveal its <pre> source view.
    await user.click(
      await screen.findByRole("button", { name: /notes\.py/ }),
    );

    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    // The literal payload is present as text, verbatim.
    expect(pre?.textContent).toBe(hostile);
    // It is HTML-escaped, so no live <script>/<img> element was created.
    expect(pre?.innerHTML).toContain("&lt;script&gt;");
    expect(document.querySelector("script")).toBeNull();
    expect(within(pre as HTMLElement).queryByRole("img")).toBeNull();
  });
});
