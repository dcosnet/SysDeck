import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { PluginManager } from "./lifecycle.ts";
import {
  computeLatencyMs,
  expandTemplate,
  loadMockerConfigFromEnv,
  type MockerConfig,
  mockerEnabledFromEnv,
  type MockerOptions,
  mockerPlugin,
  selectResponseIndex,
} from "./mocker.ts";
import type { ChatCompletionRequest } from "../../contracts/src/mod.ts";
import { GatewayError } from "../../core/src/errors.ts";

// --- deterministic seams ---------------------------------------------------

const zeroRng = () => 0;
function constRng(v: number): () => number {
  return () => v;
}

function chatReq(
  overrides: Partial<ChatCompletionRequest> = {},
): ChatCompletionRequest {
  return {
    model: "openai/gpt-4o",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

/** A PluginManager with only the mocker registered — exercises the real path. */
function mgr(config: MockerConfig, options: MockerOptions): PluginManager {
  const m = new PluginManager();
  m.register(mockerPlugin(config, options));
  return m;
}

// Set/restore several env vars around a synchronous body (isolates env state).
function withEnvs(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prior[key] = Deno.env.get(key);
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

// --- opt-in gate + default-off ---------------------------------------------

Deno.test("mockerEnabledFromEnv is OFF by default, opts in on truthy values", () => {
  withEnvs(
    { FROSTY_MOCKER: undefined },
    () => assertEquals(mockerEnabledFromEnv(), false),
  );
  for (const off of ["", "off", "0", "no"]) {
    withEnvs(
      { FROSTY_MOCKER: off },
      () => assertEquals(mockerEnabledFromEnv(), false),
    );
  }
  for (const on of ["on", "ON", "1", "true", "yes"]) {
    withEnvs(
      { FROSTY_MOCKER: on },
      () => assertEquals(mockerEnabledFromEnv(), true),
    );
  }
});

// Mirrors the gateway boot wiring: the plugin is registered ONLY when opted in.
function bootPlugins(): PluginManager {
  const plugins = new PluginManager();
  if (mockerEnabledFromEnv()) {
    plugins.register(mockerPlugin(loadMockerConfigFromEnv()));
  }
  return plugins;
}

Deno.test("boot leaves the mocker unregistered by default (opt-in safe)", () => {
  withEnvs(
    { FROSTY_MOCKER: undefined, FROSTY_MOCKER_CONFIG: undefined },
    () => assertEquals(bootPlugins().list().includes("mocker"), false),
  );
});

Deno.test("boot registers the mocker when FROSTY_MOCKER=on", () => {
  withEnvs(
    { FROSTY_MOCKER: "on", FROSTY_MOCKER_CONFIG: undefined },
    () => assertEquals(bootPlugins().list().includes("mocker"), true),
  );
});

// --- config source ---------------------------------------------------------

Deno.test("loadMockerConfigFromEnv returns {} when unset and parses inline JSON", () => {
  withEnvs(
    { FROSTY_MOCKER_CONFIG: undefined },
    () => assertEquals(loadMockerConfigFromEnv(), {}),
  );
  withEnvs({
    FROSTY_MOCKER_CONFIG:
      '{"defaultBehavior":"success","rules":[{"name":"r","responses":[{"type":"success","content":{"message":"hi"}}]}]}',
  }, () => {
    const cfg = loadMockerConfigFromEnv();
    assertEquals(cfg.defaultBehavior, "success");
    assertEquals(cfg.rules?.[0].name, "r");
  });
});

Deno.test("loadMockerConfigFromEnv throws on a config that fails validation", () => {
  withEnvs({
    FROSTY_MOCKER_CONFIG: '{"rules":[{"name":"bad","responses":[]}]}',
  }, () => assertThrows(() => loadMockerConfigFromEnv()));
});

Deno.test("mockerPlugin rejects an invalid config at construction", () => {
  assertThrows(() => mockerPlugin({ rules: [{ name: "x", responses: [] }] }));
});

// --- rule matching (short-circuits upstream) -------------------------------

Deno.test("provider condition matches the model prefix and short-circuits", async () => {
  const config: MockerConfig = {
    rules: [{
      name: "oai",
      conditions: { providers: ["openai"] },
      responses: [{ type: "success", content: { message: "mocked" } }],
    }],
  };
  const hit = await mgr(config, { rng: zeroRng })
    .executeShortCircuit(chatReq({ model: "openai/gpt-4o" }));
  assertEquals(hit?.object, "chat.completion");
  assertEquals(hit?.model, "openai/gpt-4o");
  assertEquals(hit?.choices[0].message.content, "mocked");
  assertEquals(hit?.choices[0].finish_reason, "stop");
  assertEquals(hit?.usage, {
    prompt_tokens: 10,
    completion_tokens: 20,
    total_tokens: 30,
  });

  const miss = await mgr(config, { rng: zeroRng })
    .executeShortCircuit(chatReq({ model: "anthropic/claude-3" }));
  assertEquals(miss, undefined); // no provider match -> default passthrough
});

Deno.test("model condition matches the full or the bare model id", async () => {
  const config: MockerConfig = {
    rules: [{
      name: "byModel",
      conditions: { models: ["gpt-4o"] },
      responses: [{ type: "success", content: { message: "m" } }],
    }],
  };
  const bare = await mgr(config, { rng: zeroRng })
    .executeShortCircuit(chatReq({ model: "openai/gpt-4o" }));
  assertEquals(bare?.choices[0].message.content, "m");
  const other = await mgr(config, { rng: zeroRng })
    .executeShortCircuit(chatReq({ model: "openai/gpt-3.5" }));
  assertEquals(other, undefined);
});

Deno.test("message regex condition matches concatenated message text", async () => {
  const config: MockerConfig = {
    rules: [{
      name: "weatherRule",
      conditions: { messageRegex: "weather" },
      responses: [{ type: "success", content: { message: "sunny" } }],
    }],
  };
  const hit = await mgr(config, { rng: zeroRng }).executeShortCircuit(
    chatReq({ messages: [{ role: "user", content: "what is the weather?" }] }),
  );
  assertEquals(hit?.choices[0].message.content, "sunny");
  const miss = await mgr(config, { rng: zeroRng }).executeShortCircuit(
    chatReq({ messages: [{ role: "user", content: "hello" }] }),
  );
  assertEquals(miss, undefined);
});

Deno.test("higher-priority rules are evaluated first", async () => {
  const config: MockerConfig = {
    rules: [
      {
        name: "low",
        priority: 1,
        responses: [{ type: "success", content: { message: "low" } }],
      },
      {
        name: "high",
        priority: 10,
        responses: [{ type: "success", content: { message: "high" } }],
      },
    ],
  };
  const res = await mgr(config, { rng: zeroRng }).executeShortCircuit(
    chatReq(),
  );
  assertEquals(res?.choices[0].message.content, "high");
});

// --- probability gate ------------------------------------------------------

Deno.test("probability gate activates or passes through by the injected draw", async () => {
  const config: MockerConfig = {
    rules: [{
      name: "half",
      probability: 0.5,
      responses: [{ type: "success", content: { message: "mocked" } }],
    }],
  };
  const activated = await mgr(config, { rng: constRng(0.4) })
    .executeShortCircuit(chatReq()); // 0.4 < 0.5 -> fire
  assertEquals(activated?.choices[0].message.content, "mocked");
  const skipped = await mgr(config, { rng: constRng(0.6) })
    .executeShortCircuit(chatReq()); // 0.6 >= 0.5 -> passthrough
  assertEquals(skipped, undefined);
});

// --- error injection -------------------------------------------------------

Deno.test("error injection at probability=1 throws a mapped gateway error", async () => {
  const m = mgr({
    rules: [{
      name: "boom",
      probability: 1,
      responses: [{
        type: "error",
        error: {
          message: "rate limited",
          type: "rate_limit_error",
          code: "429",
          statusCode: 429,
        },
      }],
    }],
  }, { rng: zeroRng });
  const err = await assertRejects(
    () => m.executeShortCircuit(chatReq()),
    GatewayError,
    "rate limited",
  ) as GatewayError;
  assertEquals(err.status, 429);
  assertEquals(err.type, "rate_limit_error");
  assertEquals(err.code, "429");
});

// --- latency simulation (bounded, deterministic) ---------------------------

Deno.test("computeLatencyMs is fixed at min and bounded within a uniform range", () => {
  assertEquals(
    computeLatencyMs({ type: "fixed", min: 120 }, constRng(0.99)),
    120,
  );
  for (const r of [0, 0.25, 0.5, 0.999]) {
    const ms = computeLatencyMs(
      { type: "uniform", min: 100, max: 200 },
      constRng(r),
    );
    assertEquals(ms >= 100 && ms < 200, true);
  }
  // Degenerate range collapses to min.
  assertEquals(
    computeLatencyMs({ type: "uniform", min: 50, max: 50 }, constRng(0.5)),
    50,
  );
});

Deno.test("a matched rule waits the computed latency before responding", async () => {
  const slept: number[] = [];
  const m = mgr({
    rules: [{
      name: "slow",
      latency: { type: "uniform", min: 100, max: 200 },
      responses: [{ type: "success", content: { message: "ok" } }],
    }],
  }, {
    rng: constRng(0.5),
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });
  const res = await m.executeShortCircuit(chatReq());
  assertEquals(slept, [150]); // 100 + 0.5 * (200 - 100)
  assertEquals(res?.choices[0].message.content, "ok");
});

// --- weighted response selection -------------------------------------------

Deno.test("selectResponseIndex maps a draw onto the cumulative bucket", () => {
  assertEquals(selectResponseIndex([0.5, 1], 0), 0);
  assertEquals(selectResponseIndex([0.5, 1], 0.5), 0);
  assertEquals(selectResponseIndex([0.5, 1], 0.75), 1);
  assertEquals(selectResponseIndex([0.5, 1], 0.999), 1);
});

Deno.test("weighted response selection is driven by the injected rng", async () => {
  const config: MockerConfig = {
    rules: [{
      name: "ab",
      responses: [
        { type: "success", weight: 1, content: { message: "A" } },
        { type: "success", weight: 1, content: { message: "B" } },
      ],
    }],
  };
  const low = await mgr(config, { rng: constRng(0) }).executeShortCircuit(
    chatReq(),
  );
  assertEquals(low?.choices[0].message.content, "A");
  const high = await mgr(config, { rng: constRng(0.9) }).executeShortCircuit(
    chatReq(),
  );
  assertEquals(high?.choices[0].message.content, "B");
});

// --- faker / template expansion --------------------------------------------

Deno.test("template expander fills provider/model and faker tokens", () => {
  const rng = zeroRng;
  assertEquals(
    expandTemplate("m={{model}} p={{provider}}", {
      provider: "openai",
      model: "gpt-4o",
    }, rng),
    "m=gpt-4o p=openai",
  );
  assertEquals(expandTemplate("{{faker.name}}", {}, rng), "Ada Archer");
  assertEquals(
    expandTemplate("{{faker.email}}", {}, rng),
    "ada.archer@example.com",
  );
  assertEquals(
    expandTemplate("{{faker.uuid}}", {}, rng),
    "00000000-0000-4000-8000-000000000000",
  );
  assertEquals(expandTemplate("{{faker.number}}", {}, rng), "1");
  assertEquals(expandTemplate("{{faker.number:10,20}}", {}, rng), "10");
  assertEquals(
    expandTemplate("{{faker.lorem:3}}", {}, rng),
    "lorem lorem lorem",
  );
  // Unknown method is preserved verbatim.
  assertEquals(expandTemplate("{{faker.bogus}}", {}, rng), "{{faker.bogus}}");
});

Deno.test("a matched rule expands a message template into the mock response", async () => {
  const m = mgr({
    rules: [{
      name: "greet",
      responses: [{
        type: "success",
        content: { messageTemplate: "Hi from {{model}}: {{faker.first_name}}" },
      }],
    }],
  }, { rng: zeroRng });
  const res = await m.executeShortCircuit(chatReq({ model: "openai/gpt-4o" }));
  assertEquals(res?.choices[0].message.content, "Hi from openai/gpt-4o: Ada");
});

// --- default behavior when no rule matches ---------------------------------

const NEVER_MATCH: MockerConfig["rules"] = [{
  name: "never",
  conditions: { models: ["nope"] },
  responses: [{ type: "success", content: { message: "x" } }],
}];

Deno.test("default passthrough returns undefined when no rule matches", async () => {
  const m = mgr({ rules: NEVER_MATCH, defaultBehavior: "passthrough" }, {
    rng: zeroRng,
  });
  assertEquals(await m.executeShortCircuit(chatReq()), undefined);
});

Deno.test("default success returns a canned mock when no rule matches", async () => {
  const m = mgr({ rules: NEVER_MATCH, defaultBehavior: "success" }, {
    rng: zeroRng,
  });
  const res = await m.executeShortCircuit(chatReq());
  assertEquals(res?.choices[0].message.content, "Mock plugin default response");
  assertEquals(res?.usage, {
    prompt_tokens: 5,
    completion_tokens: 10,
    total_tokens: 15,
  });
});

Deno.test("default error injects a generic gateway error when no rule matches", async () => {
  const m = mgr({ rules: NEVER_MATCH, defaultBehavior: "error" }, {
    rng: zeroRng,
  });
  await assertRejects(
    () => m.executeShortCircuit(chatReq()),
    GatewayError,
    "Mock plugin default error",
  );
});

// --- built-in catch-all + streaming passthrough ----------------------------

Deno.test("no rules + enabled yields the built-in catch-all mock", async () => {
  const res = await mgr({}, { rng: zeroRng }).executeShortCircuit(chatReq());
  assertEquals(
    res?.choices[0].message.content,
    "This is a mock response from the Mocker plugin",
  );
});

Deno.test("streaming requests pass through (never mocked)", async () => {
  const res = await mgr({}, { rng: zeroRng })
    .executeShortCircuit(chatReq({ stream: true }));
  assertEquals(res, undefined);
});

// --- observability hook ----------------------------------------------------

Deno.test("onMock fires with the rule name and response type", async () => {
  const seen: Array<{ rule: string; type: string }> = [];
  const m = mgr({
    rules: [{
      name: "greet",
      responses: [{ type: "success", content: { message: "hi" } }],
    }],
  }, { rng: zeroRng, onMock: (info) => seen.push(info) });
  await m.executeShortCircuit(chatReq());
  assertEquals(seen, [{ rule: "greet", type: "success" }]);
});
