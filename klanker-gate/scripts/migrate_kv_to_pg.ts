#!/usr/bin/env -S deno run --unstable-kv --allow-env --allow-read --allow-write=data --allow-net
//
// One-time migration: Deno KV -> PostgreSQL.
//
// Retiring Deno KV (decision-log 60) leaves an existing `data/frosty.kv`
// holding the only copy of the provider accounts, virtual keys, MCP clients,
// operator settings, governance counters, budget anchors, request logs, and -
// critically - the WRAPPED DATA-ENCRYPTION KEY. Losing that last record makes
// every encrypted secret in the store permanently unreadable, so this script
// treats it as the primary object of care rather than as one row among many.
//
//   deno task migrate:kv-pg -- --dry-run     # report only, writes nothing
//   deno task migrate:kv-pg -- --commit      # perform the migration
//
// Properties, all of them deliberate:
//
//   * IDEMPOTENT. Every write is an upsert keyed by the same key path, so a
//     re-run converges instead of duplicating. A migration interrupted halfway
//     is fixed by running it again.
//   * NON-DESTRUCTIVE. The .kv file is never modified or deleted. Roll back by
//     pointing the gateway at the old build; the source of truth is untouched.
//     Note the task still needs --allow-write=data: Deno KV opens its SQLite
//     file read-write even for a pure read, so read-only intent cannot be
//     expressed as a permission here. It is enforced by this script only ever
//     calling kv.list().
//   * COUNTER-AWARE. Deno KV counters (Deno.KvU64) are a distinct type and must
//     land in frosty.counters, not frosty.state. Migrating one as a plain JSON
//     value would leave budgets readable but not incrementable.
//   * VERIFIED. After a --commit run it re-derives ConfigCrypto from the
//     PostgreSQL store, which runs the same canary check the gateway runs at
//     boot. If the DEK did not survive, this fails HERE, loudly, while the KV
//     file is still intact - not later, on a production boot.

import { ConfigCrypto } from "../packages/config/src/crypto.ts";
import { openPg, pgUrlFromEnv } from "../packages/config/src/pg.ts";
import { PostgresStateStore } from "../packages/config/src/store_postgres.ts";
import type { StateKey } from "../packages/config/src/store.ts";

/** KV location of the wrapped DEK. Mirrors crypto.ts; losing it loses secrets. */
const DEK_KEY: readonly string[] = ["config", "crypto", "dek"];

interface Plan {
  values: Array<{ key: StateKey; value: unknown }>;
  counters: Array<{ key: StateKey; value: bigint }>;
  byNamespace: Map<string, { values: number; counters: number }>;
  hasDek: boolean;
}

/**
 * Reads the entire KV store and classifies every entry.
 *
 * Classification is by RUNTIME TYPE, not by key name: `Deno.KvU64` is what
 * `atomic().sum()` writes, and it is the only reliable signal that a row is a
 * counter. Guessing from the key path would silently mis-file any counter
 * namespace added later.
 */
async function buildPlan(kvPath: string): Promise<Plan> {
  const kv = await Deno.openKv(kvPath);
  const plan: Plan = {
    values: [],
    counters: [],
    byNamespace: new Map(),
    hasDek: false,
  };
  try {
    for await (const entry of kv.list({ prefix: [] })) {
      const key = entry.key.map(String);
      const ns = key[0] ?? "(root)";
      const bucket = plan.byNamespace.get(ns) ?? { values: 0, counters: 0 };

      if (entry.value instanceof Deno.KvU64) {
        plan.counters.push({ key, value: entry.value.value });
        bucket.counters++;
      } else {
        plan.values.push({ key, value: entry.value });
        bucket.values++;
        if (
          key.length === DEK_KEY.length && key.every((p, i) => p === DEK_KEY[i])
        ) {
          plan.hasDek = true;
        }
      }
      plan.byNamespace.set(ns, bucket);
    }
  } finally {
    kv.close();
  }
  return plan;
}

function report(plan: Plan, kvPath: string): void {
  console.log(`\nSource: ${kvPath}`);
  console.log(`Target: ${pgUrlFromEnv().replace(/:[^:@/]*@/, ":****@")}\n`);
  const namespaces = [...plan.byNamespace.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  const width = Math.max(20, ...namespaces.map(([ns]) => ns.length + 2));
  console.log(`${"namespace".padEnd(width)}values   counters`);
  console.log("-".repeat(width + 18));
  for (const [ns, counts] of namespaces) {
    console.log(
      `${ns.padEnd(width)}${String(counts.values).padStart(6)}   ${
        String(counts.counters).padStart(8)
      }`,
    );
  }
  console.log("-".repeat(width + 18));
  console.log(
    `${"TOTAL".padEnd(width)}${String(plan.values.length).padStart(6)}   ${
      String(plan.counters.length).padStart(8)
    }`,
  );
  console.log(
    plan.hasDek
      ? "\n  encryption: wrapped DEK present and will be migrated. Every " +
        "encrypted\n              secret depends on it landing intact; " +
        "verified after commit."
      : "\n  encryption: no crypto record - the store is in plaintext mode.",
  );
}

async function main(): Promise<number> {
  const args = new Set(Deno.args);
  const dryRun = args.has("--dry-run") || !args.has("--commit");
  const kvPath = Deno.env.get("FROSTY_KV_PATH") ?? "data/frosty.kv";

  try {
    const stat = await Deno.stat(kvPath);
    if (!stat.isFile) {
      throw new Error("not a file");
    }
  } catch {
    console.error(
      `No Deno KV database at ${kvPath}. Set FROSTY_KV_PATH, or skip the ` +
        `migration if this deployment never ran the KV build.`,
    );
    return 1;
  }

  const plan = await buildPlan(kvPath);
  report(plan, kvPath);

  if (dryRun) {
    console.log(
      "\nDRY RUN - nothing was written. Re-run with --commit to migrate.",
    );
    return 0;
  }

  const pg = await openPg({ url: pgUrlFromEnv(), max: 4 });
  try {
    const store = new PostgresStateStore(pg);
    await store.init();

    let written = 0;
    for (const row of plan.values) {
      await store.set(row.key, row.value);
      written++;
      if (written % 500 === 0) {
        console.log(`  ... ${written}/${plan.values.length} values`);
      }
    }
    console.log(`  values:   ${written}`);

    // Counters are SET, not summed. A re-run must converge on the source value;
    // adding the delta again would double every budget that had already been
    // migrated, turning a safe retry into silent over-counting.
    for (const row of plan.counters) {
      const current = await store.getCount(row.key);
      const delta = row.value - BigInt(current);
      if (delta !== 0n) {
        await store.sum(row.key, delta);
      }
    }
    console.log(`  counters: ${plan.counters.length}`);

    // The check that matters. fromEnv unwraps the DEK with FROSTY_ENCRYPTION_KEY
    // and verifies the canary - exactly what the gateway does at boot - so a DEK
    // that did not survive fails now, while the KV file is still intact.
    if (plan.hasDek) {
      console.log("  verifying encryption round-trip against PostgreSQL ...");
      const crypto = await ConfigCrypto.fromEnv(store);
      if (!crypto) {
        console.error(
          "\nFAILED: the source store had a crypto record but the migrated " +
            "store reports plaintext mode. Do NOT delete the KV file. " +
            "Check that FROSTY_ENCRYPTION_KEY is set for this command.",
        );
        return 1;
      }
      console.log("  encryption: canary verified, secrets are readable.");
    }

    console.log(
      `\nMigration complete. ${kvPath} was NOT modified - keep it until the ` +
        `gateway has run against PostgreSQL successfully.`,
    );
    return 0;
  } finally {
    await pg.close();
  }
}

if (import.meta.main) {
  Deno.exit(await main());
}
