import type { Plugin } from "./lifecycle.ts";

/** Returns valid JSON: the input itself when parseable, else a completion. */
export function repairJson(text: string): string {
  const trimmed = text.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // fall through to repair
  }

  const start = Math.min(
    ...["{", "["]
      .map((c) => trimmed.indexOf(c))
      .filter((i) => i >= 0),
  );
  if (!Number.isFinite(start)) {
    return trimmed;
  }
  let candidate = trimmed.slice(start);

  // Scan tracking string state and bracket stack.
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of candidate) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      stack.pop();
    }
  }

  if (escaped) {
    candidate = candidate.slice(0, -1); // dangling backslash
  }
  if (inString) {
    candidate += '"';
  }
  // Trailing comma (or comma + whitespace) before we close containers.
  candidate = candidate.replace(/,\s*$/, "");
  // Dangling key (`"a":`) gets a null value.
  candidate = candidate.replace(/:\s*$/, ": null");
  for (let i = stack.length - 1; i >= 0; i--) {
    candidate += stack[i] === "{" ? "}" : "]";
  }

  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return trimmed; // Unrepairable: hand back the original.
  }
}

/** True when `s` (ignoring leading whitespace) opens a JSON object or array. */
function looksLikeJson(s: string): boolean {
  const head = s.trimStart();
  return head.startsWith("{") || head.startsWith("[");
}

/** True when `s` parses as JSON. */
function isValidJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether JSON repair is enabled for this process. OFF by default, so the
 * plugin never silently mutates responses; an operator opts in globally with
 * FROSTY_JSON_REPAIR=on (also accepts 1/true/yes). Mirrors the boot-time env
 * gating other frosty features use (FROSTY_PRICING_SYNC, FROSTY_CACHE, ...).
 */
export function jsonRepairEnabledFromEnv(): boolean {
  const value = (Deno.env.get("FROSTY_JSON_REPAIR") ?? "").trim().toLowerCase();
  return value === "on" || value === "1" || value === "true" ||
    value === "yes";
}

/** A repair applied to a completed stream's reconstructed content. */
export interface StreamRepair {
  /** Repaired, now-valid JSON. */
  repaired: string;
  /** Original (invalid) reconstructed content. */
  original: string;
  /** Reconstructed response id, when the stream carried one. */
  id?: string;
  /** Reconstructed response model, when the stream carried one. */
  model?: string;
}

/** Options for {@link jsonRepairPlugin}. */
export interface JsonRepairOptions {
  /**
   * Sink for streamed-response repairs. onStreamComplete fires only after the
   * live client stream has already flowed byte-identically, so a repaired
   * stream cannot be pushed back to that client; the repaired JSON is instead
   * handed here for out-of-band use (a metric, a log, a durable copy). Absent
   * by default: with no sink the streaming path is a pure no-op.
   */
  onStreamRepair?: (repair: StreamRepair) => void;
}

/**
 * Plugin: repairs assistant message content that looks like truncated JSON.
 *
 * - onPostRequest (non-streaming) repairs res.choices[0].message.content,
 *   returning a shallow-copied response only when a repair changed it.
 * - onStreamComplete (streaming) inspects the StreamAccumulator's fully
 *   reconstructed message (frosty's equivalent of the Go plugin's per-request
 *   accumulation) and, when it is JSON-looking but invalid, repairs it and
 *   hands the result to `onStreamRepair`. Post-completion only: the live
 *   client stream is never altered (see withStreamCompletion).
 *
 * Safe-by-default: register it only behind an opt-in (jsonRepairEnabledFromEnv)
 * so the default gateway leaves responses untouched.
 */
export function jsonRepairPlugin(options: JsonRepairOptions = {}): Plugin {
  return {
    name: "jsonparser",
    onPostRequest: (res) => {
      const content = res.choices?.[0]?.message?.content;
      if (typeof content === "string" && looksLikeJson(content)) {
        const repaired = repairJson(content);
        if (repaired !== content) {
          return Promise.resolve({
            ...res,
            choices: res.choices.map((choice, i) =>
              i === 0
                ? {
                  ...choice,
                  message: { ...choice.message, content: repaired },
                }
                : choice
            ),
          });
        }
      }
      return Promise.resolve(res);
    },
    onStreamComplete: (text, message) => {
      const sink = options.onStreamRepair;
      if (!sink) {
        return Promise.resolve();
      }
      // The reconstructed message content is the accumulation of every content
      // delta (Go parity: accumulateContent). Fall back to the concatenated
      // text so legacy (text) => ... callers still get repair.
      const content = message?.content ?? text;
      if (!looksLikeJson(content)) {
        return Promise.resolve();
      }
      const trimmed = content.trim();
      // Already valid: nothing to repair (idempotent, safe no-op).
      if (isValidJson(trimmed)) {
        return Promise.resolve();
      }
      const repaired = repairJson(trimmed);
      // Surface only a genuine, successful repair.
      if (repaired !== trimmed && isValidJson(repaired)) {
        sink({
          repaired,
          original: content,
          id: message?.id,
          model: message?.model,
        });
      }
      return Promise.resolve();
    },
  };
}
