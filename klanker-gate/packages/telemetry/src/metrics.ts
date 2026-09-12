const MAX_ROUTE_LABELS = 200;
const STREAM_LATENCY_BUCKETS_MS = [
  10,
  25,
  50,
  100,
  250,
  500,
  1_000,
  2_500,
  5_000,
  10_000,
  30_000,
  60_000,
];

/** Escapes a Prometheus label value: backslash, double-quote, and newline. */
function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

interface LlmBucket {
  provider: string;
  model: string;
  virtualKey?: string;
  team?: string;
  customer?: string;
  input: number;
  output: number;
  costMicro: number;
}

interface LlmRequestBucket {
  provider: string;
  model: string;
  statusClass: string;
  virtualKey?: string;
  team?: string;
  customer?: string;
  count: number;
}

interface Histogram {
  buckets: number[];
  counts: number[];
  count: number;
  sum: number;
}

export interface LlmUsageSample {
  provider: string;
  model: string;
  /** "2xx" | "3xx" | "4xx" | "5xx". */
  statusClass: string;
  promptTokens: number;
  completionTokens: number;
  costMicroUsd: number | null;
  /**
   * Optional per-tenant attribution (ids). Absent for zero-virtual-key traffic,
   * which keeps its series free of tenant labels. `virtualKey` is bounded to the
   * known-key allowlist below; `team`/`customer` are already bounded operator
   * sets, so they pass through as-is.
   */
  virtualKey?: string;
  team?: string;
  customer?: string;
}

/** Renders the optional tenant labels, in a fixed order, only when present so an
 * un-tenanted series stays byte-identical to the pre-tenant exposition. */
function tenantLabelSuffix(
  b: { virtualKey?: string; team?: string; customer?: string },
): string {
  let suffix = "";
  if (b.virtualKey) {
    suffix += `,virtual_key="${escapeLabel(b.virtualKey)}"`;
  }
  if (b.team) {
    suffix += `,team="${escapeLabel(b.team)}"`;
  }
  if (b.customer) {
    suffix += `,customer="${escapeLabel(b.customer)}"`;
  }
  return suffix;
}

export class Metrics {
  private counters = new Map<string, number>();
  private latencies = new Map<string, number[]>();
  private routeLabels = new Set<string>();

  // Labelled LLM series (provider + bounded model). Components are stored in
  // the bucket value so rendering never has to split a composite key; keys are
  // JSON tuples so distinct label sets never collide.
  private llm = new Map<string, LlmBucket>();
  private llmRequests = new Map<string, LlmRequestBucket>();
  private cacheEvents = new Map<string, number>();
  // Cardinality guard: only these model values (plus "other") ever become a
  // metric label, so unauthenticated callers cannot explode the label space
  // with arbitrary model strings.
  private knownModels = new Set<string>();
  // Same guard for the virtual_key label: only ids the governance store knows
  // (plus "other") become a label. Kept in sync from the virtual-key CRUD routes
  // (seeded at boot); an absent set means no keys are configured -> no vk labels.
  private knownVirtualKeys = new Set<string>();
  private streamFirstTokenLatency = Metrics.newHistogram();
  private streamInterTokenLatency = Metrics.newHistogram();

  private static newHistogram(): Histogram {
    return {
      buckets: STREAM_LATENCY_BUCKETS_MS,
      counts: new Array(STREAM_LATENCY_BUCKETS_MS.length).fill(0),
      count: 0,
      sum: 0,
    };
  }

  increment(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  get(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  /** Bounds the `model` label to this allowlist (typically the pricing keys). */
  setKnownModels(models: Iterable<string>): void {
    this.knownModels = new Set(models);
  }

  /** Bounds the `virtual_key` label to this allowlist (the governance store's
   * key ids). Unknown/absent ids never mint a label (see recordLlmUsage). */
  setKnownVirtualKeys(ids: Iterable<string>): void {
    this.knownVirtualKeys = new Set(ids);
  }

  /** Records a request observation for the metrics endpoint. */
  observe(route: string, status: number, durationMs: number): void {
    // Bound route-label cardinality: once the ceiling of distinct routes is hit,
    // fold new paths to "other" so a path-spray cannot grow the maps or /metrics
    // without bound (mirrors the model-label guard).
    if (
      !this.routeLabels.has(route) && this.routeLabels.size >= MAX_ROUTE_LABELS
    ) {
      route = "other";
    }
    this.routeLabels.add(route);
    this.increment(`http.${route}.${status}`);
    const bucket = this.latencies.get(route) ?? [];
    bucket.push(durationMs);
    if (bucket.length > 1000) {
      bucket.splice(0, bucket.length - 1000);
    }
    this.latencies.set(route, bucket);
  }

  /**
   * Records one LLM inference observation as labelled counters. `provider` is
   * already bounded (adapter set); `model` is collapsed to "other" unless it is
   * a known catalog key, keeping cardinality bounded against hostile input.
   */
  recordLlmUsage(sample: LlmUsageSample): void {
    const provider = sample.provider || "unknown";
    const model = sample.model === "other" || this.knownModels.has(sample.model)
      ? sample.model
      : "other";

    const virtualKey = sample.virtualKey
      ? (this.knownVirtualKeys.has(sample.virtualKey)
        ? sample.virtualKey
        : "other")
      : undefined;
    const team = sample.team || undefined;
    const customer = sample.customer || undefined;

    const key = JSON.stringify([
      provider,
      model,
      virtualKey ?? "",
      team ?? "",
      customer ?? "",
    ]);
    const bucket = this.llm.get(key) ??
      {
        provider,
        model,
        virtualKey,
        team,
        customer,
        input: 0,
        output: 0,
        costMicro: 0,
      };
    bucket.input += Math.max(0, sample.promptTokens || 0);
    bucket.output += Math.max(0, sample.completionTokens || 0);
    if (sample.costMicroUsd && sample.costMicroUsd > 0) {
      bucket.costMicro += sample.costMicroUsd;
    }
    this.llm.set(key, bucket);

    const rkey = JSON.stringify([
      provider,
      model,
      sample.statusClass,
      virtualKey ?? "",
      team ?? "",
      customer ?? "",
    ]);
    const rbucket = this.llmRequests.get(rkey) ??
      {
        provider,
        model,
        statusClass: sample.statusClass,
        virtualKey,
        team,
        customer,
        count: 0,
      };
    rbucket.count += 1;
    this.llmRequests.set(rkey, rbucket);
  }

  /** Counts a cache resolution ("hit" or "miss"); other values are ignored. */
  recordCacheEvent(result: string): void {
    if (result !== "hit" && result !== "miss") {
      return;
    }
    this.cacheEvents.set(result, (this.cacheEvents.get(result) ?? 0) + 1);
  }

  /** Records time from gateway dispatch to the first streamed byte. */
  recordStreamFirstTokenLatency(durationMs: number): void {
    this.observeHistogram(this.streamFirstTokenLatency, durationMs);
  }

  /** Records the wire interval between consecutive streamed byte chunks. */
  recordStreamInterTokenLatency(durationMs: number): void {
    this.observeHistogram(this.streamInterTokenLatency, durationMs);
  }

  private observeHistogram(histogram: Histogram, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return;
    }
    histogram.count++;
    histogram.sum += durationMs;
    for (let index = 0; index < histogram.buckets.length; index++) {
      if (durationMs <= histogram.buckets[index]) {
        histogram.counts[index]++;
      }
    }
  }

  private renderHistogram(
    lines: string[],
    name: string,
    histogram: Histogram,
  ): void {
    if (histogram.count === 0) {
      return;
    }
    lines.push(`# TYPE ${name} histogram`);
    for (let index = 0; index < histogram.buckets.length; index++) {
      lines.push(
        `${name}_bucket{le="${histogram.buckets[index]}"} ${
          histogram.counts[index]
        }`,
      );
    }
    lines.push(`${name}_bucket{le="+Inf"} ${histogram.count}`);
    lines.push(`${name}_sum ${histogram.sum.toFixed(2)}`);
    lines.push(`${name}_count ${histogram.count}`);
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) {
      return 0;
    }
    const index = Math.min(
      sorted.length - 1,
      Math.ceil((p / 100) * sorted.length) - 1,
    );
    return sorted[Math.max(0, index)];
  }

  /** Prometheus text exposition of counters and latency percentiles. */
  renderPrometheus(): string {
    const lines: string[] = [];

    lines.push("# TYPE frosty_requests_total counter");
    for (const [name, value] of this.counters) {
      const match = name.match(/^http\.(.+)\.(\d{3})$/);
      if (match) {
        lines.push(
          `frosty_requests_total{route="${match[1]}",status="${
            match[2]
          }"} ${value}`,
        );
      }
    }

    lines.push("# TYPE frosty_counter counter");
    for (const [name, value] of this.counters) {
      if (!name.startsWith("http.")) {
        lines.push(`frosty_counter{name="${name}"} ${value}`);
      }
    }

    const costMicro = this.counters.get("cost.micro_usd");
    if (costMicro !== undefined) {
      lines.push("# TYPE frosty_cost_usd_total counter");
      lines.push(`frosty_cost_usd_total ${(costMicro / 1_000_000).toFixed(6)}`);
    }

    if (this.llm.size > 0) {
      lines.push("# TYPE frosty_input_tokens_total counter");
      for (const b of this.llm.values()) {
        lines.push(
          `frosty_input_tokens_total{provider="${
            escapeLabel(b.provider)
          }",model="${escapeLabel(b.model)}"${
            tenantLabelSuffix(b)
          }} ${b.input}`,
        );
      }
      lines.push("# TYPE frosty_output_tokens_total counter");
      for (const b of this.llm.values()) {
        lines.push(
          `frosty_output_tokens_total{provider="${
            escapeLabel(b.provider)
          }",model="${escapeLabel(b.model)}"${
            tenantLabelSuffix(b)
          }} ${b.output}`,
        );
      }
      lines.push("# TYPE frosty_llm_cost_usd_total counter");
      for (const b of this.llm.values()) {
        lines.push(
          `frosty_llm_cost_usd_total{provider="${
            escapeLabel(b.provider)
          }",model="${escapeLabel(b.model)}"${tenantLabelSuffix(b)}} ${
            (b.costMicro / 1_000_000).toFixed(6)
          }`,
        );
      }
    }

    if (this.llmRequests.size > 0) {
      lines.push("# TYPE frosty_llm_requests_total counter");
      for (const b of this.llmRequests.values()) {
        lines.push(
          `frosty_llm_requests_total{provider="${
            escapeLabel(b.provider)
          }",model="${escapeLabel(b.model)}",status_class="${
            escapeLabel(b.statusClass)
          }"${tenantLabelSuffix(b)}} ${b.count}`,
        );
      }
    }

    if (this.cacheEvents.size > 0) {
      lines.push("# TYPE frosty_cache_events_total counter");
      for (const [result, count] of this.cacheEvents) {
        lines.push(
          `frosty_cache_events_total{result="${escapeLabel(result)}"} ${count}`,
        );
      }
    }

    this.renderHistogram(
      lines,
      "frosty_stream_first_token_latency_ms",
      this.streamFirstTokenLatency,
    );
    this.renderHistogram(
      lines,
      "frosty_stream_inter_token_latency_ms",
      this.streamInterTokenLatency,
    );

    lines.push("# TYPE frosty_request_duration_ms summary");
    for (const [route, values] of this.latencies) {
      const sorted = [...values].sort((a, b) => a - b);
      for (const p of [50, 95, 99]) {
        lines.push(
          `frosty_request_duration_ms{route="${route}",quantile="0.${p}"} ${
            this.percentile(sorted, p).toFixed(2)
          }`,
        );
      }
      lines.push(
        `frosty_request_duration_ms_count{route="${route}"} ${values.length}`,
      );
    }

    return lines.join("\n") + "\n";
  }
}
