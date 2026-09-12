// Connection-layer configuration. These are the parses that decide which
// database a replica talks to and whether cross-process invalidation works, so
// they are unit-tested without a server; round trips live in tests/live/.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  assertDirectUrlDistinct,
  DEFAULT_POOL_SIZE,
  pgDirectUrlFromEnv,
  pgUrlFromEnv,
  poolSizeFromEnv,
} from "./pg.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, Deno.env.get(key));
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

Deno.test("poolSizeFromEnv: accepts a sane explicit size", () => {
  assertEquals(poolSizeFromEnv("16"), 16);
  assertEquals(poolSizeFromEnv("1"), 1);
  assertEquals(poolSizeFromEnv("100"), 100);
});

Deno.test("poolSizeFromEnv: every bad input falls back, none throw", () => {
  // A malformed pool size must not take the process down at boot; the bounded
  // parse is the repo-wide convention for config knobs.
  for (
    const bad of [undefined, "", "0", "-4", "1.5", "abc", "101", "1e3", " "]
  ) {
    assertEquals(
      poolSizeFromEnv(bad),
      DEFAULT_POOL_SIZE,
      `input ${JSON.stringify(bad)} should fall back`,
    );
  }
});

Deno.test("pgUrlFromEnv: an unset URL is a boot error, never a default", () => {
  // Defaulting to localhost would let a misconfigured production replica boot
  // healthy against the wrong database.
  withEnv({ FROSTY_PG_URL: undefined }, () => {
    const error = assertThrows(() => pgUrlFromEnv()) as Error;
    assert(error.message.includes("FROSTY_PG_URL is required"));
  });
  withEnv({ FROSTY_PG_URL: "   " }, () => {
    assertThrows(() => pgUrlFromEnv(), Error, "FROSTY_PG_URL is required");
  });
});

Deno.test("pgUrlFromEnv: trims surrounding whitespace", () => {
  withEnv({ FROSTY_PG_URL: "  postgres://h/db  " }, () => {
    assertEquals(pgUrlFromEnv(), "postgres://h/db");
  });
});

Deno.test("pgDirectUrlFromEnv: falls back to the pooled URL", () => {
  withEnv(
    { FROSTY_PG_URL: "postgres://h:5432/db", FROSTY_PG_DIRECT_URL: undefined },
    () => assertEquals(pgDirectUrlFromEnv(), "postgres://h:5432/db"),
  );
});

Deno.test("pgDirectUrlFromEnv: an explicit direct URL wins", () => {
  withEnv({
    FROSTY_PG_URL: "postgres://h:6432/db",
    FROSTY_PG_DIRECT_URL: "postgres://h:5432/db",
  }, () => assertEquals(pgDirectUrlFromEnv(), "postgres://h:5432/db"));
});

Deno.test("pgDirectUrlFromEnv: blank direct URL is treated as unset", () => {
  withEnv({
    FROSTY_PG_URL: "postgres://h:5432/db",
    FROSTY_PG_DIRECT_URL: "  ",
  }, () => assertEquals(pgDirectUrlFromEnv(), "postgres://h:5432/db"));
});

function captureWarn(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

Deno.test("assertDirectUrlDistinct: warns when LISTEN would cross a pooler", () => {
  // The failure this catches is silent: a LISTEN through transaction pooling
  // stops delivering with no error, and cross-process invalidation dies.
  const warnings = captureWarn(() =>
    assertDirectUrlDistinct(
      "postgres://frosty@host:6432/frosty",
      "postgres://frosty@host:6432/frosty",
    )
  );
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("FROSTY_PG_DIRECT_URL"));
});

Deno.test("assertDirectUrlDistinct: silent when a direct URL is configured", () => {
  const warnings = captureWarn(() =>
    assertDirectUrlDistinct(
      "postgres://frosty@host:6432/frosty",
      "postgres://frosty@host:5432/frosty",
    )
  );
  assertEquals(warnings, []);
});

Deno.test("assertDirectUrlDistinct: silent on a normal direct-to-Postgres setup", () => {
  const warnings = captureWarn(() =>
    assertDirectUrlDistinct(
      "postgres://frosty@host:5432/frosty",
      "postgres://frosty@host:5432/frosty",
    )
  );
  assertEquals(warnings, []);
});

Deno.test("assertDirectUrlDistinct: :6432 must be a port, not a substring", () => {
  // A database or password containing 6432 is not a pooler; warning there
  // would train operators to ignore the message that matters.
  const warnings = captureWarn(() =>
    assertDirectUrlDistinct(
      "postgres://frosty@host:5432/db6432",
      "postgres://frosty@host:5432/db6432",
    )
  );
  assertEquals(warnings, []);
});

Deno.test("assertDirectUrlDistinct: matches :6432 with a trailing query", () => {
  const warnings = captureWarn(() =>
    assertDirectUrlDistinct(
      "postgres://h:6432/db?sslmode=require",
      "postgres://h:6432/db?sslmode=require",
    )
  );
  assertEquals(warnings.length, 1);
});
