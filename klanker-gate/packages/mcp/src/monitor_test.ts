import { assertEquals } from "@std/assert";
import { MCPRegistry } from "./registry.ts";
import { MCPHealthMonitor } from "./monitor.ts";

/**
 * Scripted streamable-http server whose `initialize` fails for the first
 * `failInitUntil` attempts, then succeeds. Counts every initialize attempt so
 * tests can prove a reconnect (an extra sync) was triggered.
 */
function countingFetch(failInitUntil: number): {
  fetch: typeof fetch;
  initCalls: () => number;
} {
  let initCalls = 0;
  const reply = (id: unknown, result: unknown): Promise<Response> =>
    Promise.resolve(
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id, result }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  const impl: typeof fetch = (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === "initialize") {
      initCalls++;
      if (initCalls <= failInitUntil) {
        return Promise.reject(new TypeError("connection refused"));
      }
      return reply(body.id, { protocolVersion: "2025-06-18" });
    }
    if (body.method === "tools/list") {
      return reply(body.id, {
        tools: [{ name: "ping", annotations: { readOnlyHint: true } }],
      });
    }
    return reply(body.id ?? 0, {});
  };
  return { fetch: impl, initCalls: () => initCalls };
}

function flakyRegistry(fetchImpl: typeof fetch): MCPRegistry {
  return new MCPRegistry(
    [{
      id: "flaky",
      url: "http://flaky.test/rpc",
      transport: "streamable-http",
      enabled: true,
      requestTimeoutMs: 500,
    }],
    fetchImpl,
  );
}

Deno.test("consecutive failures below the threshold stay unhealthy (no reconnect)", async () => {
  const counting = countingFetch(Number.POSITIVE_INFINITY);
  const monitor = new MCPHealthMonitor(flakyRegistry(counting.fetch), 3);

  await monitor.checkAll();
  const health = monitor.statuses()[0];
  assertEquals(health.status, "unhealthy");
  assertEquals(health.consecutiveFailures, 1);
  // One sync attempt only: the threshold gate did NOT fire a reconnect.
  assertEquals(counting.initCalls(), 1);
});

Deno.test("threshold breach marks disconnected and attempts a reconnect", async () => {
  const counting = countingFetch(Number.POSITIVE_INFINITY); // server never recovers
  const monitor = new MCPHealthMonitor(flakyRegistry(counting.fetch), 2);

  await monitor.checkAll(); // failure 1 -> unhealthy
  assertEquals(monitor.statuses()[0].status, "unhealthy");
  assertEquals(counting.initCalls(), 1);

  await monitor.checkAll(); // failure 2 -> threshold -> reconnect (also fails)
  const health = monitor.statuses()[0];
  assertEquals(health.status, "disconnected");
  assertEquals(health.consecutiveFailures, 2);
  // Primary sync (#2) plus the reconnect sync = one extra initialize attempt.
  assertEquals(counting.initCalls(), 3);
});

Deno.test("a reconnect that succeeds heals the client back to healthy", async () => {
  // initialize fails on attempts 1 and 2, then succeeds from attempt 3 on.
  const counting = countingFetch(2);
  const monitor = new MCPHealthMonitor(flakyRegistry(counting.fetch), 2);

  await monitor.checkAll(); // failure 1 -> unhealthy
  assertEquals(monitor.statuses()[0].status, "unhealthy");

  await monitor.checkAll(); // failure 2 -> threshold -> reconnect succeeds
  const health = monitor.statuses()[0];
  assertEquals(health.status, "healthy");
  assertEquals(health.consecutiveFailures, 0);
  assertEquals(health.toolCount, 1);
  // The 3rd initialize attempt is the reconnect that brought the server back.
  assertEquals(counting.initCalls(), 3);
});
