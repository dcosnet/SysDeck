// GET /api/runtime - the surface the Status page reads for worker topology,
// saturation, and limit state.
//
// The properties that matter are the ones a Status tile would otherwise state
// wrongly: that connection URLs never leave the process with credentials in
// them, that the worker count reflects what the PLATFORM can do rather than
// what the env var asks for, and that the concurrency gauge does not leak.

import { assert, assertEquals } from "@std/assert";
import { Router } from "../../packages/core/src/mod.ts";
import {
  redactPgTarget,
  registerRuntimeRoutes,
  type RuntimeView,
} from "../../apps/gateway/routes/runtime.ts";
import { createContext } from "../../apps/gateway/context.ts";
import { metricsMiddleware } from "../../apps/gateway/routes/governance.ts";

function handler() {
  const router = new Router();
  const ctx = createContext();
  registerRuntimeRoutes(router, ctx);
  return { router, ctx };
}

async function fetchRuntime(router: Router): Promise<RuntimeView> {
  const response = await router.handle(
    new Request("http://gw.test/api/runtime"),
  );
  assertEquals(response.status, 200);
  return await response.json() as RuntimeView;
}

Deno.test("runtime: reports worker topology for the current platform", async () => {
  const { router } = handler();
  const view = await fetchRuntime(router);

  assertEquals(view.workers.platform, Deno.build.os);
  // Windows has no SO_REUSEPORT, so the effective count is pinned at 1 no
  // matter what FROSTY_WORKERS says. Reporting the requested number there
  // would tell an operator four processes are serving when one is.
  if (!view.workers.reusePortSupported) {
    assertEquals(view.workers.effective, 1);
  }
  assert(view.workers.effective >= 1);
  assert(
    view.workers.reason.length > 0,
    "reason is rendered verbatim in the UI",
  );
});

Deno.test("runtime: FROSTY_WORKERS is honored only where the platform allows", async () => {
  const previous = Deno.env.get("FROSTY_WORKERS");
  Deno.env.set("FROSTY_WORKERS", "4");
  try {
    const { router } = handler();
    const view = await fetchRuntime(router);
    assertEquals(view.workers.configured, 4);
    assertEquals(
      view.workers.effective,
      view.workers.reusePortSupported ? 4 : 1,
    );
    // The connection estimate must follow the EFFECTIVE count: sizing a
    // database against processes that are not running is how max_connections
    // gets set wrong.
    assertEquals(
      view.postgres.estimatedFleetConnections,
      view.workers.effective * view.postgres.poolSize + view.workers.effective,
    );
  } finally {
    if (previous === undefined) {
      Deno.env.delete("FROSTY_WORKERS");
    } else {
      Deno.env.set("FROSTY_WORKERS", previous);
    }
  }
});

Deno.test("runtime: a garbage FROSTY_WORKERS falls back to 1", async () => {
  const previous = Deno.env.get("FROSTY_WORKERS");
  Deno.env.set("FROSTY_WORKERS", "not-a-number");
  try {
    const view = await fetchRuntime(handler().router);
    assertEquals(view.workers.configured, 1);
    assertEquals(view.workers.effective, 1);
  } finally {
    if (previous === undefined) {
      Deno.env.delete("FROSTY_WORKERS");
    } else {
      Deno.env.set("FROSTY_WORKERS", previous);
    }
  }
});

Deno.test("runtime: NEVER echoes database credentials", async () => {
  const previous = Deno.env.get("FROSTY_PG_URL");
  Deno.env.set(
    "FROSTY_PG_URL",
    "postgres://frosty:sup3r-s3cret@db.internal:5432/frosty",
  );
  try {
    const view = await fetchRuntime(handler().router);
    // The whole point of the redaction: this endpoint is admin-gated but its
    // response ends up in browser memory, screenshots, and bug reports.
    assert(
      !view.postgres.target.includes("sup3r-s3cret"),
      "password must never reach the client",
    );
    assert(
      !view.postgres.target.includes("frosty:"),
      "user must not be echoed",
    );
    assertEquals(view.postgres.target, "db.internal:5432/frosty");
  } finally {
    if (previous === undefined) {
      Deno.env.delete("FROSTY_PG_URL");
    } else {
      Deno.env.set("FROSTY_PG_URL", previous);
    }
  }
});

Deno.test("redactPgTarget: handles absent and unparseable input", () => {
  assertEquals(redactPgTarget(undefined), "not configured");
  assertEquals(redactPgTarget(""), "not configured");
  // An unparseable value must not be echoed back - it could be a paste
  // accident that still contains a password in an unexpected shape.
  assertEquals(redactPgTarget("://:@@nonsense"), "(unparseable)");
  assertEquals(
    redactPgTarget("postgres://u:p@host:6432/appdb?sslmode=require"),
    "host:6432/appdb",
  );
});

Deno.test("runtime: rate-limit state counts only keys that declare a limit", async () => {
  const { router, ctx } = handler();
  ctx.virtualKeys.upsert({
    id: "k-limited",
    name: "limited",
    enabled: true,
    usedRequests: 0,
    usedCostMicroUsd: 0,
    token: "vk-runtime-limited",
    rateLimit: { maxRequests: 60, windowMs: 60_000 },
  });
  ctx.virtualKeys.upsert({
    id: "k-open",
    name: "open",
    enabled: true,
    usedRequests: 0,
    usedCostMicroUsd: 0,
    token: "vk-runtime-open",
  });

  const view = await fetchRuntime(router);
  assertEquals(view.rateLimit.totalKeys, 2);
  assertEquals(view.rateLimit.keysWithLimits, 1);
  assertEquals(view.rateLimit.enforced, true);
  assertEquals(view.rateLimit.windows, [
    { keyId: "k-limited", maxRequests: 60, windowMs: 60_000 },
  ]);
  // Per-process is a correctness caveat, not a cosmetic label: the UI relies
  // on it to warn that N workers multiply a per-window limit by N.
  assertEquals(view.rateLimit.scope, "per-process");
  assertEquals(view.concurrency.scope, "per-process");
});

// Gauge mechanics are unit-tested in packages/telemetry/src/concurrency_test.ts.
// What belongs HERE is that the middleware actually holds the gauge across a
// streamed response - the wiring, not the counter.
Deno.test("runtime: metricsMiddleware counts a stream for its whole life", async () => {
  const ctx = createContext();
  const gauge = ctx.concurrency!;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));

  const handler = metricsMiddleware(ctx);
  const response = await handler(
    new Request("http://gw.test/v1/chat/completions", { method: "POST" }),
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("data: a\n\n"));
              await gate;
              controller.close();
            },
          }),
        ),
      ),
  );

  const reader = response.body!.getReader();
  await reader.read();
  // The handler has long since returned; only the body is still open.
  assertEquals(gauge.dispatching(), 0, "handler finished");
  assertEquals(gauge.active(), 1, "connection still counted mid-stream");

  release();
  await reader.read();
  assertEquals(gauge.active(), 0, "closed when the stream ended");
  assertEquals(gauge.snapshot().completed, 1);
});

Deno.test("runtime: a client abort mid-stream releases the connection", async () => {
  const ctx = createContext();
  const gauge = ctx.concurrency!;
  const handler = metricsMiddleware(ctx);
  const response = await handler(
    new Request("http://gw.test/v1/chat/completions", { method: "POST" }),
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: a\n\n"));
            },
          }),
        ),
      ),
  );
  const reader = response.body!.getReader();
  await reader.read();
  assertEquals(gauge.active(), 1);
  await reader.cancel("client hung up");
  // An abandoned SSE connection is the common case in production; leaking it
  // would make the gateway read as permanently saturated.
  assertEquals(gauge.active(), 0);
});

Deno.test("runtime: a throwing handler releases the connection", async () => {
  const ctx = createContext();
  const gauge = ctx.concurrency!;
  const handler = metricsMiddleware(ctx);
  await handler(
    new Request("http://gw.test/v1/chat/completions"),
    () => Promise.reject(new Error("boom")),
  ).catch(() => {});
  assertEquals(gauge.active(), 0);
  assertEquals(gauge.dispatching(), 0);
});

Deno.test("runtime: the reported snapshot reflects live gauge state", async () => {
  const { router, ctx } = handler();
  const held = ctx.concurrency!.open();
  const view = await fetchRuntime(router);
  assert(view.concurrency.active >= 1, "an open connection must be visible");
  assertEquals(view.concurrency.scope, "per-process");
  held.close();
});
