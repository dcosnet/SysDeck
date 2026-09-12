// Azure OpenAI deployment-scoped ingress: POST
// /openai/deployments/{deployment}/{chat/completions,completions,embeddings}.
// The URL deployment segment IS the dispatched model and is the ONLY model
// source, so admission (governance) and dispatch (the route) must agree on the
// exact same string - which is why azureDeploymentFromPath is exercised here as
// a unit next to the request that uses it.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { createHandler } from "../../apps/gateway/main.ts";
import {
  type AppContext,
  NullToolExecutor,
  VERSION,
} from "../../apps/gateway/context.ts";
import { azureDeploymentFromPath } from "../../apps/gateway/routes/azure_ingress.ts";
import { ProviderManager } from "../../packages/providers/src/mod.ts";
import { Metrics } from "../../packages/telemetry/src/metrics.ts";
import { LogBus } from "../../packages/telemetry/src/logbus.ts";
import { VirtualKeyManager } from "../../packages/governance/src/virtual_keys.ts";
import { MCPRegistry } from "../../packages/mcp/src/registry.ts";
import { PluginManager } from "../../packages/plugins/src/lifecycle.ts";
import {
  jsonResponse,
  MockProvider,
  openAIChatBody,
  openAIStreamFrames,
  sseResponse,
} from "../../packages/testing/src/mod.ts";

function makeContext(mockUrl: string): AppContext {
  return {
    providers: new ProviderManager([{
      id: "openai",
      type: "openai",
      apiKey: "sk-test",
      baseUrl: mockUrl,
      enabled: true,
      models: ["gpt-4o"],
      priority: 0,
      retry: { maxRetries: 0 },
    }], "openai"),
    metrics: new Metrics(),
    logBus: new LogBus(),
    virtualKeys: new VirtualKeyManager(),
    mcp: new MCPRegistry(),
    plugins: new PluginManager(),
    toolExecutor: new NullToolExecutor(),
    version: VERSION,
  };
}

/** Azure clients never send a bearer; they send `api-key`. Both are supported. */
function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://gateway.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const chat = { messages: [{ role: "user", content: "hei" }] };

interface EgressBody {
  model?: string;
  stream?: boolean;
  [key: string]: unknown;
}

interface ErrorEnvelope {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

// ------------------------------------------------------- deployment as model

Deno.test("azure ingress: the deployment segment becomes the egress model", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("hei")));
  const ctx = makeContext(mock.url);
  const handler = createHandler(ctx);
  try {
    const res = await handler(
      post("/openai/deployments/gpt-4o-prod/chat/completions", chat),
    );
    assertEquals(res.status, 200);
    await res.body?.cancel();
    assertEquals(mock.calls.length, 1);
    assertEquals(mock.calls[0].path, "/chat/completions");
    assertEquals((mock.calls[0].body as EgressBody).model, "gpt-4o-prod");
    assertEquals(ctx.metrics.get("requests.compat.azure"), 1);
  } finally {
    await mock.close();
  }
});

Deno.test("azure ingress: a body model disagreeing with the URL is overridden by the URL", async () => {
  // Security-relevant: governance admits against the PATH deployment, so a
  // route that dispatched the body model would let a scoped key be admitted
  // for one model and billed/served another.
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("hei")));
  const handler = createHandler(makeContext(mock.url));
  try {
    const res = await handler(post(
      "/openai/deployments/gpt-4o-prod/chat/completions",
      { ...chat, model: "openai/smuggled-model" },
    ));
    assertEquals(res.status, 200);
    await res.body?.cancel();
    const sent = mock.calls[0].body as EgressBody;
    assertEquals(sent.model, "gpt-4o-prod");
    assertNotEquals(sent.model, "smuggled-model");
    assertNotEquals(sent.model, "openai/smuggled-model");
  } finally {
    await mock.close();
  }
});

Deno.test("azure ingress: any api-version value is tolerated and never becomes the model", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("hei")));
  const handler = createHandler(makeContext(mock.url));
  try {
    const versions = ["2024-02-15-preview", "totally-made-up"];
    for (const version of versions) {
      const res = await handler(post(
        `/openai/deployments/gpt-4o-prod/chat/completions?api-version=${version}`,
        chat,
      ));
      assertEquals(res.status, 200, version);
      await res.body?.cancel();
    }
    assertEquals(mock.calls.length, 2);
    for (const call of mock.calls) {
      const sent = call.body as EgressBody;
      assertEquals(sent.model, "gpt-4o-prod");
      // The query parameter is ignored outright: it never reaches egress.
      assertEquals(Object.hasOwn(sent, "api-version"), false);
    }
  } finally {
    await mock.close();
  }
});

// --------------------------------------------------------- percent-encoding

Deno.test("azure ingress: a percent-encoded deployment decodes the same for admission and dispatch", async () => {
  const pathname = "/openai/deployments/my%2Ddep/chat/completions";
  // The unit the governance middleware calls, on the exact same pathname.
  const admitted = azureDeploymentFromPath(pathname);
  assertEquals(admitted, "my-dep");

  const mock = new MockProvider(() => jsonResponse(openAIChatBody("hei")));
  const handler = createHandler(makeContext(mock.url));
  try {
    const res = await handler(post(pathname, chat));
    assertEquals(res.status, 200);
    await res.body?.cancel();
    const dispatched = (mock.calls[0].body as EgressBody).model;
    assertEquals(dispatched, "my-dep");
    // The whole point of the shared helper: one string, both decisions.
    assertEquals(dispatched, admitted);
  } finally {
    await mock.close();
  }
});

Deno.test("azure ingress: azureDeploymentFromPath is undefined off the azure shape", () => {
  // Non-azure paths must not be mistaken for a deployment.
  assertEquals(azureDeploymentFromPath("/v1/chat/completions"), undefined);
  assertEquals(
    azureDeploymentFromPath("/openai/v1/chat/completions"),
    undefined,
  );
  // No trailing operation segment: not a dispatchable azure path.
  assertEquals(azureDeploymentFromPath("/openai/deployments/dep"), undefined);
  // Undecodable segment -> undefined, which fails admission CLOSED.
  assertEquals(
    azureDeploymentFromPath("/openai/deployments/my%zzdep/chat/completions"),
    undefined,
  );
  // A slash-bearing deployment survives decoding intact.
  assertEquals(
    azureDeploymentFromPath("/openai/deployments/a%2Fb/chat/completions"),
    "a/b",
  );
});

Deno.test("azure ingress: a malformed percent-escape is a 400, never a 500", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("hei")));
  const handler = createHandler(makeContext(mock.url));
  try {
    const res = await handler(
      post("/openai/deployments/my%zzdep/chat/completions", chat),
    );
    assertEquals(res.status, 400);
    assertEquals(res.headers.get("Content-Type"), "application/json");
    const body = await res.json() as ErrorEnvelope;
    assertEquals(body.error.type, "invalid_request_error");
    assertEquals(body.error.param, "deployment");
    assert(body.error.message.length > 0);
    // Nothing was dispatched: the request died at the edge.
    assertEquals(mock.calls.length, 0);
  } finally {
    await mock.close();
  }
});

// ------------------------------------------------------------------ streaming

Deno.test("azure ingress: streaming is the canonical SSE stream, byte-identical to /v1", async () => {
  const frames = openAIStreamFrames(["Hei", " fra", " Azure"]);
  const mock = new MockProvider((call) =>
    (call.body as EgressBody).stream
      ? sseResponse(frames)
      : jsonResponse(openAIChatBody("unused"))
  );
  const handler = createHandler(makeContext(mock.url));
  try {
    const azure = await handler(post(
      "/openai/deployments/gpt-4o-prod/chat/completions",
      { ...chat, stream: true },
    ));
    assertEquals(azure.status, 200);
    assertEquals(azure.headers.get("Content-Type"), "text/event-stream");
    const azureText = await azure.text();

    const canonical = await handler(post("/v1/chat/completions", {
      ...chat,
      model: "openai/gpt-4o",
      stream: true,
    }));
    assertEquals(canonical.status, 200);
    const canonicalText = await canonical.text();

    // The azure surface performs NO stream translation: the bytes a client sees
    // are the same bytes /v1/chat/completions produces for the same upstream.
    assertEquals(azureText, canonicalText);
    assert(azureText.endsWith("data: [DONE]\n\n"), azureText);
    assert(azureText.includes("Hei"));

    // Both upstream calls asked for a stream; the azure one carried the URL model.
    assertEquals(mock.calls.length, 2);
    assertEquals((mock.calls[0].body as EgressBody).stream, true);
    assertEquals((mock.calls[0].body as EgressBody).model, "gpt-4o-prod");
    assertEquals((mock.calls[1].body as EgressBody).stream, true);
  } finally {
    await mock.close();
  }
});

// --------------------------------------------------- the other two operations

Deno.test("azure ingress: completions and embeddings deployments both dispatch", async () => {
  const mock = new MockProvider((call) =>
    call.path === "/embeddings"
      ? jsonResponse({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
        model: "embed-3-dep",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      })
      : jsonResponse({
        id: "cmpl-mock",
        object: "text_completion",
        created: 1700000000,
        model: "davinci-dep",
        choices: [{ text: "hei", index: 0, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
  );
  const ctx = makeContext(mock.url);
  const handler = createHandler(ctx);
  try {
    const completions = await handler(post(
      "/openai/deployments/davinci-dep/completions",
      { prompt: "hei", max_tokens: 5 },
    ));
    assertEquals(completions.status, 200);
    await completions.body?.cancel();

    const embeddings = await handler(post(
      "/openai/deployments/embed-3-dep/embeddings",
      { input: "hei" },
    ));
    assertEquals(embeddings.status, 200);
    await embeddings.body?.cancel();

    assertEquals(mock.calls.length, 2);
    assertEquals(mock.calls[0].path, "/completions");
    assertEquals((mock.calls[0].body as EgressBody).model, "davinci-dep");
    assertEquals(mock.calls[1].path, "/embeddings");
    assertEquals((mock.calls[1].body as EgressBody).model, "embed-3-dep");
    // Every azure operation is counted on the same compat counter.
    assertEquals(ctx.metrics.get("requests.compat.azure"), 2);
  } finally {
    await mock.close();
  }
});

// ----------------------------------------------------------------- governance

Deno.test("azure ingress: api-key authenticates, no credential is 401, an explicit bearer wins", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("hei")));
  const ctx = makeContext(mock.url);
  ctx.virtualKeys.upsert({
    id: "vk",
    name: "azure-gate",
    token: "vk-azure-gate-token",
    enabled: true,
    usedRequests: 0,
    usedCostMicroUsd: 0,
  });
  const handler = createHandler(ctx);
  const path = "/openai/deployments/gpt-4o-prod/chat/completions";
  try {
    const anonymous = await handler(post(path, chat));
    assertEquals(anonymous.status, 401);
    await anonymous.body?.cancel();

    // A stock Azure SDK cannot send Authorization; api-key is promoted for it.
    const apiKey = await handler(
      post(path, chat, { "api-key": "vk-azure-gate-token" }),
    );
    assertEquals(apiKey.status, 200);
    await apiKey.body?.cancel();

    // Promotion is an admission path, not a bypass: a bogus api-key still 401s.
    const bogus = await handler(post(path, chat, { "api-key": "not-a-key" }));
    assertEquals(bogus.status, 401);
    await bogus.body?.cancel();

    // An explicit bearer is authoritative and is NEVER clobbered by api-key.
    const bearerWins = await handler(post(path, chat, {
      "Authorization": "Bearer vk-azure-gate-token",
      "api-key": "not-a-key",
    }));
    assertEquals(bearerWins.status, 200);
    await bearerWins.body?.cancel();

    // Only the two admitted requests reached a provider.
    assertEquals(mock.calls.length, 2);
  } finally {
    await mock.close();
  }
});

Deno.test("azure ingress: a wrong-method request is a JSON error, never SPA HTML", async () => {
  const mock = new MockProvider(() => jsonResponse(openAIChatBody("hei")));
  const handler = createHandler(makeContext(mock.url));
  try {
    const res = await handler(
      new Request(
        "http://gateway.test/openai/deployments/gpt-4o-prod/chat/completions",
      ),
    );
    assertEquals(res.status, 405);
    assertEquals(res.headers.get("Content-Type"), "application/json");
    assertEquals(res.headers.get("Allow"), "POST");
    const body = await res.json() as ErrorEnvelope;
    assert(body.error.message.includes("not allowed"), body.error.message);
    assertEquals(mock.calls.length, 0);
  } finally {
    await mock.close();
  }
});
