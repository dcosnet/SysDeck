export interface OtelSpanInput {
  name: string;
  startMs: number;
  endMs: number;
  attributes?: Record<string, string | number | boolean>;
  error?: boolean;
  /** Provided trace id (32 hex). Minted per span when omitted. */
  traceId?: string;
  /** Provided span id (16 hex). Minted per span when omitted. */
  spanId?: string;
  /** Parent span id (16 hex) for child spans; emitted only when set. */
  parentSpanId?: string;
  /** OTLP span kind (2=SERVER default, 3=CLIENT). */
  kind?: number;
  /** W3C tracestate passed through from the inbound request; emitted only when
   * set (OTLP span `traceState` field). */
  traceState?: string;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toOtlpAttributes(
  attributes: Record<string, string | number | boolean> = {},
): Array<Record<string, unknown>> {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: typeof value === "string"
      ? { stringValue: value }
      : typeof value === "boolean"
      ? { boolValue: value }
      : Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value },
  }));
}

export class OtelExporter {
  private buffer: OtelSpanInput[] = [];
  dropped = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private endpoint: string,
    private serviceName = "frosty-gateway",
    private fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    private maxBuffer = 512,
  ) {
    this.endpoint = endpoint.replace(/\/$/, "");
  }

  /** Hot-path safe: synchronous buffer append, bounded. */
  record(span: OtelSpanInput): void {
    if (this.buffer.length >= this.maxBuffer) {
      this.dropped++;
      return;
    }
    this.buffer.push(span);
  }

  buffered(): number {
    return this.buffer.length;
  }

  /** Sends the buffered spans as one OTLP/HTTP JSON batch. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }
    const spans = this.buffer.splice(0, this.buffer.length);
    const payload = {
      resourceSpans: [{
        resource: {
          attributes: [{
            key: "service.name",
            value: { stringValue: this.serviceName },
          }],
        },
        scopeSpans: [{
          scope: { name: "frosty-gateway" },
          spans: spans.map((span) => {
            // Prefer caller-supplied ids so a span can join an inbound trace or
            // parent a child; mint per-span only when ids are absent (this
            // fixes the earlier defect where every span got a random trace id).
            const out: Record<string, unknown> = {
              traceId: span.traceId ?? randomHex(16),
              spanId: span.spanId ?? randomHex(8),
              name: span.name,
              kind: span.kind ?? 2, // SERVER default
              // Compute nanos with BigInt: ms×1e6 exceeds 2^53, so Number
              // math would quantize the OTLP timestamp (~256ns ULP).
              startTimeUnixNano: (BigInt(Math.round(span.startMs)) * 1_000_000n)
                .toString(),
              endTimeUnixNano: (BigInt(Math.round(span.endMs)) * 1_000_000n)
                .toString(),
              attributes: toOtlpAttributes(span.attributes),
              status: { code: span.error ? 2 : 1 },
            };
            if (span.parentSpanId) {
              out.parentSpanId = span.parentSpanId;
            }
            if (span.traceState) {
              out.traceState = span.traceState;
            }
            return out;
          }),
        }],
      }],
    };
    try {
      const response = await this.fetchImpl(`${this.endpoint}/v1/traces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await response.body?.cancel();
      if (!response.ok) {
        this.dropped += spans.length;
      }
    } catch {
      this.dropped += spans.length;
    }
  }

  start(intervalMs = 5000): void {
    this.stop();
    this.timer = setInterval(() => {
      this.flush().catch(() => {});
    }, intervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
