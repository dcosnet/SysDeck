// LIVE evidence for the pgvector embedding index. Not part of the default gate —
// `deno task test:live` starts the Compose postgres service and exercises it.
//
// The redis-stack half of this file went with the rest of Redis
// (decision-log 62). pgvector lives in the same PostgreSQL that now holds
// state and the L2 response cache, so this suite and postgres_state_live_test.ts
// share one service.

import { assert, assertEquals } from "@std/assert";
import { PgVectorStore } from "../../packages/cache/src/pgvector.ts";

async function docker(...args: string[]): Promise<string> {
  const out = await new Deno.Command("docker", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `docker ${args.join(" ")} failed: ${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(out.stdout).trim();
}

async function waitFor(
  probe: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await probe();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`service not ready within ${timeoutMs}ms: ${lastError}`);
}

let sandboxReady: Promise<string> | undefined;

function ensureVectorSandbox(): Promise<string> {
  sandboxReady ??= docker(
    "compose",
    "--profile",
    "live",
    "up",
    "-d",
    "--wait",
    "postgres",
  );
  return sandboxReady;
}

Deno.test("LIVE pgvector: round-trip against the Compose sandbox", async () => {
  await ensureVectorSandbox();
  const postgres = (await import("postgres")).default;
  const url = "postgres://frosty:frosty@127.0.0.1:5432/frosty";
  await waitFor(async () => {
    const probe = postgres(url, { max: 1, connect_timeout: 2 });
    try {
      await probe`SELECT 1`;
    } finally {
      await probe.end();
    }
  }, 90_000);

  const sql = postgres(url, { max: 1 });
  // The Compose sandbox persists for inspection. Give each test an isolated,
  // generated table so a prior run cannot affect its similarity assertion.
  const table = `frosty_live_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    const store = new PgVectorStore({
      executor: {
        unsafe: async (query, params) =>
          await sql.unsafe(query, params as never[]) as unknown[],
      },
      table,
    });
    const eastId = crypto.randomUUID();
    await store.upsert(eastId, [1, 0, 0], { note: "east" });
    await store.upsert(crypto.randomUUID(), [0, 1, 0], { note: "north" });

    const matches = await store.search([0.98, 0.05, 0], { threshold: 0.9 });
    assertEquals(matches.length, 1);
    assertEquals(matches[0].id, eastId);
    assertEquals((matches[0].payload as { note: string }).note, "east");
    assert(matches[0].score > 0.9);

    const none = await store.search([0.7, 0.7, 0], { threshold: 0.99 });
    assertEquals(none.length, 0);
  } finally {
    // `table` is generated locally, never user input. Remove only this
    // test's data while leaving the sandbox service available to operators.
    await sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
    await sql.end();
  }
});
