import { assert, assertEquals } from "@std/assert";
import { Router } from "./router.ts";

function makeRouter(): Router {
  const router = new Router();
  router.post(
    "/v1/chat/completions",
    () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      }),
  );
  router.get("/healthz", () => new Response("ok"));
  return router;
}

Deno.test("router: matched route dispatches to its handler unchanged", async () => {
  const router = makeRouter();
  const res = await router.handle(
    new Request("http://localhost/v1/chat/completions", { method: "POST" }),
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
});

Deno.test("router: method mismatch on a known path returns 405 with Allow", async () => {
  const router = makeRouter();
  const res = await router.handle(
    new Request("http://localhost/v1/chat/completions", { method: "GET" }),
  );
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("Allow"), "POST");
  assert(res.headers.get("Content-Type")?.includes("application/json"));
  const body = await res.json();
  assertEquals(typeof body.error.message, "string");
  assert(body.error.message.includes("GET"));
});

Deno.test("router: Allow header lists every method registered for the path", async () => {
  const router = makeRouter();
  router.put("/v1/chat/completions", () => new Response("put"));
  const res = await router.handle(
    new Request("http://localhost/v1/chat/completions", { method: "DELETE" }),
  );
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("Allow"), "POST, PUT");
  await res.body?.cancel();
});

Deno.test("router: explicitly registered handler wins over the 405 fallback", async () => {
  const router = makeRouter();
  // Mirrors apps/gateway/routes/mcpserver.ts: GET /mcp returns a manual 405.
  router.post("/mcp", () => new Response("rpc"));
  router.get(
    "/mcp",
    () => new Response("Method Not Allowed", { status: 405 }),
  );
  const res = await router.handle(
    new Request("http://localhost/mcp", { method: "GET" }),
  );
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("Allow"), null);
  assertEquals(await res.text(), "Method Not Allowed");
});

Deno.test("router: unknown path returns a 404 JSON error envelope", async () => {
  const router = makeRouter();
  const res = await router.handle(
    new Request("http://localhost/nope/nowhere", { method: "GET" }),
  );
  assertEquals(res.status, 404);
  assert(res.headers.get("Content-Type")?.includes("application/json"));
  const body = await res.json();
  assertEquals(body.error.message, "No route for GET /nope/nowhere.");
});
