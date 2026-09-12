import { assertEquals, assertStrictEquals } from "@std/assert";
import { PluginManager } from "./lifecycle.ts";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../../contracts/src/mod.ts";

const request: ChatCompletionRequest = {
  model: "m",
  messages: [{ role: "user", content: "hi" }],
};

const response: ChatCompletionResponse = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "m",
  choices: [{
    index: 0,
    message: { role: "assistant", content: "hello" },
    finish_reason: "stop",
  }],
};

Deno.test("PluginManager chains pre hooks in registration order", async () => {
  const manager = new PluginManager();
  manager.register({
    name: "tagger",
    onPreRequest: (req) =>
      Promise.resolve({ ...req, user: "tagged" } as ChatCompletionRequest),
  });
  manager.register({
    name: "capper",
    onPreRequest: (req) =>
      Promise.resolve({ ...req, max_tokens: 5 } as ChatCompletionRequest),
  });

  const result = await manager.executePreHooks(request);
  assertEquals(result.user, "tagged");
  assertEquals(result.max_tokens, 5);
});

Deno.test("executeShortCircuit returns the first synthesized response and stops", async () => {
  const manager = new PluginManager();
  let secondCalled = false;
  manager.register({
    name: "first",
    onRequestShortCircuit: () => Promise.resolve(response),
  });
  manager.register({
    name: "second",
    onRequestShortCircuit: () => {
      secondCalled = true;
      return Promise.resolve(response);
    },
  });

  const result = await manager.executeShortCircuit(request);
  assertEquals(result?.id, "chatcmpl-1");
  assertEquals(secondCalled, false); // first winner short-circuits the chain
});

Deno.test("executeShortCircuit returns undefined when no plugin short-circuits", async () => {
  const manager = new PluginManager();
  // A plugin without the hook is skipped; one that returns undefined passes through.
  manager.register({
    name: "transform-only",
    onPreRequest: (r) => Promise.resolve(r),
  });
  manager.register({
    name: "abstains",
    onRequestShortCircuit: () => Promise.resolve(undefined),
  });
  assertEquals(await manager.executeShortCircuit(request), undefined);
});

Deno.test("PluginManager chains post hooks and stream-complete hooks", async () => {
  const manager = new PluginManager();
  const streamTexts: string[] = [];
  manager.register({
    name: "annotator",
    onPostRequest: (res) =>
      Promise.resolve({ ...res, system_fingerprint: "plugin" }),
    onStreamComplete: (text) => {
      streamTexts.push(text);
      return Promise.resolve();
    },
  });

  const result = await manager.executePostHooks(response);
  assertEquals(result.system_fingerprint, "plugin");

  await manager.executeStreamComplete("streamed text");
  assertEquals(streamTexts, ["streamed text"]);
});

Deno.test("pre-hooks run forward, post-hooks run reverse (Bifrost onion) with 2 plugins", async () => {
  const manager = new PluginManager();
  const preOrder: string[] = [];
  manager.register({
    name: "first",
    onPreRequest: (req) => {
      preOrder.push("first");
      return Promise.resolve(req);
    },
    onPostRequest: (res) =>
      Promise.resolve({
        ...res,
        system_fingerprint: `${res.system_fingerprint ?? ""}first;`,
      }),
  });
  manager.register({
    name: "second",
    onPreRequest: (req) => {
      preOrder.push("second");
      return Promise.resolve(req);
    },
    onPostRequest: (res) =>
      Promise.resolve({
        ...res,
        system_fingerprint: `${res.system_fingerprint ?? ""}second;`,
      }),
  });

  await manager.executePreHooks(request);
  const result = await manager.executePostHooks(response);

  // Pre-hooks: registration (forward) order.
  assertEquals(preOrder, ["first", "second"]);
  // Post-hooks: REVERSE registration order — "second" (last-registered) runs
  // first and appends before "first". This both proves ordering and that the
  // value threads through the chain.
  assertEquals(result.system_fingerprint, "second;first;");
});

Deno.test("transport pre runs forward, transport post runs reverse", async () => {
  const manager = new PluginManager();
  const preOrder: string[] = [];
  const postOrder: string[] = [];
  manager.register({
    name: "a",
    onTransportPre: (req) => {
      preOrder.push("a");
      return Promise.resolve(req);
    },
    onTransportPost: (res) => {
      postOrder.push("a");
      return Promise.resolve(res);
    },
  });
  manager.register({
    name: "b",
    onTransportPre: (req) => {
      preOrder.push("b");
      return Promise.resolve(req);
    },
    onTransportPost: (res) => {
      postOrder.push("b");
      return Promise.resolve(res);
    },
  });

  const req = new Request("http://frosty.test/v1/chat/completions");
  const outReq = await manager.executeTransportPre(req);
  assertEquals(preOrder, ["a", "b"]); // forward
  assertStrictEquals(outReq, req); // identity pass-through when no hook replaces

  const res = new Response("ok");
  const outRes = await manager.executeTransportPost(res);
  assertEquals(postOrder, ["b", "a"]); // reverse
  assertStrictEquals(outRes, res);
});

Deno.test("MCP pre/post hooks fire, transform, and honor onion order", async () => {
  const manager = new PluginManager();
  const order: string[] = [];
  manager.register({
    name: "redactor",
    onMCPPre: (call) => {
      order.push("pre:redactor");
      return Promise.resolve({ ...call, arguments: { redacted: true } });
    },
    onMCPPost: (result) => {
      order.push("post:redactor");
      return Promise.resolve(result);
    },
  });
  manager.register({
    name: "auditor",
    onMCPPre: (call) => {
      order.push("pre:auditor");
      return Promise.resolve(call);
    },
    onMCPPost: (result) => {
      order.push("post:auditor");
      return Promise.resolve({ ...result, result: `${result.result}!` });
    },
  });

  const call = await manager.executeMCPPre({
    name: "get_weather",
    arguments: { city: "Oslo" },
  });
  assertEquals(call.arguments, { redacted: true }); // pre-hook transformed args

  const result = await manager.executeMCPPost({
    name: "get_weather",
    result: "21C",
  });
  assertEquals(result.result, "21C!"); // post-hook transformed the result

  // pre forward, post reverse (onion parity)
  assertEquals(order, [
    "pre:redactor",
    "pre:auditor",
    "post:auditor",
    "post:redactor",
  ]);
});

Deno.test("empty plugin set: every runner is an identity no-op", async () => {
  const manager = new PluginManager();
  assertStrictEquals(await manager.executePreHooks(request), request);
  assertStrictEquals(await manager.executePostHooks(response), response);
  assertEquals(await manager.executeShortCircuit(request), undefined);

  const req = new Request("http://frosty.test/");
  assertStrictEquals(await manager.executeTransportPre(req), req);
  const res = new Response("ok");
  assertStrictEquals(await manager.executeTransportPost(res), res);

  const call = { name: "t", arguments: { a: 1 } };
  assertStrictEquals(await manager.executeMCPPre(call), call);
  const mcpResult = { name: "t", result: "r" };
  assertStrictEquals(await manager.executeMCPPost(mcpResult), mcpResult);

  await manager.executeStreamComplete("text"); // observer runner does not throw
});
