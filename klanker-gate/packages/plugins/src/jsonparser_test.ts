import { assertEquals } from "@std/assert";
import { PluginManager } from "./lifecycle.ts";
import {
  jsonRepairEnabledFromEnv,
  jsonRepairPlugin,
  repairJson,
  type StreamRepair,
} from "./jsonparser.ts";
import type { ChatCompletionResponse } from "../../contracts/src/mod.ts";
import type { ReconstructedMessage } from "../../core/src/accumulate.ts";

const ENV = "FROSTY_JSON_REPAIR";

// Run `fn` with FROSTY_JSON_REPAIR forced to `value` (or unset), restoring the
// prior process value afterward so tests never leak env state into each other.
function withEnv<T>(value: string | undefined, fn: () => T): T {
  const prior = Deno.env.get(ENV);
  try {
    if (value === undefined) Deno.env.delete(ENV);
    else Deno.env.set(ENV, value);
    return fn();
  } finally {
    if (prior === undefined) Deno.env.delete(ENV);
    else Deno.env.set(ENV, prior);
  }
}

function responseWith(content: string): ChatCompletionResponse {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "length",
    }],
  };
}

function message(content: string): ReconstructedMessage {
  return { role: "assistant", content, id: "chatcmpl-1", model: "m" };
}

// Mirror the boot wiring proposed for apps/gateway/context.ts: register the
// plugin only when opted in. This is the single source of the opt-in guarantee.
function bootPlugins(): PluginManager {
  const plugins = new PluginManager();
  if (jsonRepairEnabledFromEnv()) {
    plugins.register(jsonRepairPlugin());
  }
  return plugins;
}

// --- opt-in gate -----------------------------------------------------------

Deno.test("jsonRepairEnabledFromEnv is OFF by default, opts in on truthy values", () => {
  assertEquals(withEnv(undefined, jsonRepairEnabledFromEnv), false);
  assertEquals(withEnv("", jsonRepairEnabledFromEnv), false);
  assertEquals(withEnv("off", jsonRepairEnabledFromEnv), false);
  assertEquals(withEnv("on", jsonRepairEnabledFromEnv), true);
  assertEquals(withEnv("ON", jsonRepairEnabledFromEnv), true);
  assertEquals(withEnv("1", jsonRepairEnabledFromEnv), true);
  assertEquals(withEnv("true", jsonRepairEnabledFromEnv), true);
});

Deno.test("boot leaves the plugin unregistered by default (opt-in safe)", () => {
  assertEquals(
    withEnv(undefined, bootPlugins).list().includes("jsonparser"),
    false,
  );
});

Deno.test("boot registers the plugin when FROSTY_JSON_REPAIR=on", () => {
  assertEquals(withEnv("on", bootPlugins).list().includes("jsonparser"), true);
});

// --- non-streaming (onPostRequest) -----------------------------------------

Deno.test("disabled boot does not repair an invalid-JSON response", async () => {
  const plugins = withEnv(undefined, bootPlugins);
  const out = await plugins.executePostHooks(responseWith('{"result": [1, 2'));
  assertEquals(out.choices[0].message.content, '{"result": [1, 2'); // unchanged
});

Deno.test("enabled boot repairs an invalid-JSON non-streaming response", async () => {
  const plugins = withEnv("on", bootPlugins);
  const out = await plugins.executePostHooks(responseWith('{"result": [1, 2'));
  assertEquals(out.choices[0].message.content, '{"result": [1, 2]}');
});

Deno.test("enabled boot is a no-op on already-valid JSON", async () => {
  const plugins = withEnv("on", bootPlugins);
  const out = await plugins.executePostHooks(responseWith('{"ok": true}'));
  assertEquals(out.choices[0].message.content, '{"ok": true}');
});

Deno.test("enabled boot is a no-op on non-JSON content", async () => {
  const plugins = withEnv("on", bootPlugins);
  const out = await plugins.executePostHooks(responseWith("just prose"));
  assertEquals(out.choices[0].message.content, "just prose");
});

// --- streaming (onStreamComplete via the reconstructed message) -------------

Deno.test("streaming path repairs invalid JSON from the reconstructed message", async () => {
  const repairs: StreamRepair[] = [];
  const plugins = new PluginManager();
  plugins.register(
    jsonRepairPlugin({ onStreamRepair: (r) => repairs.push(r) }),
  );

  await plugins.executeStreamComplete(
    '{"result": [1, 2', // legacy text arg (ignored: the message wins)
    message('{"result": [1, 2'), // reconstructed accumulation
  );

  assertEquals(repairs.length, 1);
  assertEquals(repairs[0].repaired, '{"result": [1, 2]}');
  assertEquals(repairs[0].original, '{"result": [1, 2');
  assertEquals(repairs[0].id, "chatcmpl-1");
  assertEquals(repairs[0].model, "m");
});

Deno.test("streaming path is a no-op on already-valid JSON", async () => {
  const repairs: StreamRepair[] = [];
  const plugins = new PluginManager();
  plugins.register(
    jsonRepairPlugin({ onStreamRepair: (r) => repairs.push(r) }),
  );
  await plugins.executeStreamComplete('{"ok": true}', message('{"ok": true}'));
  assertEquals(repairs.length, 0);
});

Deno.test("streaming path is a no-op on non-JSON content", async () => {
  const repairs: StreamRepair[] = [];
  const plugins = new PluginManager();
  plugins.register(
    jsonRepairPlugin({ onStreamRepair: (r) => repairs.push(r) }),
  );
  await plugins.executeStreamComplete("hello world", message("hello world"));
  assertEquals(repairs.length, 0);
});

Deno.test("streaming path falls back to the text arg when no message is present", async () => {
  const repairs: StreamRepair[] = [];
  const plugins = new PluginManager();
  plugins.register(
    jsonRepairPlugin({ onStreamRepair: (r) => repairs.push(r) }),
  );
  await plugins.executeStreamComplete('{"a": "hel'); // no reconstructed message
  assertEquals(repairs.length, 1);
  assertEquals(repairs[0].repaired, '{"a": "hel"}');
  assertEquals(repairs[0].id, undefined);
});

Deno.test("streaming path with no sink is a silent no-op", async () => {
  const plugins = new PluginManager();
  plugins.register(jsonRepairPlugin()); // no options
  // Must not throw; the client stream is untouched and nothing is emitted.
  await plugins.executeStreamComplete('{"a": "hel', message('{"a": "hel'));
});

// --- pure repair util ------------------------------------------------------

Deno.test("repairJson is idempotent and a no-op on valid or non-JSON input", () => {
  const once = repairJson('{"a": {"b": [1, 2');
  assertEquals(once, '{"a": {"b": [1, 2]}}');
  assertEquals(repairJson(once), once); // idempotent: repairing a repair is a no-op
  assertEquals(repairJson('{"ok": true}'), '{"ok": true}'); // valid: no-op
  assertEquals(repairJson("plain text"), "plain text"); // non-JSON: returned as-is
});
