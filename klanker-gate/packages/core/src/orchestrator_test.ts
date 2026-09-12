import { assertEquals, assertRejects } from "@std/assert";
import {
  extractToolCalls,
  runToolLoop,
  SideEffectDeniedError,
  type ToolExecutor,
  ToolLoopExceededError,
} from "./orchestrator.ts";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../../contracts/src/mod.ts";

function assistantWithTool(
  name: string,
  args: string,
  id = "call_1",
): ChatCompletionResponse {
  return {
    id: "chatcmpl-t",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id,
          type: "function",
          function: { name, arguments: args },
        }],
      },
      finish_reason: "tool_calls",
    }],
  };
}

function finalAnswer(text: string): ChatCompletionResponse {
  return {
    id: "chatcmpl-t",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    }],
  };
}

const baseRequest: ChatCompletionRequest = {
  model: "m",
  messages: [{ role: "user", content: "weather in Oslo?" }],
};

class ScriptedExecutor implements ToolExecutor {
  executed: Array<{ name: string; args: unknown }> = [];
  constructor(
    private owned: Record<string, (args: unknown) => string>,
    private sideEffects: string[] = [],
  ) {}
  has(name: string): boolean {
    return name in this.owned;
  }
  isSideEffect(name: string): boolean {
    return this.sideEffects.includes(name);
  }
  execute(name: string, args: unknown): Promise<string> {
    this.executed.push({ name, args });
    return Promise.resolve(this.owned[name](args));
  }
}

Deno.test("runToolLoop executes gateway tools and feeds results back", async () => {
  const executor = new ScriptedExecutor({
    get_weather: () => JSON.stringify({ temp: 21 }),
  });
  const dispatched: ChatCompletionRequest[] = [];
  let turn = 0;

  const result = await runToolLoop(baseRequest, (req) => {
    dispatched.push(req);
    turn++;
    return Promise.resolve(
      turn === 1
        ? assistantWithTool("get_weather", '{"city":"Oslo"}')
        : finalAnswer("21 degrees"),
    );
  }, executor);

  assertEquals(result.turns, 2);
  assertEquals(result.executedTools, ["get_weather"]);
  assertEquals(result.response.choices[0].message.content, "21 degrees");
  assertEquals(executor.executed[0].args, { city: "Oslo" });

  // Second dispatch must carry the assistant tool call and the tool result.
  const secondMessages = dispatched[1].messages;
  assertEquals(secondMessages.at(-2)?.role, "assistant");
  assertEquals(secondMessages.at(-1)?.role, "tool");
  assertEquals(secondMessages.at(-1)?.tool_call_id, "call_1");
});

Deno.test("runToolLoop passes client-owned tools through untouched", async () => {
  const executor = new ScriptedExecutor({});
  const response = assistantWithTool("client_tool", "{}");
  const result = await runToolLoop(
    baseRequest,
    () => Promise.resolve(response),
    executor,
  );
  assertEquals(result.turns, 1);
  assertEquals(result.executedTools, []);
  assertEquals(result.response, response);
});

Deno.test("runToolLoop feeds a structured error back on malformed arguments", async () => {
  const executor = new ScriptedExecutor({ t: () => "ok" });
  let turn = 0;
  const dispatched: ChatCompletionRequest[] = [];

  const result = await runToolLoop(baseRequest, (req) => {
    dispatched.push(req);
    turn++;
    return Promise.resolve(
      turn === 1 ? assistantWithTool("t", "{not json") : finalAnswer("done"),
    );
  }, executor);

  assertEquals(result.turns, 2);
  assertEquals(executor.executed.length, 0); // never executed
  const toolMsg = dispatched[1].messages.at(-1);
  assertEquals(
    JSON.parse(String(toolMsg?.content)).error,
    "malformed tool arguments",
  );
});

Deno.test("runToolLoop denies unconfirmed side-effect tools", async () => {
  const executor = new ScriptedExecutor(
    { delete_file: () => "gone" },
    ["delete_file"],
  );
  await assertRejects(
    () =>
      runToolLoop(
        baseRequest,
        () => Promise.resolve(assistantWithTool("delete_file", "{}")),
        executor,
      ),
    SideEffectDeniedError,
  );
  assertEquals(executor.executed.length, 0);
});

Deno.test("runToolLoop executes side-effect tools when confirmed", async () => {
  const executor = new ScriptedExecutor(
    { delete_file: () => "gone" },
    ["delete_file"],
  );
  let turn = 0;
  const result = await runToolLoop(
    baseRequest,
    () => {
      turn++;
      return Promise.resolve(
        turn === 1 ? assistantWithTool("delete_file", "{}") : finalAnswer("ok"),
      );
    },
    executor,
    { sideEffectsConfirmed: true },
  );
  assertEquals(result.executedTools, ["delete_file"]);
});

Deno.test("runToolLoop threads MCP hooks around the effective tool call", async () => {
  const executor = new ScriptedExecutor({
    rewritten: (args) => JSON.stringify(args),
  });
  const dispatched: ChatCompletionRequest[] = [];
  let turn = 0;
  const result = await runToolLoop(
    baseRequest,
    (req) => {
      dispatched.push(req);
      turn++;
      return Promise.resolve(
        turn === 1
          ? assistantWithTool("rewritten", '{"city":"Oslo"}')
          : finalAnswer("done"),
      );
    },
    executor,
    {
      onMCPPre: (call) =>
        Promise.resolve({
          name: "rewritten",
          arguments: {
            ...call.arguments as Record<string, unknown>,
            city: "Bergen",
          },
        }),
      onMCPPost: (toolResult) =>
        Promise.resolve({
          ...toolResult,
          result: `wrapped:${toolResult.result}`,
        }),
    },
  );

  assertEquals(result.executedTools, ["rewritten"]);
  assertEquals(executor.executed, [{
    name: "rewritten",
    args: { city: "Bergen" },
  }]);
  assertEquals(
    dispatched[1].messages.at(-1)?.content,
    'wrapped:{"city":"Bergen"}',
  );
});

Deno.test("runToolLoop applies the side-effect gate after an MCP hook rewrite", async () => {
  const executor = new ScriptedExecutor({ delete_file: () => "gone" }, [
    "delete_file",
  ]);
  await assertRejects(
    () =>
      runToolLoop(
        baseRequest,
        () => Promise.resolve(assistantWithTool("delete_file", "{}")),
        executor,
        {
          onMCPPre: () =>
            Promise.resolve({ name: "delete_file", arguments: {} }),
        },
      ),
    SideEffectDeniedError,
  );
  assertEquals(executor.executed.length, 0);
});

Deno.test("runToolLoop enforces the turn cap", async () => {
  const executor = new ScriptedExecutor({ loop_tool: () => "again" });
  await assertRejects(
    () =>
      runToolLoop(
        baseRequest,
        () => Promise.resolve(assistantWithTool("loop_tool", "{}")),
        executor,
        { maxTurns: 3 },
      ),
    ToolLoopExceededError,
  );
});

Deno.test("extractToolCalls ignores malformed tool call entries", () => {
  const response = finalAnswer("x");
  response.choices[0].message.tool_calls = [
    { id: "ok", type: "function", function: { name: "t", arguments: "{}" } },
    { bogus: true },
  ];
  const calls = extractToolCalls(response);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].id, "ok");
});
