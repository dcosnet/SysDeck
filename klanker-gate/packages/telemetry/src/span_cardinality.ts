/** Value substituted once the distinct-model cap is exceeded. */
export const COLLAPSED_LABEL = "other";

/** Default cap on distinct model labels emitted as a metric dimension. */
export const DEFAULT_MODEL_CARDINALITY_CAP = 11;

export interface SpanCardinalityState {
  /** Distinct models admitted as labels (never exceeds the cap). */
  admitted: number;
  /** Configured cap. */
  cap: number;
  /** True once at least one model has been folded to "other". */
  collapsed: boolean;
  /** How many DISTINCT models have been folded to "other". */
  collapsedModels: number;
}

/**
 * Admits the first `cap` distinct model ids as themselves and folds the rest to
 * {@link COLLAPSED_LABEL}.
 *
 * Admission is first-come and sticky, so a series never changes identity
 * mid-flight (which would break `rate()` over it). Overflow ids are counted,
 * not remembered individually - remembering them would reintroduce the
 * unbounded growth this exists to stop.
 */
export class SpanModelCardinalityGuard {
  readonly cap: number;
  #admitted = new Set<string>();
  #overflow = new Set<string>();
  /** Bounded: stops recording distinct overflow ids past this many. */
  static readonly #OVERFLOW_SAMPLE_CAP = 64;
  #overflowBeyondSample = 0;

  constructor(cap: number = DEFAULT_MODEL_CARDINALITY_CAP) {
    this.cap = Number.isFinite(cap) && cap > 0
      ? Math.floor(cap)
      : DEFAULT_MODEL_CARDINALITY_CAP;
  }

  /**
   * The label for `model`: the id itself while slots remain, otherwise
   * {@link COLLAPSED_LABEL}. An empty/absent model never consumes a slot.
   */
  label(model: string | undefined | null): string {
    if (!model) {
      return "unknown";
    }
    if (this.#admitted.has(model)) {
      return model;
    }
    if (this.#admitted.size < this.cap) {
      this.#admitted.add(model);
      return model;
    }
    // Distinct overflow ids are tracked only far enough to report HOW MANY
    // models were dropped; past the sample cap we keep a count alone.
    if (!this.#overflow.has(model)) {
      if (
        this.#overflow.size < SpanModelCardinalityGuard.#OVERFLOW_SAMPLE_CAP
      ) {
        this.#overflow.add(model);
      } else {
        this.#overflowBeyondSample++;
      }
    }
    return COLLAPSED_LABEL;
  }

  /** True once any model has been folded. Sticky. */
  get collapsed(): boolean {
    return this.#overflow.size > 0 || this.#overflowBeyondSample > 0;
  }

  state(): SpanCardinalityState {
    return {
      admitted: this.#admitted.size,
      cap: this.cap,
      collapsed: this.collapsed,
      collapsedModels: this.#overflow.size + this.#overflowBeyondSample,
    };
  }
}

/**
 * Reads FROSTY_OTEL_MODEL_CARDINALITY_CAP. Unset, unparseable, or non-positive
 * falls back to the default: a bad knob never widens a guard.
 */
export function modelCardinalityCapFromEnv(): number {
  let raw: string | undefined;
  try {
    raw = Deno.env.get("FROSTY_OTEL_MODEL_CARDINALITY_CAP") ?? undefined;
  } catch {
    return DEFAULT_MODEL_CARDINALITY_CAP;
  }
  if (!raw) {
    return DEFAULT_MODEL_CARDINALITY_CAP;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_MODEL_CARDINALITY_CAP;
}
