import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  GenAIGenerateContentRequest,
  ToolCall,
} from "../../../packages/contracts/src/mod.ts";
import {
  GenAIGenerateContentRequestSchema,
  ToolCallSchema,
} from "../../../packages/contracts/src/mod.ts";
import {
  CohereStreamTranslator,
  createSSEResponse,
  GatewayError,
  gatewayErrorResponse,
  GenAIStreamTranslator,
  type Router,
  translateSSEBody,
} from "../../../packages/core/src/mod.ts";
import type { AppContext } from "../context.ts";
import { runChatCompletion } from "./inference.ts";
import {
  carryGatewayHeaders,
  jsonResponse,
  mapDispatchError,
  parseJsonBody,
  validationErrorResponse,
} from "./helpers.ts";

/** Aggregator prefixes (LiteLLM / LangChain / PydanticAI). */
const AGGREGATOR_PREFIXES = ["/litellm", "/langchain", "/pydanticai"];

/**
 * Sub-paths that resolve to a native frosty handler once an aggregator prefix
 * is stripped: canonical OpenAI + Anthropic (`/v1/`), GenAI
 * (`/genai/v1beta/...`) and Cohere (`/cohere/v2/chat`). Bedrock native ingress
 * (`/bedrock/...`, `/model/.../converse[-stream]`) is deliberately absent — it
 * is a documented P2 gap answered by dedicated 501 stub routes below, so the
 * middleware leaves those paths intact rather than stripping them.
 */
const AGGREGATOR_NATIVE_SUBPATHS = ["/v1/", "/genai/", "/cohere/"];

/**
 * Canonical path for a dialect-shaped request, or null when the path already
 * addresses a native frosty surface (or must stay intact for a stub / 404).
 *
 * - Aggregator prefixes strip when the remainder is a native sub-path;
 *   Bedrock-shaped remainders keep the prefix for the registered 501 stub.
 * - `/openai` and `/anthropic` front the canonical `/v1/*` surface only. Azure's
 *   deployment-scoped family under `/openai/deployments/*` is served by its own
 *   routes, so it is deliberately NOT rewritten.
 * - `/openrouter/api/v1/*` folds onto the registered `/openrouter/v1/*` shape,
 *   and a stock Google GenAI SDK pointed at the gateway root (`/v1beta/*`)
 *   folds onto `/genai/*`.
 */
function rewritePath(path: string): string | null {
  for (const prefix of AGGREGATOR_PREFIXES) {
    if (path === prefix) {
      return "/";
    }
    if (path.startsWith(`${prefix}/`)) {
      const rest = path.slice(prefix.length); // retains the leading "/"
      return AGGREGATOR_NATIVE_SUBPATHS.some((s) => rest.startsWith(s))
        ? rest
        : null;
    }
  }

  if (path === "/openrouter/api/v1" || path.startsWith("/openrouter/api/v1/")) {
    return `/openrouter/v1${path.slice("/openrouter/api/v1".length)}`;
  }
  if (path.startsWith("/v1beta/")) {
    return `/genai${path}`;
  }
  if (path.startsWith("/openai/deployments/")) {
    return null;
  }
  for (const prefix of ["/openai", "/anthropic"]) {
    if (path === prefix || path.startsWith(`${prefix}/v1/`)) {
      return path.slice(prefix.length) || "/";
    }
  }
  return null;
}

/** Printable, space-free, bounded: what `Headers.set` accepts as a bearer. */
const CREDENTIAL_VALUE = /^[\x21-\x7E]{1,4096}$/;

/**
 * Credential header a dialect's own SDK sends, keyed off the REQUEST-SHAPE path
 * (before any rewrite). Stock Anthropic, Google and Azure clients cannot send
 * `Authorization: Bearer`, so without this they could not authenticate at all.
 */
function credentialHeaderFor(path: string): string | null {
  // Anchored to the registered shapes, not substrings: a bare `includes()`
  // would promote a credential on any future route whose path merely contained
  // one of these segments, including under /api.
  switch (dialectFor(path)) {
    case "anthropic":
      return "x-api-key";
    case "genai":
      return "x-goog-api-key";
    case "azure":
      return "api-key";
    default:
      return null;
  }
}

/** Optional aggregator or single-provider prefix, then the dialect's shape. */
const AGG = "(?:\\/(?:litellm|langchain|pydanticai))?";
const ANTHROPIC_SHAPE = new RegExp(
  `^${AGG}(?:\\/(?:anthropic|openai))?\\/v1\\/messages(?:\\/[^\\/]+)?$`,
);
const GENAI_SHAPE = new RegExp(`^(?:${AGG}\\/genai\\/|\\/v1beta\\/)`);
const AZURE_SHAPE = /^\/openai\/(?:deployments\/|v1\/)/;

/**
 * Which dialect a request SHAPE belongs to, decided before any rewrite. Both
 * the credential header and the error envelope key off this one function, so
 * they can never disagree about the same path.
 */
function dialectFor(path: string): "anthropic" | "genai" | "azure" | null {
  if (ANTHROPIC_SHAPE.test(path)) {
    return "anthropic";
  }
  if (GENAI_SHAPE.test(path)) {
    return "genai";
  }
  if (AZURE_SHAPE.test(path)) {
    return "azure";
  }
  return null;
}

/** Dialect whose native error envelope this request shape expects. */
function errorDialectFor(path: string): "anthropic" | "genai" | null {
  const dialect = dialectFor(path);
  return dialect === "azure" ? null : dialect;
}

function anthropicErrorType(status: number): string {
  switch (status) {
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 429:
      return "rate_limit_error";
    case 529:
      return "overloaded_error";
    default:
      return status >= 500 ? "api_error" : "invalid_request_error";
  }
}

function genaiStatusName(status: number): string {
  switch (status) {
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "PERMISSION_DENIED";
    case 404:
      return "NOT_FOUND";
    case 429:
      return "RESOURCE_EXHAUSTED";
    default:
      return status >= 500 ? "INTERNAL" : "INVALID_ARGUMENT";
  }
}

/**
 * Re-shapes the canonical error envelope into the dialect's own. Sits outside
 * governance and the router, so a 401/402/429 denial and a route validation
 * error reach the client in the shape its SDK parses. Response headers are
 * carried over intact (x-request-id, Retry-After, Allow).
 */
async function reshapeError(
  response: Response,
  dialect: "anthropic" | "genai",
): Promise<Response> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (response.status < 400 || !contentType.includes("application/json")) {
    return response;
  }
  const headers = new Headers(response.headers);
  const text = await response.text();
  let message: string | undefined;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown; code?: unknown };
    };
    if (typeof parsed?.error?.message === "string") {
      message = parsed.error.message;
    }
    if (typeof parsed?.error?.code === "string") {
      code = parsed.error.code;
    }
  } catch {
    // Not the canonical envelope: hand the body back untouched.
  }
  if (message === undefined) {
    return new Response(text, { status: response.status, headers });
  }
  const body = dialect === "anthropic"
    ? {
      type: "error",
      error: { type: anthropicErrorType(response.status), message },
    }
    : {
      error: {
        code: response.status,
        message,
        status: genaiStatusName(response.status),
        // GenAI's `code` is an HTTP status, so the gateway's own machine
        // -readable code would be lost. Google's format carries it here.
        ...(code
          ? {
            details: [{
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: code,
            }],
          }
          : {}),
      },
    };
  return new Response(JSON.stringify(body), {
    status: response.status,
    headers,
  });
}

/**
 * The dialect front door: rewrites alias/vendor path shapes onto native frosty
 * paths, promotes a dialect's own credential header to the canonical bearer,
 * and translates error envelopes on the way back out. Runs BEFORE governance so
 * every dialect is admitted through the identical hashed virtual-key check.
 */
export function compatPrefixMiddleware(): (
  req: Request,
  next: (req: Request) => Promise<Response>,
) => Promise<Response> {
  return async (req, next) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const rewritten = rewritePath(path);
    const credentialHeader = credentialHeaderFor(path);
    const dialect = errorDialectFor(path);

    let request = req;
    if (rewritten !== null || credentialHeader) {
      const headers = new Headers(req.headers);
      let urlChanged = false;
      if (rewritten !== null) {
        url.pathname = rewritten;
        urlChanged = true;
      }
      if (credentialHeader) {
        // Touching searchParams re-serializes the whole query string (`?flag`
        // becomes `?flag=`), so only reach for it when a key is actually there.
        const hasKeyParam = credentialHeader === "x-goog-api-key" &&
          /[?&]key=/.test(url.search);
        const queryKey = hasKeyParam ? url.searchParams.get("key") : null;
        const auth = headers.get("Authorization");
        const raw = headers.get(credentialHeader) ?? queryKey;
        // A malformed value is treated as NO credential (normal 401) rather
        // than thrown at Headers.set, which would echo it into the error log.
        if (
          !auth?.startsWith("Bearer ") && raw && CREDENTIAL_VALUE.test(raw)
        ) {
          headers.set("Authorization", `Bearer ${raw}`);
        }
        // Keep credentials out of the access log, which prints the full URL.
        if (queryKey !== null) {
          url.searchParams.delete("key");
          urlChanged = true;
        }
      }
      // Pinned construction: URL first, then headers. This is the only
      // combination that changes both while preserving the body AND req.signal
      // (a plain init would mint a fresh signal, killing abort propagation).
      request = new Request(
        new Request(urlChanged ? url : req.url, req),
        { headers },
      );
    }

    const response = await next(request);
    return dialect ? await reshapeError(response, dialect) : response;
  };
}

// ------------------------------------------------------------------- GenAI

/** Base64 blob carried by an `inlineData` part (both wire spellings). */
type GenAIInlineData = {
  mimeType?: string;
  mime_type?: string;
  data?: string;
};

/**
 * The `contents[].parts[]` variants this ingress understands. A part is a
 * one-of on the wire; anything not listed here (fileData, executableCode, ...)
 * has no canonical equivalent and is skipped.
 */
type GenAIPartShape = {
  text?: string;
  inlineData?: GenAIInlineData;
  /** REST sends camelCase; the published SDK samples spell it snake_case. */
  inline_data?: GenAIInlineData;
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name?: string; response?: unknown };
};

type CanonicalImagePart = { type: "image_url"; image_url: { url: string } };

/** `inlineData` -> canonical `image_url` part with a data: URL. */
function inlineDataToPart(part: GenAIPartShape): CanonicalImagePart | null {
  const inline = part.inlineData ?? part.inline_data;
  if (!inline || typeof inline.data !== "string" || inline.data.length === 0) {
    return null;
  }
  const media = inline.mimeType ?? inline.mime_type ?? "image/png";
  return {
    type: "image_url",
    image_url: { url: `data:${media};base64,${inline.data}` },
  };
}

/** `systemInstruction` accepts a Content object or a bare string. */
function genaiSystemText(
  instruction: GenAIGenerateContentRequest["systemInstruction"],
): string {
  if (typeof instruction === "string") {
    return instruction;
  }
  return (instruction?.parts ?? [])
    .map((p) => (p as GenAIPartShape).text ?? "")
    .join("");
}

/**
 * `tools[].functionDeclarations[]` -> canonical function tools. Entries that
 * declare a built-in server-side tool instead (googleSearch, codeExecution,
 * ...) are skipped: they have no canonical equivalent, and forwarding them in
 * the OpenAI `tools` slot would be rejected at egress.
 */
function mapGenAITools(
  tools: GenAIGenerateContentRequest["tools"],
): ChatCompletionRequest["tools"] {
  const mapped = (tools ?? [])
    .flatMap((entry) => {
      const declarations = (entry as {
        functionDeclarations?: Array<{
          name?: string;
          description?: string;
          parameters?: Record<string, unknown>;
        }>;
      }).functionDeclarations;
      return Array.isArray(declarations) ? declarations : [];
    })
    .map((declaration) => ({
      type: "function" as const,
      function: {
        name: declaration.name ?? "",
        description: declaration.description,
        parameters: declaration.parameters,
      },
    }));
  return mapped.length > 0 ? mapped : undefined;
}

/** `toolConfig.functionCallingConfig` -> canonical tool_choice. */
function mapGenAIToolChoice(
  toolConfig: unknown,
): ChatCompletionRequest["tool_choice"] {
  const config = (toolConfig as {
    functionCallingConfig?: { mode?: string; allowedFunctionNames?: string[] };
  } | undefined)?.functionCallingConfig;
  if (!config) {
    return undefined;
  }
  const allowed = config.allowedFunctionNames ?? [];
  switch (String(config.mode ?? "").toUpperCase()) {
    case "AUTO":
      return "auto";
    case "NONE":
      return "none";
    case "ANY":
      return allowed.length === 1
        ? { type: "function", function: { name: allowed[0] } }
        : "required";
    default:
      return undefined;
  }
}

/** Canonical finish_reason -> GenAI finishReason. */
function mapGenAIFinishReason(reason: string | null | undefined): string {
  switch (reason) {
    case "length":
      return "MAX_TOKENS";
    case "content_filter":
      return "SAFETY";
    // "tool_calls" included: GenAI has no such enum member - the functionCall
    // part in the candidate is itself the signal.
    default:
      return "STOP";
  }
}

/**
 * GenAI GenerateContentRequest -> canonical chat completion. `stream` comes
 * from the ACTION (`:streamGenerateContent`), not the body, since GenAI has no
 * stream flag.
 */
function genaiToCanonical(
  model: string,
  req: GenAIGenerateContentRequest,
  stream?: boolean,
): ChatCompletionRequest {
  const messages: ChatCompletionRequest["messages"] = [];
  const systemText = genaiSystemText(req.systemInstruction);
  if (systemText) {
    messages.push({ role: "system", content: systemText });
  }

  // GenAI carries no tool-call ids, so they are synthesized per function name
  // as `genai_call_<name>_<n>`. Deterministic on purpose: a functionResponse in
  // a later turn is matched back to its functionCall by name, and a replayed
  // request maps to byte-identical canonical messages.
  const callCounts = new Map<string, number>();
  const openCallIds = new Map<string, string[]>();

  for (const content of req.contents ?? []) {
    const textParts: string[] = [];
    const imageParts: CanonicalImagePart[] = [];
    const toolCalls: ToolCall[] = [];
    const toolResults: Array<{ id: string; content: string }> = [];

    for (const raw of content.parts ?? []) {
      const part = raw as GenAIPartShape;
      if (typeof part.text === "string" && part.text.length > 0) {
        textParts.push(part.text);
        continue;
      }
      const image = inlineDataToPart(part);
      if (image) {
        imageParts.push(image);
        continue;
      }
      if (part.functionCall) {
        const name = part.functionCall.name ?? "";
        const occurrence = callCounts.get(name) ?? 0;
        callCounts.set(name, occurrence + 1);
        const id = `genai_call_${name}_${occurrence}`;
        openCallIds.set(name, [...(openCallIds.get(name) ?? []), id]);
        toolCalls.push({
          id,
          type: "function",
          function: {
            name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          },
        });
        continue;
      }
      if (part.functionResponse) {
        const name = part.functionResponse.name ?? "";
        const open = openCallIds.get(name) ?? [];
        const id = open.pop() ?? `genai_call_${name}_0`;
        openCallIds.set(name, open);
        toolResults.push({
          id,
          content: JSON.stringify(part.functionResponse.response ?? {}),
        });
      }
    }

    // Multimodal turns become canonical PART ARRAYS; text-only turns keep the
    // plain-string content shape they have always had.
    const text = textParts.join("");
    const multimodal = imageParts.length > 0;
    const parts = [
      ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
      ...imageParts,
    ];

    if (content.role === "model") {
      messages.push({
        role: "assistant",
        content: multimodal ? parts : (text || null),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      for (const result of toolResults) {
        messages.push({
          role: "tool",
          tool_call_id: result.id,
          content: result.content,
        });
      }
      if (textParts.length > 0 || multimodal || toolResults.length === 0) {
        messages.push({ role: "user", content: multimodal ? parts : text });
      }
    }
  }

  const {
    temperature,
    topP,
    topK,
    maxOutputTokens,
    stopSequences,
    responseMimeType,
    responseSchema,
    ...carriedConfig
  } = req.generationConfig ?? {};

  const responseFormat = responseMimeType === "application/json"
    ? (responseSchema !== undefined
      ? {
        type: "json_schema" as const,
        json_schema: { name: "response", schema: responseSchema },
      }
      : { type: "json_object" as const })
    : undefined;

  // Fields with no canonical equivalent (safetySettings, cachedContent,
  // generationConfig.thinkingConfig / candidateCount and any unknown vendor key
  // the passthrough schema admitted) ride to egress rather than being dropped
  // here. candidateCount deliberately does NOT become `n`: the edge translators
  // emit a single candidate.
  const {
    contents: _contents,
    systemInstruction: _systemInstruction,
    generationConfig: _generationConfig,
    tools: _tools,
    toolConfig: _toolConfig,
    ...carried
  } = req as GenAIGenerateContentRequest & Record<string, unknown>;

  return {
    ...carried,
    ...carriedConfig,
    model,
    messages,
    stream,
    temperature,
    top_p: topP,
    ...(topK !== undefined ? { top_k: topK } : {}),
    max_tokens: maxOutputTokens,
    stop: stopSequences,
    tools: mapGenAITools(req.tools),
    tool_choice: mapGenAIToolChoice(req.toolConfig),
    response_format: responseFormat,
  };
}

function canonicalToGenAI(chat: ChatCompletionResponse) {
  const message = chat.choices[0]?.message;
  const parts: Array<Record<string, unknown>> = [];
  const text = typeof message?.content === "string" ? message.content : "";
  if (text.length > 0) {
    parts.push({ text });
  }
  for (const raw of message?.tool_calls ?? []) {
    const parsed = ToolCallSchema.safeParse(raw);
    if (!parsed.success) {
      continue;
    }
    let args: unknown = {};
    try {
      args = JSON.parse(parsed.data.function.arguments || "{}");
    } catch {
      args = {};
    }
    parts.push({ functionCall: { name: parsed.data.function.name, args } });
  }
  if (parts.length === 0) {
    parts.push({ text: "" });
  }
  const usage = chat.usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | undefined;
  return {
    candidates: [{
      content: { role: "model", parts },
      finishReason: mapGenAIFinishReason(chat.choices[0]?.finish_reason),
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: usage?.prompt_tokens ?? 0,
      candidatesTokenCount: usage?.completion_tokens ?? 0,
      totalTokenCount: usage?.total_tokens ?? 0,
    },
    modelVersion: chat.model,
  };
}

/**
 * `:countTokens`. Same policy as POST /v1/count_tokens (routes/inference.ts):
 * the provider's native counter when it has one, else the documented chars/4
 * estimate, flagged `estimated`.
 */
async function genaiCountTokens(
  ctx: AppContext,
  canonical: ChatCompletionRequest,
  signal?: AbortSignal,
): Promise<Response> {
  const target = ctx.providers.resolve(canonical.model);
  if (target.adapter.countTokens) {
    const counted = await target.adapter.countTokens(
      { ...canonical, model: target.model },
      { signal },
    );
    return jsonResponse({
      totalTokens: counted.input_tokens,
      ...(counted.estimated ? { estimated: true } : {}),
    });
  }
  const chars = canonical.messages
    .map((m) => (typeof m.content === "string" ? m.content.length : 0))
    .reduce((a, b) => a + b, 0);
  return jsonResponse({ totalTokens: Math.ceil(chars / 4), estimated: true });
}

// ------------------------------------------------------------------- Cohere

interface CohereChatRequest {
  model?: string;
  messages?: Array<{ role: string; content: unknown }>;
  max_tokens?: number;
  temperature?: number;
  p?: number;
  stop_sequences?: string[];
  stream?: boolean;
}

function cohereToCanonical(req: CohereChatRequest): ChatCompletionRequest {
  return {
    model: req.model ?? "",
    messages: (req.messages ?? []).map((m) => ({
      role: (m.role === "system" || m.role === "assistant" ? m.role : "user") as
        | "system"
        | "assistant"
        | "user",
      content: typeof m.content === "string" ? m.content : "",
    })),
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.p,
    stop: req.stop_sequences,
  };
}

function canonicalToCohere(chat: ChatCompletionResponse) {
  const text = typeof chat.choices[0]?.message.content === "string"
    ? chat.choices[0].message.content
    : "";
  const usage = chat.usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
  } | undefined;
  return {
    id: chat.id.replace(/^chatcmpl-/, ""),
    // Cohere's own response omits the model. The gateway adds it so cost
    // accounting has something to price; without it the surface bills nothing.
    model: chat.model,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
    finish_reason: chat.choices[0]?.finish_reason === "length"
      ? "MAX_TOKENS"
      : "COMPLETE",
    usage: {
      billed_units: {
        input_tokens: usage?.prompt_tokens ?? 0,
        output_tokens: usage?.completion_tokens ?? 0,
      },
    },
  };
}

/**
 * Runs a translated dialect request through the shared canonical engine and
 * translates the result back at the edge. `runChatCompletion` owns cache,
 * plugins, the tool loop, capability gates and budget accounting, and its
 * plugin stream tap sits on the CANONICAL stream before this translation
 * (decision-log 15), so no surface needs a second dispatch path.
 */
async function dispatchDialect(
  ctx: AppContext,
  req: Request,
  canonical: ChatCompletionRequest,
  translator: (model: string) => TransformStream<string, string>,
  toDialect: (chat: ChatCompletionResponse) => unknown,
): Promise<Response> {
  const response = await runChatCompletion(ctx, req, canonical);
  if (!response.ok) {
    return response;
  }
  if (canonical.stream) {
    return carryGatewayHeaders(
      response,
      createSSEResponse(
        translateSSEBody(response.body!, translator(canonical.model)),
      ),
    );
  }
  const chat = await response.json() as ChatCompletionResponse;
  return carryGatewayHeaders(response, jsonResponse(toDialect(chat)));
}

export function registerCompatFamilyRoutes(
  router: Router,
  ctx: AppContext,
): void {
  // Gemini-style: POST /genai/v1beta/models/{model}:{action}
  router.post("/genai/v1beta/models/:modelAction", async (req, match) => {
    const modelAction = decodeURIComponent(
      match.pathname.groups.modelAction ?? "",
    );
    const colon = modelAction.lastIndexOf(":");
    const model = colon > 0 ? modelAction.slice(0, colon) : modelAction;
    const action = colon > 0 ? modelAction.slice(colon + 1) : "";
    ctx.metrics.increment("requests.compat.genai");

    try {
      if (
        action !== "generateContent" && action !== "streamGenerateContent" &&
        action !== "countTokens"
      ) {
        throw new GatewayError(
          404,
          `Unknown GenAI action "${action}".`,
          "invalid_request_error",
        );
      }
      const parsed = GenAIGenerateContentRequestSchema.safeParse(
        await parseJsonBody(req),
      );
      if (!parsed.success) {
        return validationErrorResponse(parsed.error);
      }
      const canonical = genaiToCanonical(
        model,
        parsed.data,
        action === "streamGenerateContent",
      );
      if (action === "countTokens") {
        return await genaiCountTokens(ctx, canonical, req.signal);
      }
      // streamGenerateContent always emits SSE, regardless of ?alt=.
      return await dispatchDialect(
        ctx,
        req,
        canonical,
        (m) => new GenAIStreamTranslator(m),
        canonicalToGenAI,
      );
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  // Cohere-style: POST /cohere/v2/chat
  router.post("/cohere/v2/chat", async (req) => {
    ctx.metrics.increment("requests.compat.cohere");
    try {
      const body = await parseJsonBody(req) as CohereChatRequest;
      return await dispatchDialect(
        ctx,
        req,
        { ...cohereToCanonical(body), stream: body.stream ?? false },
        (m) => new CohereStreamTranslator(m),
        canonicalToCohere,
      );
    } catch (error) {
      return mapDispatchError(error);
    }
  });

  const bedrockStub = (surface: string) => (): Response => {
    ctx.metrics.increment("requests.compat.bedrock_stub");
    return gatewayErrorResponse(
      new GatewayError(
        501,
        `Bedrock native ingress (${surface}) is not implemented on the ` +
          `LiteLLM/LangChain/PydanticAI aggregator surface (deferred P2: ` +
          `Bedrock Converse + converse-stream). Route Bedrock models through ` +
          `the canonical POST /v1/chat/completions (or POST /v1/messages).`,
        "not_implemented",
      ),
    );
  };
  router.post(
    "/:agg(litellm|langchain|pydanticai)/bedrock/:rest*",
    bedrockStub("/{aggregator}/bedrock/…"),
  );
  router.post(
    "/:agg(litellm|langchain|pydanticai)/model/:rest*",
    bedrockStub("/{aggregator}/model/{modelId}/converse[-stream]"),
  );
}
