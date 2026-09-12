import type {
  ChatCompletionResponse,
  Message,
} from "../../contracts/src/mod.ts";
import type { ReconstructedMessage } from "../../core/src/accumulate.ts";
import { InMemoryVectorStore, type VectorStore } from "./vector.ts";
import { type CachedEntry, type CacheStore, digestKey } from "./store.ts";

export { cosineSimilarity } from "./vector.ts";
export type { VectorMatch, VectorStore } from "./vector.ts";
export type { CachedEntry, CacheStore } from "./store.ts";
export type { ReconstructedMessage } from "../../core/src/accumulate.ts";

export interface CacheEntry {
  response: ChatCompletionResponse;
  storedAt: number;
  /** Request that created this entry; retained for targeted invalidation. */
  requestId?: string;
}

interface VectorPayload {
  response: ChatCompletionResponse;
  storedAt: number;
  requestId?: string;
  /**
   * Cache namespace this entry was stored under, mirroring the `scopeKey`
   * folded into the exact key. Vector search ignores the exact key, so the
   * namespace has to travel with the payload to be re-checked on read.
   */
  scopeKey?: string;
}

/**
 * Opt-in knobs that change how the cache key is derived. Every field is
 * OPTIONAL and defaults to today's behavior, so an unset (or empty) config
 * yields a byte-identical key to the historical `{model, messages,
 * temperature, top_p, max_tokens, tools}` shape. Field names mirror the
 * /api/settings `caching` group so a later wiring pass can feed operator
 * settings straight in.
 */
export interface CacheKeyConfig {
  /**
   * Include the resolved provider id (read from `request.provider`) in the
   * key so identical prompts routed to different providers never collide.
   * Default/unset: provider is absent from the key (unchanged).
   */
  cacheByProvider?: boolean;
  /**
   * Whether the model is part of the key. Frosty has always keyed on model,
   * so this is treated as ON unless it is EXPLICITLY `false`: `undefined`
   * (unset) and `true` both keep the model in the key (unchanged). Passing
   * `false` drops it — the only value that alters the historical key.
   */
  cacheByModel?: boolean;
  /**
   * Omit `system`-role messages from the key-generation input (both the exact
   * key and the embedding text). Default/unset: system messages are kept
   * (unchanged).
   */
  excludeSystemPrompt?: boolean;
}

/** Structured cache-lookup classification surfaced for cache-debug. */
export type CacheType = "direct" | "semantic" | "miss";

/**
 * Which tier served a hit. `l1` is this process's own Map; `l2` is the shared
 * store, meaning some OTHER replica computed the response. Additive: the
 * `cache_type` classification and the `x-frosty-cache-type` header it feeds are
 * unchanged, so nothing downstream has to learn about tiers to keep working.
 */
export type CacheTier = "l1" | "l2";

/**
 * Structured cache-debug for one lookup. Mirrors the Bifrost semantic-cache
 * debug object so a caller can surface it (e.g. richer `x-frosty-cache-*`
 * headers) on top of the existing `x-frosty-cache: hit|miss`.
 */
export interface CacheDebug {
  /** "direct" = exact-key hit, "semantic" = vector hit, "miss" = no hit. */
  cache_type: CacheType;
  /** Configured cosine cutoff for a semantic hit. Always present. */
  threshold: number;
  /** Cosine score of the served match; present only for `cache_type: "semantic"`. */
  similarity?: number;
  /** total_tokens of the served response, when it carries a usage block. */
  tokens?: number;
  /** Which tier served the hit. Absent on a miss and when no L2 is attached. */
  tier?: CacheTier;
}

/** Result of {@link SemanticCache.getWithDebug}: the response plus cache-debug. */
export interface CacheLookupResult {
  response: ChatCompletionResponse | null;
  debug: CacheDebug;
}

export interface SemanticCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  /**
   * Optional embedder enabling vector similarity lookups. Without it the
   * cache is exact-match only.
   */
  embedder?: (text: string) => Promise<number[]>;
  /** Cosine similarity threshold for a vector hit. */
  similarityThreshold?: number;
  /**
   * Where similarity vectors live. Defaults to an in-process store; pass a
   * PgVectorStore (or any VectorStore) to externalize them. The Redis adapter
   * was removed in decision-log 60; pgvector is the only shipped backend.
   */
  vectorStore?: VectorStore;
  /**
   * Shared L2 tier. Without it the cache is process-local and its hit rate
   * divides by the replica count; with it, one replica's completion serves
   * every replica. The in-process L1 stays in front either way - see
   * cache/src/store.ts for why L2 does not replace it.
   */
  cacheStore?: CacheStore;
  /** See {@link CacheKeyConfig.cacheByProvider}. */
  cacheByProvider?: boolean;
  /** See {@link CacheKeyConfig.cacheByModel}. */
  cacheByModel?: boolean;
  /** See {@link CacheKeyConfig.excludeSystemPrompt}. */
  excludeSystemPrompt?: boolean;
  /**
   * Skip caching (both read and write) for conversations with MORE than this
   * many messages — a guard against false-positive hits on long threads.
   * Default/unset (or <= 0): no limit, every conversation is cacheable
   * (unchanged).
   */
  conversationHistoryThreshold?: number;
}

/** total_tokens of a response, when it carries a usage block. */
function responseTokens(response: ChatCompletionResponse): number | undefined {
  return response.usage?.total_tokens;
}

/**
 * Response cache for non-streaming chat: exact-match on the normalized
 * request (in-process, LRU + TTL), plus optional embedding-based similarity
 * matching delegated to a pluggable VectorStore.
 *
 * All key-derivation knobs ({@link CacheKeyConfig}) and the conversation
 * threshold are additive and default to today's behavior, so a cache built
 * with no new options produces byte-identical keys and hit/miss results.
 */
export class SemanticCache {
  private entries = new Map<string, CacheEntry>();
  private ttlMs: number;
  private maxEntries: number;
  private embedder?: (text: string) => Promise<number[]>;
  private similarityThreshold: number;
  private vectorStore?: VectorStore;
  /** Shared L2 tier; absent => process-local cache (historical behavior). */
  private cacheStore?: CacheStore;
  /** Key-derivation knobs; empty by default => historical key shape. */
  private keyConfig: CacheKeyConfig;
  /** > 0 enables the long-conversation skip guard; 0/undefined disables it. */
  private conversationHistoryThreshold: number;

  constructor(options: SemanticCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.maxEntries = options.maxEntries ?? 500;
    this.embedder = options.embedder;
    this.similarityThreshold = options.similarityThreshold ?? 0.95;
    this.vectorStore = options.vectorStore ??
      (options.embedder
        ? new InMemoryVectorStore(options.maxEntries ?? 500)
        : undefined);
    this.cacheStore = options.cacheStore;
    this.keyConfig = {
      cacheByProvider: options.cacheByProvider,
      cacheByModel: options.cacheByModel,
      excludeSystemPrompt: options.excludeSystemPrompt,
    };
    this.conversationHistoryThreshold =
      options.conversationHistoryThreshold !== undefined &&
        Number.isFinite(options.conversationHistoryThreshold) &&
        options.conversationHistoryThreshold > 0
        ? options.conversationHistoryThreshold
        : 0;
  }

  /**
   * Live-tunable knobs applied by the operator settings API (PUT
   * /api/settings, caching group). Purely additive: only the provided fields
   * are changed, and out-of-range values are ignored so a bad override can
   * never wedge the cache that fronts inference. ttlMs is milliseconds;
   * similarityThreshold is the cosine cutoff in [0, 1]. The key-derivation
   * knobs and conversation threshold may also be pushed here; note that
   * changing a key-affecting knob invalidates existing exact-match entries
   * (their keys change), which is the intended effect of retuning the cache.
   */
  configure(
    options: {
      ttlMs?: number;
      similarityThreshold?: number;
      cacheByProvider?: boolean;
      cacheByModel?: boolean;
      excludeSystemPrompt?: boolean;
      conversationHistoryThreshold?: number;
    },
  ): void {
    if (
      options.ttlMs !== undefined && Number.isFinite(options.ttlMs) &&
      options.ttlMs > 0
    ) {
      this.ttlMs = options.ttlMs;
    }
    if (
      options.similarityThreshold !== undefined &&
      Number.isFinite(options.similarityThreshold) &&
      options.similarityThreshold >= 0 && options.similarityThreshold <= 1
    ) {
      this.similarityThreshold = options.similarityThreshold;
    }
    if (options.cacheByProvider !== undefined) {
      this.keyConfig.cacheByProvider = options.cacheByProvider;
    }
    if (options.cacheByModel !== undefined) {
      this.keyConfig.cacheByModel = options.cacheByModel;
    }
    if (options.excludeSystemPrompt !== undefined) {
      this.keyConfig.excludeSystemPrompt = options.excludeSystemPrompt;
    }
    if (
      options.conversationHistoryThreshold !== undefined &&
      Number.isFinite(options.conversationHistoryThreshold) &&
      options.conversationHistoryThreshold >= 0
    ) {
      this.conversationHistoryThreshold =
        options.conversationHistoryThreshold > 0
          ? options.conversationHistoryThreshold
          : 0;
    }
  }

  /** Drop `system`-role entries from a messages array (any other shape passes through). */
  static #withoutSystem(messages: unknown): unknown {
    if (!Array.isArray(messages)) {
      return messages;
    }
    return messages.filter((m) =>
      !(m !== null && typeof m === "object" &&
        (m as { role?: unknown }).role === "system")
    );
  }

  /**
   * Stable key over the fields that determine the completion. With no config
   * (the default) the output is byte-identical to the historical key:
   * `{model, messages, temperature, top_p, max_tokens, tools}`. Optional knobs
   * only ever ADD or REMOVE fields when explicitly enabled — an omitted
   * (undefined) field is dropped by JSON.stringify, so default-off produces the
   * exact prior string. The inline params (temperature/top_p/max_tokens/tools)
   * are frosty's equivalent of Bifrost's `params_hash`: distinct params never
   * share an entry.
   *
   * `scopeKey` namespaces the entry for a caller whose dispatch is restricted
   * to a provider/model allowlist. The cache read runs BEFORE the dispatch
   * scope filter, so without a namespace a scoped caller could be served an
   * entry produced outside its allowlist. Unscoped and keyless traffic passes
   * `undefined`, which JSON.stringify drops - the historical key exactly.
   */
  static keyFor(
    request: Record<string, unknown>,
    config: CacheKeyConfig = {},
    scopeKey?: string,
  ): string {
    const messages = config.excludeSystemPrompt
      ? SemanticCache.#withoutSystem(request.messages)
      : request.messages;
    const routingPrefs = request.provider !== null &&
      typeof request.provider === "object";
    return JSON.stringify({
      model: config.cacheByModel === false ? undefined : request.model,
      messages,
      temperature: request.temperature,
      top_p: request.top_p,
      max_tokens: request.max_tokens,
      tools: request.tools,
      response_format: request.response_format,
      seed: request.seed,
      stop: request.stop,
      n: request.n,
      frequency_penalty: request.frequency_penalty,
      presence_penalty: request.presence_penalty,
      logit_bias: request.logit_bias,
      // Dialect fields the vendor surfaces now carry through to egress. All
      // optional: JSON.stringify drops `undefined`, so traffic that omits them
      // keeps its historical key.
      top_k: request.top_k,
      thinking: request.thinking,
      transforms: request.transforms,
      route: request.route,
      reasoning: request.reasoning,
      safetySettings: request.safetySettings,
      thinkingConfig: request.thinkingConfig,
      // A string `provider` is the resolved provider id and stays behind
      // cacheByProvider (off => omitted, historical key unchanged). OpenRouter
      // sends an OBJECT of routing preferences that changes the completion, so
      // that shape is always keyed.
      provider: config.cacheByProvider || routingPrefs
        ? request.provider
        : undefined,
      scope: scopeKey,
    });
  }

  static promptText(
    request: Record<string, unknown>,
    config: CacheKeyConfig = {},
  ): string {
    const raw = request.messages as
      | Array<{ role?: string; content?: unknown }>
      | undefined;
    const messages = config.excludeSystemPrompt
      ? (raw ?? []).filter((m) => m?.role !== "system")
      : (raw ?? []);
    return messages
      .map((m) => SemanticCache.#contentToText(m.content))
      .join("\n");
  }

  /**
   * Flattens message content to embedding text. Non-string content (multimodal
   * parts, tool results) is serialized structurally instead of collapsing to ""
   * — otherwise two different image-only prompts both embed as `embedder("")`,
   * score cosine≈1.0, and one is served the other's cached response.
   */
  static #contentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (content == null) return "";
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          const text = (part as { text?: unknown } | null)?.text;
          return typeof text === "string" ? text : JSON.stringify(part);
        })
        .join(" ");
    }
    return JSON.stringify(content);
  }

  /**
   * Builds a canonical non-streaming {@link ChatCompletionResponse} from a
   * {@link ReconstructedMessage} (the StreamAccumulator's full projection of a
   * streamed turn). This is the bridge that lets a streamed response be cached
   * and later served to an identical request as an ordinary completion. Pure
   * and reusable; storing is done by {@link SemanticCache.setStreamed}.
   */
  static responseFromReconstructed(
    request: Record<string, unknown>,
    reconstructed: ReconstructedMessage,
  ): ChatCompletionResponse {
    // Non-standard-but-lossless fields (refusal/reasoning) are preserved so the
    // served response faithfully reproduces the streamed turn; the base object
    // is cast once to Message since the contract type omits those extras.
    const message: Record<string, unknown> = {
      role: "assistant",
      content: reconstructed.content,
    };
    if (reconstructed.refusal !== undefined) {
      message.refusal = reconstructed.refusal;
    }
    if (reconstructed.reasoning !== undefined) {
      message.reasoning = reconstructed.reasoning;
    }
    if (reconstructed.reasoning_details !== undefined) {
      message.reasoning_details = reconstructed.reasoning_details;
    }
    if (reconstructed.tool_calls !== undefined) {
      // Map streaming tool calls to the non-streaming shape (drop the streaming
      // `index`; keep id/type/function).
      message.tool_calls = reconstructed.tool_calls.map((tc) => ({
        ...(tc.id !== undefined ? { id: tc.id } : {}),
        type: tc.type,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }

    const response: ChatCompletionResponse = {
      id: reconstructed.id ?? `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: reconstructed.created ?? Math.floor(Date.now() / 1000),
      model: reconstructed.model ??
        (typeof request.model === "string" ? request.model : ""),
      choices: [{
        index: 0,
        message: message as Message,
        finish_reason: reconstructed.finish_reason ?? "stop",
      }],
    };
    if (reconstructed.usage !== undefined) {
      response.usage = {
        prompt_tokens: reconstructed.usage.prompt_tokens,
        completion_tokens: reconstructed.usage.completion_tokens,
        total_tokens: reconstructed.usage.total_tokens,
      };
    }
    return response;
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * Drops every exact-match entry (invalidation API) in BOTH tiers. External
   * vector stores are not swept — their entries expire via the TTL check on
   * read.
   *
   * Async because clearing only this process's L1 would be a lie once an L2 is
   * attached: the operator asked for the cache to be empty, and the next
   * request routed to any replica would still be served from the shared tier.
   * Cross-process L1 eviction rides on the invalidation channel — see
   * `packages/cache/src/invalidation.ts`.
   */
  async clear(): Promise<number> {
    const cleared = this.entries.size;
    this.entries.clear();
    if (this.cacheStore) {
      // A failed shared clear still reports the local count rather than
      // throwing: the operator's L1 clear did happen, and an admin endpoint
      // returning 502 would hide that.
      return Math.max(cleared, await this.cacheStore.clear().catch(() => 0));
    }
    return cleared;
  }

  /** Drops this process's L1 only. The handler for a remote invalidation event. */
  clearLocal(): number {
    const cleared = this.entries.size;
    this.entries.clear();
    return cleared;
  }

  /**
   * Invalidates the entry created by one gateway request ID. The ID is also
   * used as the vector-store record ID, so exact and semantic paths are
   * removed together. Hits never replace ownership: only the request that
   * stored a completion can invalidate it by ID.
   */
  async deleteByRequestId(requestId: string): Promise<boolean> {
    let deleted = false;
    for (const [key, entry] of this.entries) {
      if (entry.requestId === requestId) {
        this.entries.delete(key);
        deleted = true;
      }
    }
    if (this.cacheStore) {
      deleted = (await this.cacheStore.deleteByRequestId(requestId)
        .catch(() => false)) || deleted;
    }
    if (this.vectorStore) {
      // Vector stores are part of semantic-cache correctness here. Surface a
      // deletion failure instead of reporting a successful clear while a
      // semantic lookup could still serve the entry.
      deleted = (await this.vectorStore.delete(requestId)) || deleted;
    }
    return deleted;
  }

  /**
   * Invalidates the exact-match entry for one normalized request, in both
   * tiers. Async for the same reason as {@link SemanticCache.clear}.
   *
   * Targets the unscoped namespace only. An entry stored by a scope-restricted
   * caller is reachable through {@link SemanticCache.deleteByRequestId} (which
   * matches on the stored request id, not the key) or {@link SemanticCache.clear}.
   */
  async deleteEntry(request: Record<string, unknown>): Promise<boolean> {
    const key = SemanticCache.keyFor(request, this.keyConfig);
    let deleted = this.entries.delete(key);
    if (this.cacheStore) {
      deleted = (await this.cacheStore.delete(await digestKey(key))
        .catch(() => false)) || deleted;
    }
    return deleted;
  }

  /** Drops one key from this process's L1 only. Remote-invalidation handler. */
  deleteEntryLocal(request: Record<string, unknown>): boolean {
    return this.entries.delete(SemanticCache.keyFor(request, this.keyConfig));
  }

  /**
   * True when the conversation is longer than the configured threshold, so the
   * cache should be bypassed entirely (read and write). Always false when the
   * threshold is disabled (0/unset), preserving today's cache-everything path.
   */
  #cachingDisabledFor(request: Record<string, unknown>): boolean {
    if (this.conversationHistoryThreshold <= 0) {
      return false;
    }
    const messages = request.messages;
    const count = Array.isArray(messages) ? messages.length : 0;
    return count > this.conversationHistoryThreshold;
  }

  private evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.storedAt > this.ttlMs) {
        this.entries.delete(key);
      }
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  async get(
    request: Record<string, unknown>,
    scopeKey?: string,
  ): Promise<ChatCompletionResponse | null> {
    return (await this.getWithDebug(request, scopeKey)).response;
  }

  /**
   * Like {@link SemanticCache.get} but also returns structured cache-debug
   * ({@link CacheDebug}) so a caller can surface the cache_type/similarity/
   * tokens. `get()` is a thin wrapper over this, so hit/miss behavior is
   * identical.
   *
   * `scopeKey` must be the same value the matching {@link SemanticCache.set} /
   * {@link SemanticCache.setStreamed} passed, or the entry is unreachable. See
   * {@link SemanticCache.keyFor}.
   */
  async getWithDebug(
    request: Record<string, unknown>,
    scopeKey?: string,
  ): Promise<CacheLookupResult> {
    const threshold = this.similarityThreshold;
    if (this.#cachingDisabledFor(request)) {
      return { response: null, debug: { cache_type: "miss", threshold } };
    }
    this.evict();
    const key = SemanticCache.keyFor(request, this.keyConfig, scopeKey);
    const exact = this.entries.get(key);
    if (exact) {
      // refresh LRU position
      this.entries.delete(key);
      this.entries.set(key, exact);
      return {
        response: exact.response,
        debug: this.#hitDebug("direct", exact.response, undefined, "l1"),
      };
    }

    // L1 missed. Ask the shared tier before doing anything expensive: another
    // replica may already have computed this exact request.
    if (this.cacheStore) {
      const shared = await this.#getShared(key);
      if (shared) {
        // Promote into L1 so the next hit on this process costs a Map lookup
        // instead of another round trip.
        this.entries.set(key, shared);
        this.evict();
        return {
          response: shared.response,
          debug: this.#hitDebug("direct", shared.response, undefined, "l2"),
        };
      }
    }

    if (!this.embedder || !this.vectorStore) {
      return { response: null, debug: { cache_type: "miss", threshold } };
    }
    // A cache layer must never fail the request it fronts: any embedder or
    // store outage degrades to a miss, not an error.
    try {
      const vector = await this.embedder(
        SemanticCache.promptText(request, this.keyConfig),
      );
      // Expired vectors are never deleted (TTL is enforced on read), so an
      // expired top-1 must not shadow a fresh near-identical sibling — scan
      // a handful of candidates for the first live one.
      const matches = await this.vectorStore.search(vector, {
        threshold: this.similarityThreshold,
        limit: 5,
      });
      const now = Date.now();
      for (const match of matches) {
        const payload = match.payload as VectorPayload | undefined;
        // Vectors are searched across the whole store, so the namespace is
        // re-checked here: a similar embedding is not evidence of a shared
        // dispatch allowlist.
        if (
          payload && payload.scopeKey === scopeKey &&
          now - payload.storedAt <= this.ttlMs
        ) {
          return {
            response: payload.response,
            debug: this.#hitDebug("semantic", payload.response, match.score),
          };
        }
      }
      return { response: null, debug: { cache_type: "miss", threshold } };
    } catch (error) {
      console.warn(
        `semantic cache lookup degraded to miss: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return { response: null, debug: { cache_type: "miss", threshold } };
    }
  }

  /**
   * Reads the shared tier and applies the SAME TTL the in-process tier uses.
   * The L2 row carries its own `expires_at`, but the operator can retune
   * `ttlMs` at runtime through PUT /api/settings; re-checking here means a
   * shortened TTL takes effect immediately instead of waiting for rows written
   * under the old one to age out.
   *
   * Never throws: a broken L2 is a cache miss, not a failed request.
   */
  async #getShared(key: string): Promise<CachedEntry | null> {
    try {
      const entry = await this.cacheStore!.get(await digestKey(key));
      if (!entry) {
        return null;
      }
      return Date.now() - entry.storedAt <= this.ttlMs ? entry : null;
    } catch (error) {
      console.warn(
        `shared cache lookup degraded to miss: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return null;
    }
  }

  /** Assemble the cache-debug for a hit, folding in tokens/similarity when present. */
  #hitDebug(
    cache_type: "direct" | "semantic",
    response: ChatCompletionResponse,
    similarity?: number,
    tier?: CacheTier,
  ): CacheDebug {
    const debug: CacheDebug = {
      cache_type,
      threshold: this.similarityThreshold,
    };
    if (similarity !== undefined) {
      debug.similarity = similarity;
    }
    // Only reported when a shared tier actually exists. A single-process
    // deployment therefore produces a byte-identical debug object to the one it
    // produced before two-tier caching was added.
    if (tier !== undefined && this.cacheStore) {
      debug.tier = tier;
    }
    const tokens = responseTokens(response);
    if (tokens !== undefined) {
      debug.tokens = tokens;
    }
    return debug;
  }

  /** `scopeKey` namespaces the entry - see {@link SemanticCache.keyFor}. */
  async set(
    request: Record<string, unknown>,
    response: ChatCompletionResponse,
    requestId?: string,
    scopeKey?: string,
  ): Promise<void> {
    if (this.#cachingDisabledFor(request)) {
      return;
    }
    await this.#store(request, response, requestId, scopeKey);
  }

  /**
   * Streaming-response caching: store the reconstructed full message (from the
   * StreamAccumulator's {@link ReconstructedMessage}) as a normal completion so
   * a later identical request is served from cache via {@link get}/
   * {@link getWithDebug}. Returns the built response even when the conversation
   * threshold skips storing, so the caller can still use it. The stream-path
   * wiring (inference.ts is off-limits) is the documented follow-up; this makes
   * the cache ready to accept a reconstructed message.
   */
  async setStreamed(
    request: Record<string, unknown>,
    reconstructed: ReconstructedMessage,
    requestId?: string,
    scopeKey?: string,
  ): Promise<ChatCompletionResponse> {
    const response = SemanticCache.responseFromReconstructed(
      request,
      reconstructed,
    );
    if (!this.#cachingDisabledFor(request)) {
      await this.#store(request, response, requestId, scopeKey);
    }
    return response;
  }

  /** Shared exact + vector write path for {@link set} and {@link setStreamed}. */
  async #store(
    request: Record<string, unknown>,
    response: ChatCompletionResponse,
    requestId?: string,
    scopeKey?: string,
  ): Promise<void> {
    const storedAt = Date.now();
    const key = SemanticCache.keyFor(request, this.keyConfig, scopeKey);
    this.entries.set(key, { response, storedAt, requestId });
    if (this.cacheStore) {
      try {
        await this.cacheStore.set(
          await digestKey(key),
          { response, storedAt, requestId },
          this.ttlMs,
        );
      } catch (error) {
        console.warn(
          `shared cache store skipped: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
    if (this.embedder && this.vectorStore) {
      // Same fail-open contract as get(): a successfully generated
      // completion must never be discarded because the cache store errored.
      try {
        const vector = await this.embedder(
          SemanticCache.promptText(request, this.keyConfig),
        );
        // The namespace is only added when there is one, so an unscoped
        // payload serializes exactly as it did before scoping existed.
        const payload: VectorPayload = { response, storedAt, requestId };
        if (scopeKey !== undefined) {
          payload.scopeKey = scopeKey;
        }
        await this.vectorStore.upsert(
          requestId ?? crypto.randomUUID(),
          vector,
          payload,
        );
      } catch (error) {
        console.warn(
          `semantic cache store skipped: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
    this.evict();
  }
}
