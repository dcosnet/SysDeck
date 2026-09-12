import { assertEquals, assertRejects } from "@std/assert";
import {
  AllProvidersFailedError,
  dispatchWithFallback,
  isFallbackEligible,
} from "./fallback.ts";
import { ProviderError } from "./client.ts";
import type { ResolvedTarget } from "./manager.ts";
import { ProviderRegistry } from "../../contracts/src/mod.ts";
import type { IProviderAdapter } from "./types.ts";

function target(id: string): ResolvedTarget {
  return {
    providerId: id,
    type: "openai",
    adapter: {} as IProviderAdapter,
    model: "m",
    capabilities: ProviderRegistry.openai,
  };
}

Deno.test("dispatchWithFallback reroutes on 429 and 5xx", async () => {
  const calls: string[] = [];
  const outcome = await dispatchWithFallback(
    [target("first"), target("second"), target("third")],
    (t) => {
      calls.push(t.providerId);
      if (t.providerId === "first") {
        throw new ProviderError(429, "Too Many Requests", "");
      }
      if (t.providerId === "second") {
        throw new ProviderError(503, "Unavailable", "");
      }
      return Promise.resolve(new Response("ok"));
    },
  );
  assertEquals(calls, ["first", "second", "third"]);
  assertEquals(outcome.target.providerId, "third");
  assertEquals(outcome.failures.length, 2);
  await outcome.response.body?.cancel();
});

Deno.test("dispatchWithFallback does NOT reroute on 4xx contract errors", async () => {
  const calls: string[] = [];
  await assertRejects(
    () =>
      dispatchWithFallback([target("first"), target("second")], (t) => {
        calls.push(t.providerId);
        throw new ProviderError(400, "Bad Request", "");
      }),
    ProviderError,
  );
  assertEquals(calls, ["first"]);
});

Deno.test("dispatchWithFallback does NOT reroute on client abort", async () => {
  await assertRejects(
    () =>
      dispatchWithFallback([target("first"), target("second")], () => {
        throw new DOMException("aborted", "AbortError");
      }),
    DOMException,
  );
});

Deno.test("dispatchWithFallback throws AllProvidersFailedError when exhausted", async () => {
  const err = await assertRejects(
    () =>
      dispatchWithFallback([target("a"), target("b")], () => {
        throw new ProviderError(500, "boom", "");
      }),
    AllProvidersFailedError,
  );
  assertEquals(err.failures.length, 2);
});

Deno.test("isFallbackEligible classifies errors", () => {
  assertEquals(isFallbackEligible(new ProviderError(429, "", "")), true);
  assertEquals(isFallbackEligible(new ProviderError(500, "", "")), true);
  assertEquals(isFallbackEligible(new ProviderError(400, "", "")), false);
  assertEquals(isFallbackEligible(new TypeError("network")), true);
  assertEquals(
    isFallbackEligible(new DOMException("x", "AbortError")),
    false,
  );
});
