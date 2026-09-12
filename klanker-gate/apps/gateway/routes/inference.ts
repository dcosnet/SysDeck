import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  CompletionRequest,
  CompletionResponse,
  ResponsesRequest,
} from "../../../packages/contracts/src/mod.ts";
import {
  ChatCompletionRequestSchema,
  CompletionRequestSchema,
  ResponsesRequestSchema,
} from "../../../packages/contracts/src/mod.ts";
import {
  CompletionsStreamTranslator,
  createSSEResponse,
  GatewayError,
  responsesFromChat,
  ResponsesStreamTranslator,
  responsesToChatRequest,
  type Router,
  runToolLoop,
  translateSSEBody,
  withStreamCompletion,
} from "../../../packages/core/src/mod.ts";
import {
  dispatchWithFallback,
  type ResolvedTarget,
} from "../../../packages/providers/src/mod.ts";
import {
  extractStreamUsage,
  getRequestTenant,
  normalizeUsage,
  tapSseTail,
  type UsageShape,
} from "../../../packages/telemetry/src/usage.ts";
import type { AppContext } from "../context.ts";
import {
  jsonResponse,
  mapDispatchError,
  parseJsonBody,
  validationErrorResponse,
} from "./helpers.ts";
import type { MCPToolDefinition } from "../../../packages/mcp/src/registry.ts";
import {
  codeModeExecutorEnabled,
  runRequested,
} from "../../../packages/mcp/src/codemode/flag.ts";
import { runCodeModeProgram } from "../../../packages/mcp/src/codemode/executor.ts";
import { codeModePublicCatalog } from "./codemode.ts";

/** Upper bound on client-supplied `fallbacks` entries (decision-log 79). */
const MAX_CLIENT_FALLBACKS = 12;

function toolNames(req: ChatCompletionRequest): string[] {
  return (req.tools ?? []).map((t) => {
    const raw = t as Record<string, unknown>;
    const fn = (raw.function ?? raw) as Record<string, unknown>;
    return typeof fn.name === "string" ? fn.name : "";
  }).filter(Boolean);
}

/**
 * Opt-in aggregation gate: `x-frosty-mcp-tools: auto` advertises the gateway's
 * aggregated MCP catalog (client-namespaced tool names) to the model so it can
 * invoke remote tools through the existing tool loop. The header-absent case
 * and streaming requests are returned byte-unchanged (default behavior); the
 * side-effect confirmation gate still applies to any tool the model calls.
 */
function maybeInjectMCPTools(
  ctx: AppContext,
  request: ChatCompletionRequest,
  headers: Headers,
): ChatCompletionRequest {
  if (request.stream) {
    return request;
  }
  if (headers.get("x-frosty-mcp-tools") !== "auto") {
    return request;
  }
  const mcpTools = ctx.mcp.toolDefinitions();
  if (mcpTools.length === 0) {
    return request;
  }
  return { ...request, tools: [...(request.tools ?? []), ...mcpTools] };
}

/**
 * Reserved name of the gateway-owned Code Mode meta-tool. Chosen to be
 * STRUCTURALLY IMPOSSIBLE as a `qualifiedName` (which is always
 * `<clientId>__<tool>`): it contains no `__`, so no MCP client id + tool can
 * ever produce it. That makes the meta-tool ↔ MCP-tool precedence unambiguous
 * (threat T14) and is why it is kept OUT of `MCPRegistry.executor()` — it never
 * leaks onto `x-frosty-mcp-tools: auto` or the `/mcp` server surface.
 */
const CODE_MODE_META_TOOL = "frosty_code_mode_run";

/** True iff this request opted into Code Mode AND both executor gates hold. */
function codeModeRunEnabled(headers: Headers): boolean {
  return runRequested(headers) && codeModeExecutorEnabled();
}

/**
 * Code Mode inference opt-in (design §4.1). Advertises ONE gateway-owned
 * meta-tool `frosty_code_mode_run({ program })` iff `x-frosty-code-mode: run`
 * AND `codeModeExecutorEnabled()` AND the request is non-streaming. Otherwise
 * the request is returned BYTE-UNCHANGED (silent no-op, exactly like
 * `x-frosty-mcp-tools: auto` with an empty catalog) — the model cannot invoke
 * what it cannot see, and no mid-inference 403 is introduced for the off case.
 */
function maybeInjectCodeModeTool(
  request: ChatCompletionRequest,
  headers: Headers,
): ChatCompletionRequest {
  if (request.stream) {
    return request;
  }
  if (!codeModeRunEnabled(headers)) {
    return request;
  }
  const metaTool: MCPToolDefinition = {
    type: "function",
    function: {
      name: CODE_MODE_META_TOOL,
      description:
        "Run a TypeScript program in the Code Mode sandbox. The program " +
        "orchestrates MCP tool calls via the injected `sdk.<server>.<tool>` " +
        "and returns a text result. Runs deny-all (no env/net/fs).",
      parameters: {
        type: "object",
        properties: {
          program: {
            type: "string",
            description: "TypeScript program body. Call tools as " +
              "`await sdk.<server>.<tool>(args)` and `return` the result.",
          },
        },
        required: ["program"],
      },
    },
  };
  return { ...request, tools: [...(request.tools ?? []), metaTool] };
}

/**
 * Builds the reserved meta-tool handler map for `runToolLoop` (design §4.2).
 * Empty unless Code Mode is enabled for THIS request, so even if a model
 * hallucinates the reserved name it is treated as a client tool (handed back),
 * never executed. The handler routes to the run harness with the REQUEST-sourced
 * confirm flag (the model/worker cannot forge it) and the public tool catalog.
 */
function codeModeMetaTools(
  ctx: AppContext,
  headers: Headers,
  sideEffectsConfirmed: boolean,
  signal?: AbortSignal,
): Record<string, (args: unknown) => Promise<string>> {
  if (!codeModeRunEnabled(headers)) {
    return {};
  }
  return {
    [CODE_MODE_META_TOOL]: (args: unknown) => {
      const program = args && typeof args === "object" &&
          typeof (args as { program?: unknown }).program === "string"
        ? (args as { program: string }).program
        : "";
      if (!program) {
        return Promise.resolve(
          JSON.stringify({
            error: "frosty_code_mode_run requires a string `program`.",
          }),
        );
      }
      return runCodeModeProgram({
        program,
        sideEffectsConfirmed,
        executor: ctx.toolExecutor,
        catalog: codeModePublicCatalog(ctx),
        signal,
      });
    },
  };
}

/** Own-property meta-tool membership (avoids inherited keys like `constructor`). */
function ownsMetaTool(
  metaTools: Record<string, unknown>,
  name: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(metaTools, name);
}

async function dispatchChat(
  ctx: AppContext,
  request: ChatCompletionRequest,
  signal?: AbortSignal,
): Promise<{ response: Response; target: ResolvedTarget }> {
  // The fallbacks field is a gateway extension — never forward it upstream.
  // It is also client-controlled, and every entry becomes a dispatch attempt,
  // so it is bounded here; operator-configured pool members are not.
  const { fallbacks, ...forward } = request;
  const targets = ctx.providers.resolveChain(
    request.model,
    (fallbacks ?? []).slice(0, MAX_CLIENT_FALLBACKS),
  );
  const primary = targets[0];

  if (request.stream && !primary.capabilities.supportsStreaming) {
    throw new GatewayError(
      400,
      `Provider "${primary.providerId}" does not support streaming.`,
    );
  }
  if (
    (request.tools?.length ?? 0) > 0 && !primary.capabilities.supportsTools
  ) {
    throw new GatewayError(
      400,
      `Provider "${primary.providerId}" does not support tool use.`,
    );
  }

  // Fallbacks are gated the same as the primary: a target that cannot
  // honor the request's shape must not receive it mid-failover.
  const capable = targets.filter((t) =>
    (!request.stream || t.capabilities.supportsStreaming) &&
    ((request.tools?.length ?? 0) === 0 || t.capabilities.supportsTools)
  );

  const outcome = await dispatchWithFallback(
    capable,
    (target) =>
      target.adapter.chatCompletions(
        { ...forward, model: target.model },
        { signal },
      ),
  );
  for (const failure of outcome.failures) {
    ctx.metrics.increment(`provider.${failure.target.providerId}.fallback`);
  }
  ctx.metrics.increment(`provider.${outcome.target.providerId}.success`);
  const providerBudgets = ctx.providerBudgets;
  const providerAccount = outcome.target.account;
  if (!providerBudgets || !providerAccount) {
    return outcome;
  }

  const accountUsage = (
    model: string,
    prompt: number,
    completion: number,
    cached = 0,
    cacheCreation = 0,
  ) => {
    providerBudgets.recordTokens(
      providerAccount,
      prompt + completion + cacheCreation,
    );
    const cost = ctx.pricing?.costMicroUsd(model || outcome.target.model, {
      prompt_tokens: prompt,
      completion_tokens: completion,
      cached_tokens: cached,
      cache_creation_tokens: cacheCreation,
      prompt_tokens_total: prompt,
    });
    if (cost) {
      providerBudgets.recordCost(providerAccount, cost);
    }
  };
  const contentType = outcome.response.headers.get("Content-Type") ?? "";
  if (outcome.response.ok && contentType.includes("application/json")) {
    try {
      const body = await outcome.response.clone().json() as {
        model?: string;
        usage?: UsageShape;
      };
      if (body.usage) {
        const n = normalizeUsage(body.usage);
        const { prompt, completion } = n;
        accountUsage(
          body.model ?? "",
          prompt,
          completion,
          n.cached,
          n.cacheCreation,
        );
      }
    } catch {
      // A malformed response must never turn successful provider egress into
      // a gateway failure; it simply contributes no token or cost usage.
    }
    return outcome;
  }
  if (
    outcome.response.ok && contentType.includes("text/event-stream") &&
    outcome.response.body
  ) {
    const tapped = tapSseTail(outcome.response.body, (text) => {
      const usage = extractStreamUsage(text);
      if (usage) {
        accountUsage(
          usage.model,
          usage.prompt,
          usage.completion,
          usage.cached,
          usage.cacheCreation,
        );
      }
    });
    return {
      ...outcome,
      response: new Response(tapped, {
        status: outcome.response.status,
        headers: outcome.response.headers,
      }),
    };
  }
  return outcome;
}

async function dispatchChatJson(
  ctx: AppContext,
  request: ChatCompletionRequest,
  signal?: AbortSignal,
): Promise<ChatCompletionResponse> {
  const { response } = await dispatchChat(ctx, {
    ...request,
    stream: false,
  }, signal);
  return await response.json() as ChatCompletionResponse;
}

function completionsViaChat(
  chat: ChatCompletionResponse,
  model: string,
): CompletionResponse {
  return {
    id: chat.id.replace(/^chatcmpl-/, "cmpl-"),
    object: "text_completion",
    created: chat.created,
    model,
    choices: chat.choices.map((choice, index) => ({
      text: typeof choice.message.content === "string"
        ? choice.message.content
        : "",
      index,
      finish_reason: choice.finish_reason ?? "stop",
    })),
    usage: chat.usage as CompletionResponse["usage"],
  };
}

/**
 * MCP catalog advertisement for /v1/responses. Mirrors the chat route's
 * `x-frosty-mcp-tools: auto` header AND treats a Responses `type: "mcp"` tool
 * as a request to advertise the gateway's aggregated MCP catalog. The returned
 * function-tool definitions are executed by the shared ToolExecutor.
 */
function responsesMCPTools(
  ctx: AppContext,
  request: ResponsesRequest,
  headers: Headers,
): ReturnType<AppContext["mcp"]["toolDefinitions"]> {
  const wantsMcp = headers.get("x-frosty-mcp-tools") === "auto" ||
    (request.tools ?? []).some((t) => (t as { type?: unknown }).type === "mcp");
  return wantsMcp ? ctx.mcp.toolDefinitions() : [];
}

/**
 * Feature 3 — native Responses passthrough (opt-in via
 * `x-frosty-responses-passthrough: native`). When the resolved target adapter
 * implements rawProxy (openai/azure today), the UNTRANSLATED Responses body is
 * forwarded to the provider's native `/responses` endpoint and returned
 * verbatim. Gated purely on rawProxy presence — no provider-registry flag.
 */
async function responsesNativePassthrough(
  ctx: AppContext,
  raw: unknown,
  req: Request,
): Promise<Response> {
  const model = typeof (raw as { model?: unknown }).model === "string"
    ? (raw as { model: string }).model
    : "";
  const target = ctx.providers.resolve(model);
  if (!target.adapter.rawProxy) {
    throw new GatewayError(
      400,
      `Provider "${target.providerId}" has no native /responses passthrough ` +
        `surface. Omit the x-frosty-responses-passthrough header to use the ` +
        `translation path.`,
      "invalid_request_error",
    );
  }
  ctx.metrics.increment("requests.responses.passthrough");
  // Forward the body untranslated except for stripping the provider prefix from
  // `model` (OpenAI wants the bare id; Azure's deploymentFor reads body.model).
  const body = { ...(raw as Record<string, unknown>), model: target.model };
  const forward = new Request("http://internal/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await target.adapter.rawProxy("/responses", forward, {
    signal: req.signal,
  });
}

export function registerInferenceRoutes(router: Router, ctx: AppContext): void {
  router.get("/v1/models", () => {
    return jsonResponse({ object: "list", data: ctx.providers.models() });
  });

  router.post("/v1/chat/completions", async (req) => {
    const parsed = ChatCompletionRequestSchema.safeParse(
      await parseJsonBody(req),
    );
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    ctx.metrics.increment("requests.chat");
    return await runChatCompletion(ctx, req, parsed.data);
  });

  router.post("/v1/completions", async (req) => {
    const parsed = CompletionRequestSchema.safeParse(await parseJsonBody(req));
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    ctx.metrics.increment("requests.completions");
    return await runCompletion(ctx, req, parsed.data as CompletionRequest);
  });

  registerTokenRoutes(router, ctx);
}

/**
 * Cache namespace for one request, or `undefined` for the shared namespace.
 *
 * The response cache is the only dispatch path that runs BEFORE the virtual
 * key's allowlist is applied, so a key that restricts dispatch gets its own
 * namespace instead of reading and writing the shared one. Unscoped keys and
 * keyless traffic return `undefined` and keep byte-identical cache keys.
 */
function cacheScopeFor(req: Request): string | undefined {
  const tenant = getRequestTenant(req);
  if (!tenant?.dispatchScoped) {
    return undefined;
  }
  // Fail closed: a scope-restricted request never falls back to the shared
  // namespace, even if its key id is somehow absent.
  return tenant.virtualKeyId ?? "scoped";
}

/**
 * Shared canonical chat execution. Every ingress dialect - OpenAI, Anthropic
 * Messages, Google GenAI, Cohere, Azure OpenAI, OpenRouter - runs THIS
 * function, so response cache, plugins, the gateway tool loop, capability
 * gates and per-provider budget accounting apply identically regardless of
 * the wire format the client speaks. Callers own their own request/response
 * translation and their own metrics counter.
 */
export async function runChatCompletion(
  ctx: AppContext,
  req: Request,
  parsedRequest: ChatCompletionRequest,
): Promise<Response> {
  const hasPlugins = ctx.plugins.list().length > 0;
  try {
    const request = hasPlugins
      ? await ctx.plugins.executePreHooks(parsedRequest)
      : parsedRequest;
    // The request logger has already assigned this internal correlation ID.
    // It becomes the stable cache-entry id only if this request stores a
    // response; cache hits deliberately retain their original owner.
    const cacheRequestId = req.headers.get("x-request-id") ?? undefined;
    // Resolved once so the deferred stream-completion write below uses the
    // same namespace the read used.
    const cacheScope = cacheScopeFor(req);

    // Opt-in MCP tool auto-injection, then the Code Mode meta-tool opt-in
    // (both default to `effective === request` when their headers are absent).
    const effective = maybeInjectCodeModeTool(
      maybeInjectMCPTools(ctx, request, req.headers),
      req.headers,
    );

    // Plugins may synthesize a non-streaming response (for example, the
    // opt-in mocker) before any provider egress. Preserve normal post-hook
    // semantics for the synthesized response. Streaming requests are excluded:
    // a JSON body handed to an edge stream translator yields a well-formed but
    // EMPTY stream, silently discarding the synthesized answer.
    if (hasPlugins && !effective.stream) {
      const shortCircuit = await ctx.plugins.executeShortCircuit(effective);
      if (shortCircuit) {
        return jsonResponse(await ctx.plugins.executePostHooks(shortCircuit));
      }
    }

    // Gateway-owned tool orchestration (non-streaming only). The reserved
    // Code Mode meta-tool counts as gateway-owned even though the MCP executor
    // does not know it (strict-equality precedence, T14).
    const confirmed =
      req.headers.get("x-frosty-confirm-side-effects") === "true";
    const metaTools = codeModeMetaTools(
      ctx,
      req.headers,
      confirmed,
      req.signal,
    );
    const gatewayOwnsATool = !effective.stream &&
      toolNames(effective).some((name) =>
        ctx.toolExecutor.has(name) || ownsMetaTool(metaTools, name)
      );
    if (gatewayOwnsATool) {
      const result = await runToolLoop(
        effective,
        (r) => dispatchChatJson(ctx, r, req.signal),
        ctx.toolExecutor,
        {
          sideEffectsConfirmed: confirmed,
          metaTools,
          onMCPPre: (call) => ctx.plugins.executeMCPPre(call),
          onMCPPost: (result) => ctx.plugins.executeMCPPost(result),
        },
      );
      const final = hasPlugins
        ? await ctx.plugins.executePostHooks(result.response)
        : result.response;
      return jsonResponse(final);
    }

    // Response-cache reads remain non-streaming so a `stream: true` caller
    // is never handed a JSON completion. Completed streams are still stored
    // below, ready for a later equivalent non-streaming request.
    const cacheable = ctx.cache && !request.stream;
    const streamCacheable = ctx.cache && request.stream;
    if (cacheable) {
      const lookup = await ctx.cache!.getWithDebug(request, cacheScope);
      if (lookup.response) {
        ctx.metrics.increment("cache.hit");
        const hit = jsonResponse(lookup.response);
        hit.headers.set("x-frosty-cache", "hit");
        hit.headers.set("x-frosty-cache-type", lookup.debug.cache_type);
        return hit;
      }
      ctx.metrics.increment("cache.miss");
    }

    const { response } = await dispatchChat(ctx, request, req.signal);
    if (request.stream) {
      if (!hasPlugins && !streamCacheable) {
        return response;
      }
      if (streamCacheable) {
        ctx.metrics.increment("cache.miss");
      }
      const streamed = withStreamCompletion(
        response,
        async (text, message) => {
          // Keep plugin completion and cache storage on the passive stream tap:
          // neither can alter client-visible SSE bytes or completion timing.
          if (hasPlugins) {
            await ctx.plugins.executeStreamComplete(text, message);
          }
          if (streamCacheable && message) {
            await ctx.cache!.setStreamed(
              request,
              message,
              cacheRequestId,
              cacheScope,
            );
          }
        },
      );
      if (streamCacheable) {
        streamed.headers.set("x-frosty-cache", "miss");
        streamed.headers.set("x-frosty-cache-type", "miss");
      }
      return streamed;
    }
    if (!hasPlugins && !cacheable) {
      return response;
    }
    let chat = await response.json() as ChatCompletionResponse;
    if (hasPlugins) {
      chat = await ctx.plugins.executePostHooks(chat);
    }
    if (cacheable) {
      await ctx.cache!.set(request, chat, cacheRequestId, cacheScope);
    }
    const out = jsonResponse(chat);
    if (cacheable) {
      out.headers.set("x-frosty-cache", "miss");
    }
    return out;
  } catch (error) {
    return mapDispatchError(error);
  }
}

/**
 * Shared canonical completions execution: the provider's native `completions`
 * surface where it has one, else translated through chat.
 */
export async function runCompletion(
  ctx: AppContext,
  req: Request,
  request: CompletionRequest,
): Promise<Response> {
  try {
    const targets = ctx.providers.resolveChain(request.model);
    const primary = targets[0];

    if (primary.adapter.completions) {
      const outcome = await dispatchWithFallback(
        targets.filter((t) => t.adapter.completions),
        (target) =>
          target.adapter.completions!(
            { ...request, model: target.model },
            { signal: req.signal },
          ),
      );
      ctx.metrics.increment(`provider.${outcome.target.providerId}.success`);
      return outcome.response;
    }

    // No native surface: translate through chat.
    const prompt = Array.isArray(request.prompt)
      ? request.prompt.join("\n")
      : request.prompt;
    const chatRequest: ChatCompletionRequest = {
      model: request.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      stop: request.stop,
    };
    if (request.stream) {
      const { response } = await dispatchChat(
        ctx,
        { ...chatRequest, stream: true },
        req.signal,
      );
      return createSSEResponse(translateSSEBody(
        response.body!,
        new CompletionsStreamTranslator(request.model),
      ));
    }
    const chat = await dispatchChatJson(ctx, chatRequest, req.signal);
    return jsonResponse(completionsViaChat(chat, request.model));
  } catch (error) {
    return mapDispatchError(error);
  }
}

/** Token pre-flight plus the OpenAI Responses surface. */
function registerTokenRoutes(router: Router, ctx: AppContext): void {
  // Token pre-flight: native counting where the provider offers it
  // (Anthropic), else a documented chars/4 estimate.
  router.post("/v1/count_tokens", async (req) => {
    const parsed = ChatCompletionRequestSchema.safeParse(
      await parseJsonBody(req),
    );
    if (!parsed.success) {
      return validationErrorResponse(parsed.error);
    }
    ctx.metrics.increment("requests.count_tokens");
    try {
      const target = ctx.providers.resolve(parsed.data.model);
      if (target.adapter.countTokens) {
        const counted = await target.adapter.countTokens(
          { ...parsed.data, model: target.model },
          { signal: req.signal },
        );
        return jsonResponse(counted);
      }
      const chars = parsed.data.messages
        .map((m) => (typeof m.content === "string" ? m.content.length : 0))
        .reduce((a, b) => a + b, 0);
      return jsonResponse({
        input_tokens: Math.ceil(chars / 4),
        estimated: true,
      });
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  router.post("/v1/responses", async (req) => {
    try {
      // Parse inside the try so a malformed-body GatewayError is enveloped by
      // this route's mapDispatchError (consistent with sibling routes).
      const raw = await parseJsonBody(req);
      // Feature 3: opt-in native passthrough, gated on adapter.rawProxy. When
      // the header is absent the behavior below is byte-identical to before.
      if (req.headers.get("x-frosty-responses-passthrough") === "native") {
        return await responsesNativePassthrough(ctx, raw, req);
      }

      const parsed = ResponsesRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return validationErrorResponse(parsed.error);
      }
      const request = parsed.data;
      ctx.metrics.increment("requests.responses");

      if (request.stream) {
        // Streaming forwards `function` tools verbatim (the model's tool calls
        // stream back as function_call items via ResponsesStreamTranslator);
        // the gateway-owned tool loop is non-streaming only, mirroring chat.
        const { response } = await dispatchChat(
          ctx,
          { ...responsesToChatRequest(request), stream: true },
          req.signal,
        );
        // Plugins tap the CANONICAL stream, then we translate at the edge.
        const canonical = ctx.plugins.list().length > 0
          ? withStreamCompletion(
            response,
            (text, message) => ctx.plugins.executeStreamComplete(text, message),
          )
          : response;
        return createSSEResponse(translateSSEBody(
          canonical.body!,
          new ResponsesStreamTranslator(request.model),
        ));
      }

      // Feature 2: full non-streaming agent loop. Forward `function` tools and
      // (when requested) the aggregated MCP catalog, then run the SAME
      // runToolLoop the chat route uses, honoring the side-effect gate.
      const mcpTools = responsesMCPTools(ctx, request, req.headers);
      const chatRequest = maybeInjectCodeModeTool(
        responsesToChatRequest(request, mcpTools),
        req.headers,
      );

      const confirmed =
        req.headers.get("x-frosty-confirm-side-effects") === "true";
      const metaTools = codeModeMetaTools(
        ctx,
        req.headers,
        confirmed,
        req.signal,
      );
      const gatewayOwnsATool = toolNames(chatRequest).some((name) =>
        ctx.toolExecutor.has(name) || ownsMetaTool(metaTools, name)
      );
      if (gatewayOwnsATool) {
        const result = await runToolLoop(
          chatRequest,
          (r) => dispatchChatJson(ctx, r, req.signal),
          ctx.toolExecutor,
          {
            sideEffectsConfirmed: confirmed,
            metaTools,
            onMCPPre: (call) => ctx.plugins.executeMCPPre(call),
            onMCPPost: (result) => ctx.plugins.executeMCPPost(result),
          },
        );
        return jsonResponse(responsesFromChat(request, result.response));
      }

      const chat = await dispatchChatJson(ctx, chatRequest, req.signal);
      return jsonResponse(responsesFromChat(request, chat));
    } catch (error) {
      return mapDispatchError(error);
    }
  });
}
