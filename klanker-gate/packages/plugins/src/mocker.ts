import { z } from "zod";
import type { Plugin } from "./lifecycle.ts";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  Message,
} from "../../contracts/src/mod.ts";
import { GatewayError } from "../../core/src/errors.ts";

// --- config schema ---------------------------------------------------------

/** Fixed delay (`min` ms) or a uniform draw across `[min, max)` ms. */
export const LatencySchema = z.object({
  type: z.enum(["fixed", "uniform"]),
  min: z.number().nonnegative(),
  max: z.number().nonnegative().optional(),
});
export type Latency = z.infer<typeof LatencySchema>;

/** Inclusive serialized-size window (approx. JSON characters) for a request. */
export const SizeRangeSchema = z.object({
  min: z.number().nonnegative().optional(),
  max: z.number().nonnegative().optional(),
});

/**
 * A rule fires only when EVERY provided condition matches. `providers` matches
 * the `<provider>/<model>` prefix of the requested model; `models` matches the
 * full requested model or the bare model after the prefix; `messageRegex`
 * matches the concatenated message text; `requestSize` bounds the serialized
 * request size.
 */
export const ConditionsSchema = z.object({
  providers: z.array(z.string()).optional(),
  models: z.array(z.string()).optional(),
  messageRegex: z.string().optional(),
  requestSize: SizeRangeSchema.optional(),
});
export type Conditions = z.infer<typeof ConditionsSchema>;

const UsageSchema = z.object({
  prompt_tokens: z.number().nonnegative(),
  completion_tokens: z.number().nonnegative(),
  total_tokens: z.number().nonnegative().optional(),
});

/** A mocked success body. `message` is static; `messageTemplate` wins and is expanded. */
export const SuccessResponseSchema = z.object({
  message: z.string().optional(),
  messageTemplate: z.string().optional(),
  model: z.string().optional(),
  finishReason: z.string().optional(),
  usage: UsageSchema.optional(),
}).refine(
  (c) => (c.message ?? "") !== "" || (c.messageTemplate ?? "") !== "",
  { message: "success response requires message or messageTemplate" },
);

/** A mocked provider error, surfaced through the gateway's error envelope. */
export const ErrorResponseSchema = z.object({
  message: z.string().min(1),
  type: z.string().optional(),
  code: z.string().optional(),
  statusCode: z.number().int().min(100).max(599).optional(),
});

/** One candidate response; `weight` biases weighted random selection. */
export const MockResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("success"),
    weight: z.number().nonnegative().optional(),
    content: SuccessResponseSchema,
  }),
  z.object({
    type: z.literal("error"),
    weight: z.number().nonnegative().optional(),
    error: ErrorResponseSchema,
  }),
]);
export type MockResponse = z.infer<typeof MockResponseSchema>;

/**
 * A single rule. Rules are evaluated in priority order (higher first; ties keep
 * config order). `probability` gates activation: unset/`>= 1` always fires,
 * `<= 0` never fires, otherwise fires when `rng() < probability`.
 */
export const MockRuleSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  priority: z.number().optional(),
  conditions: ConditionsSchema.optional(),
  responses: z.array(MockResponseSchema).min(1),
  latency: LatencySchema.optional(),
  probability: z.number().min(0).max(1).optional(),
});
export type MockRule = z.infer<typeof MockRuleSchema>;

/**
 * Top-level mocker config. `defaultBehavior` decides what happens when no rule
 * matches: `passthrough` (call the real provider — the default), `success`
 * (return a canned mock), or `error` (inject a generic error).
 */
export const MockerConfigSchema = z.object({
  rules: z.array(MockRuleSchema).optional(),
  globalLatency: LatencySchema.optional(),
  defaultBehavior: z.enum(["passthrough", "error", "success"]).optional(),
});
export type MockerConfig = z.infer<typeof MockerConfigSchema>;

/** Test seams and an optional observability hook. */
export interface MockerOptions {
  /** Random source in [0, 1). Defaults to Math.random. */
  rng?: () => number;
  /** Latency wait. Defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Epoch-ms clock for the response `created` field. Defaults to Date.now. */
  now?: () => number;
  /** Fired whenever a request is mocked (parity with jsonparser's metric sink). */
  onMock?: (info: { rule: string; type: "success" | "error" }) => void;
}

// --- opt-in gate + config source ------------------------------------------

/**
 * Whether request mocking is enabled for this process. OFF by default so the
 * gateway never fabricates responses; an operator opts in with FROSTY_MOCKER=on
 * (also accepts 1/true/yes). Mirrors the boot-time env gating other frosty
 * features use (FROSTY_JSON_REPAIR, FROSTY_PRICING_SYNC, ...).
 */
export function mockerEnabledFromEnv(): boolean {
  const value = (Deno.env.get("FROSTY_MOCKER") ?? "").trim().toLowerCase();
  return value === "on" || value === "1" || value === "true" || value === "yes";
}

/**
 * Loads the mocker config from FROSTY_MOCKER_CONFIG. The value is either inline
 * JSON (when it starts with `{`) or a filesystem path to a JSON file (read with
 * the gateway's existing --allow-read). When unset, returns `{}`; combined with
 * the built-in catch-all rule, `FROSTY_MOCKER=on` alone yields a working mock.
 * Throws on malformed JSON or a config that fails validation, so a bad config
 * fails fast at boot rather than silently disabling mocking.
 */
export function loadMockerConfigFromEnv(): MockerConfig {
  const raw = (Deno.env.get("FROSTY_MOCKER_CONFIG") ?? "").trim();
  if (raw === "") {
    return {};
  }
  const text = raw.startsWith("{") ? raw : Deno.readTextFileSync(raw);
  return MockerConfigSchema.parse(JSON.parse(text));
}

// --- pure helpers (independently testable) --------------------------------

/** Computes a bounded delay in ms: `min` for fixed, `[min, max)` for uniform. */
export function computeLatencyMs(latency: Latency, rng: () => number): number {
  const min = Math.max(0, latency.min);
  if (latency.type === "fixed") {
    return min;
  }
  const max = latency.max ?? min;
  if (max <= min) {
    return min;
  }
  return min + rng() * (max - min);
}

/**
 * Picks an index from normalized cumulative weights via a draw `r` in [0, 1).
 * `weights` is monotonic increasing ending at 1 (see {@link buildCumulativeWeights}).
 */
export function selectResponseIndex(weights: number[], r: number): number {
  for (let i = 0; i < weights.length; i++) {
    if (r <= weights[i]) {
      return i;
    }
  }
  return weights.length - 1;
}

/** Normalized cumulative weights (unset/non-positive weights default to 1). */
function buildCumulativeWeights(responses: MockResponse[]): number[] {
  if (responses.length <= 1) {
    return [1];
  }
  const weights = responses.map((
    r,
  ) => (r.weight && r.weight > 0 ? r.weight : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let cumulative = 0;
  const out = weights.map((w) => {
    cumulative += w / total;
    return cumulative;
  });
  out[out.length - 1] = 1; // guard floating-point drift on the final bucket
  return out;
}

// A small, self-contained faker corpus — no external dependency.
const FIRST_NAMES = [
  "Ada",
  "Ben",
  "Cleo",
  "Dev",
  "Esme",
  "Finn",
  "Gwen",
  "Hugo",
  "Ivy",
  "Jonas",
];
const LAST_NAMES = [
  "Archer",
  "Bloom",
  "Cardenas",
  "Diaz",
  "Everett",
  "Fisher",
  "Gable",
  "Hollis",
  "Ingram",
  "Juno",
];
const EMAIL_DOMAINS = ["example.com", "test.dev", "mock.io", "sample.net"];
const LOREM_WORDS = [
  "lorem",
  "ipsum",
  "dolor",
  "sit",
  "amet",
  "consectetur",
  "adipiscing",
  "elit",
  "sed",
  "eiusmod",
  "tempor",
  "incididunt",
];

function pick<T>(list: T[], rng: () => number): T {
  return list[Math.floor(rng() * list.length)];
}

function uuidV4(rng: () => number): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += "-";
    } else if (i === 14) {
      out += "4"; // version
    } else if (i === 19) {
      out += hex[(Math.floor(rng() * 16) & 0x3) | 0x8]; // variant
    } else {
      out += hex[Math.floor(rng() * 16)];
    }
  }
  return out;
}

function fakerValue(
  method: string,
  arg: string | undefined,
  rng: () => number,
): string {
  switch (method) {
    case "name":
      return `${pick(FIRST_NAMES, rng)} ${pick(LAST_NAMES, rng)}`;
    case "first_name":
      return pick(FIRST_NAMES, rng);
    case "last_name":
      return pick(LAST_NAMES, rng);
    case "email":
      return `${pick(FIRST_NAMES, rng).toLowerCase()}.${
        pick(LAST_NAMES, rng).toLowerCase()
      }@${pick(EMAIL_DOMAINS, rng)}`;
    case "uuid":
      return uuidV4(rng);
    case "number":
    case "integer": {
      let min = 1;
      let max = 100;
      if (arg) {
        const parts = arg.split(",").map((s) => parseInt(s.trim(), 10));
        if (
          parts.length >= 2 && Number.isFinite(parts[0]) &&
          Number.isFinite(parts[1])
        ) {
          [min, max] = parts;
        } else if (parts.length === 1 && Number.isFinite(parts[0])) {
          max = parts[0];
        }
      }
      if (max < min) {
        [min, max] = [max, min];
      }
      return String(min + Math.floor(rng() * (max - min + 1)));
    }
    case "word":
      return pick(LOREM_WORDS, rng);
    case "lorem": {
      let count = 8;
      if (arg) {
        const n = parseInt(arg.trim(), 10);
        if (Number.isFinite(n) && n > 0) {
          count = n;
        }
      }
      const words: string[] = [];
      for (let i = 0; i < count; i++) {
        words.push(pick(LOREM_WORDS, rng));
      }
      return words.join(" ");
    }
    default:
      // Unknown method: leave the placeholder untouched (Go parity).
      return `{{faker.${arg === undefined ? method : `${method}:${arg}`}}}`;
  }
}

/**
 * Expands `{{provider}}`, `{{model}}`, and `{{faker.<method>[:arg]}}` tokens.
 * Supported faker methods: name, first_name, last_name, email, uuid,
 * number/integer (`:min,max`), word, lorem (`:count`). Unknown methods are
 * preserved verbatim.
 */
export function expandTemplate(
  template: string,
  ctx: { provider?: string; model?: string },
  rng: () => number,
): string {
  const withVars = template
    .replaceAll("{{provider}}", ctx.provider ?? "")
    .replaceAll("{{model}}", ctx.model ?? "");
  return withVars.replace(
    /\{\{faker\.([a-z_]+)(?::([^}]*))?\}\}/gi,
    (_match, method: string, arg: string | undefined) =>
      fakerValue(method.toLowerCase(), arg, rng),
  );
}

// --- request inspection ----------------------------------------------------

function parseModel(model: string): { provider?: string; model: string } {
  const slash = model.indexOf("/");
  if (slash > 0) {
    return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
  }
  return { model };
}

/** Concatenates text from string content and `{type:"text"}` blocks. */
function extractText(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const content = m.content;
    if (typeof content === "string") {
      if (content) {
        parts.push(content);
      }
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (
          part && typeof part === "object" &&
          (part as { type?: unknown }).type === "text"
        ) {
          const text = (part as { text?: unknown }).text;
          if (typeof text === "string") {
            parts.push(text);
          }
        }
      }
    }
  }
  return parts.join(" ");
}

/** Approximate serialized request size (JSON characters). */
function requestSize(req: ChatCompletionRequest): number {
  try {
    return JSON.stringify(req).length;
  } catch {
    return 0;
  }
}

// --- compiled rules --------------------------------------------------------

interface CompiledRule {
  name: string;
  enabled: boolean;
  priority: number;
  index: number;
  conditions?: Conditions;
  regex?: RegExp;
  responses: MockResponse[];
  cumulativeWeights: number[];
  latency?: Latency;
  probability?: number;
}

const DEFAULT_CATCHALL_RULE: MockRule = {
  name: "default-mock",
  responses: [{
    type: "success",
    content: { message: "This is a mock response from the Mocker plugin" },
  }],
};

function compileRule(rule: MockRule, index: number): CompiledRule {
  let regex: RegExp | undefined;
  if (rule.conditions?.messageRegex) {
    // An invalid pattern throws here (at plugin construction / boot), matching
    // the Go plugin's compile-time validation.
    regex = new RegExp(rule.conditions.messageRegex);
  }
  return {
    name: rule.name,
    enabled: rule.enabled ?? true,
    priority: rule.priority ?? 0,
    index,
    conditions: rule.conditions,
    regex,
    responses: rule.responses,
    cumulativeWeights: buildCumulativeWeights(rule.responses),
    latency: rule.latency,
    probability: rule.probability,
  };
}

function matches(
  rule: CompiledRule,
  req: ChatCompletionRequest,
  parsed: { provider?: string; model: string },
): boolean {
  const c = rule.conditions;
  if (!c) {
    return true;
  }
  if (c.providers && c.providers.length > 0) {
    if (!parsed.provider || !c.providers.includes(parsed.provider)) {
      return false;
    }
  }
  if (c.models && c.models.length > 0) {
    if (!c.models.includes(req.model) && !c.models.includes(parsed.model)) {
      return false;
    }
  }
  if (rule.regex && !rule.regex.test(extractText(req.messages))) {
    return false;
  }
  if (c.requestSize) {
    const size = requestSize(req);
    if (c.requestSize.min !== undefined && size < c.requestSize.min) {
      return false;
    }
    if (c.requestSize.max !== undefined && size > c.requestSize.max) {
      return false;
    }
  }
  return true;
}

/** Unset/`>= 1` always activates; `<= 0` never; otherwise `rng() < probability`. */
function shouldActivate(
  probability: number | undefined,
  rng: () => number,
): boolean {
  if (probability === undefined || probability >= 1) {
    return true;
  }
  if (probability <= 0) {
    return false;
  }
  return rng() < probability;
}

function selectResponse(rule: CompiledRule, rng: () => number): MockResponse {
  if (rule.responses.length === 1) {
    return rule.responses[0];
  }
  return rule.responses[selectResponseIndex(rule.cumulativeWeights, rng())];
}

function toGatewayError(
  error: z.infer<typeof ErrorResponseSchema>,
): GatewayError {
  return new GatewayError(
    error.statusCode ?? 500,
    error.message,
    error.type ?? "mock_error",
    undefined,
    error.code,
  );
}

function buildSuccess(
  content: z.infer<typeof SuccessResponseSchema>,
  req: ChatCompletionRequest,
  parsed: { provider?: string; model: string },
  now: () => number,
  rng: () => number,
): ChatCompletionResponse {
  const text = content.messageTemplate
    ? expandTemplate(
      content.messageTemplate,
      { provider: parsed.provider, model: req.model },
      rng,
    )
    : (content.message ?? "");
  const usage = content.usage
    ? {
      prompt_tokens: content.usage.prompt_tokens,
      completion_tokens: content.usage.completion_tokens,
      total_tokens: content.usage.total_tokens ??
        content.usage.prompt_tokens + content.usage.completion_tokens,
    }
    : { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
  let id = "chatcmpl-mock-";
  for (let i = 0; i < 8; i++) {
    id += Math.floor(rng() * 16).toString(16);
  }
  return {
    id,
    object: "chat.completion",
    created: Math.floor(now() / 1000),
    model: content.model ?? req.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: content.finishReason ?? "stop",
    }],
    usage,
  };
}

// --- plugin ----------------------------------------------------------------

/**
 * Builds the mocker plugin. Registered only behind the FROSTY_MOCKER opt-in
 * (see the proposed context.ts wiring), so a default gateway is unaffected.
 * When constructed with no rules, a built-in catch-all success rule applies, so
 * `FROSTY_MOCKER=on` alone produces mocks. Only NON-streaming chat requests are
 * mocked; streaming requests pass through to the real provider unchanged.
 */
export function mockerPlugin(
  config: MockerConfig = {},
  options: MockerOptions = {},
): Plugin {
  const parsed = MockerConfigSchema.parse(config);
  const rng = options.rng ?? Math.random;
  const sleep = options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const defaultBehavior = parsed.defaultBehavior ?? "passthrough";
  const globalLatency = parsed.globalLatency;

  const source = parsed.rules && parsed.rules.length > 0
    ? parsed.rules
    : [DEFAULT_CATCHALL_RULE];
  const compiled = source
    .map((rule, index) => compileRule(rule, index))
    .sort((a, b) => b.priority - a.priority || a.index - b.index);

  async function handle(
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse | undefined> {
    // Streaming responses have a different wire shape; leave them to the real
    // provider. Non-streaming mocking covers offline dev / demo / load testing.
    if (req.stream) {
      return undefined;
    }

    const parsedModel = parseModel(req.model);
    for (const rule of compiled) {
      if (!rule.enabled || !matches(rule, req, parsedModel)) {
        continue;
      }
      // First matching rule wins. If its probability gate fails, the request
      // passes through to the real provider (Go parity) — no further rules.
      if (!shouldActivate(rule.probability, rng)) {
        return undefined;
      }
      const latency = rule.latency ?? globalLatency;
      if (latency) {
        const delay = computeLatencyMs(latency, rng);
        if (delay > 0) {
          await sleep(delay);
        }
      }
      const response = selectResponse(rule, rng);
      if (response.type === "error") {
        options.onMock?.({ rule: rule.name, type: "error" });
        throw toGatewayError(response.error);
      }
      options.onMock?.({ rule: rule.name, type: "success" });
      return buildSuccess(response.content, req, parsedModel, now, rng);
    }

    // No rule matched: apply the configured default behavior.
    if (defaultBehavior === "error") {
      options.onMock?.({ rule: "(default)", type: "error" });
      throw new GatewayError(500, "Mock plugin default error", "mock_error");
    }
    if (defaultBehavior === "success") {
      options.onMock?.({ rule: "(default)", type: "success" });
      return buildSuccess(
        {
          message: "Mock plugin default response",
          usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
        },
        req,
        parsedModel,
        now,
        rng,
      );
    }
    return undefined; // passthrough
  }

  return {
    name: "mocker",
    onRequestShortCircuit: (req) => handle(req),
  };
}
