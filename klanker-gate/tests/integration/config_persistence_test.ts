// Save, reload, and restart semantics for the KV-backed config service.

import { assertEquals, assertRejects } from "@std/assert";
import { ConfigService } from "../../packages/config/src/service.ts";
import type { ProviderAccountConfig } from "../../packages/contracts/src/mod.ts";

function account(id: string, models: string[] = ["m"]): ProviderAccountConfig {
  return {
    id,
    type: "openai",
    apiKey: `sk-${id}`,
    enabled: true,
    models,
    priority: 0,
  };
}

Deno.test("config survives service restart on the same store", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/config.kv`;

  const first = await ConfigService.open(path);
  await first.upsertProvider(account("openai", ["gpt-4o"]));
  await first.setDefaultProvider("openai");
  first.close();

  const second = await ConfigService.open(path);
  const loaded = await second.loadAll();
  second.close();
  await Deno.remove(dir, { recursive: true });

  assertEquals(loaded.defaultProvider, "openai");
  assertEquals(loaded.providers.length, 1);
  assertEquals(loaded.providers[0].id, "openai");
  assertEquals(loaded.providers[0].apiKey, "sk-openai");
  assertEquals(loaded.providers[0].models, ["gpt-4o"]);
});

Deno.test("concurrent updates do not corrupt persisted state", async () => {
  const service = await ConfigService.open(":memory:");
  await Promise.all(
    Array.from(
      { length: 20 },
      (_, i) => service.upsertProvider(account(`p${i}`)),
    ),
  );
  const loaded = await service.loadAll();
  service.close();

  assertEquals(loaded.providers.length, 20);
  const ids = loaded.providers.map((p) => p.id).sort();
  assertEquals(ids[0], "p0");
  assertEquals(new Set(ids).size, 20);
});

Deno.test("import replaces existing config and export round-trips", async () => {
  const service = await ConfigService.open(":memory:");
  await service.upsertProvider(account("old"));

  await service.importConfig({
    defaultProvider: "fresh",
    providers: [account("fresh")],
  });
  const loaded = await service.loadAll();

  assertEquals(loaded.providers.map((p) => p.id), ["fresh"]);
  assertEquals(loaded.defaultProvider, "fresh");

  const redacted = await service.exportConfig();
  // Canonical redaction: secret stripped entirely + hasApiKey marker kept.
  assertEquals(redacted.config.providers[0].apiKey, undefined);
  assertEquals(
    (redacted.config.providers[0] as Record<string, unknown>).hasApiKey,
    true,
  );

  const full = await service.exportConfig(true);
  assertEquals(full.config.providers[0].apiKey, "sk-fresh");

  // Round-trip: an export (with secrets) can be re-imported losslessly.
  const twin = await ConfigService.open(":memory:");
  await twin.importConfig(full);
  const twinLoaded = await twin.loadAll();
  twin.close();
  service.close();
  assertEquals(twinLoaded.providers[0].apiKey, "sk-fresh");
});

Deno.test("import rejects a malformed export wrapper instead of wiping providers", async () => {
  const service = await ConfigService.open(":memory:");
  await service.upsertProvider(account("keep"));

  // A ConfigExport wrapper missing the required `exportedAt` field. Previously
  // this failed the export parse, then the bare-config fallback silently
  // stripped `version`/`config`, defaulted `providers` to [], and WIPED the
  // provider set. With GatewayConfigSchema strict, the fallback parse throws.
  const malformed = {
    version: 1,
    config: { defaultProvider: "fresh", providers: [account("fresh")] },
  };
  await assertRejects(() => service.importConfig(malformed));

  // The existing provider set must be intact — the throw happens before any
  // deletion, so nothing was destroyed.
  const loaded = await service.loadAll();
  service.close();
  assertEquals(loaded.providers.map((p) => p.id), ["keep"]);
});

Deno.test("import rejects an unknown top-level key in a bare config", async () => {
  const service = await ConfigService.open(":memory:");
  await service.upsertProvider(account("keep"));

  // A typo'd/extra top-level key is now a hard error rather than a silent strip.
  await assertRejects(() =>
    service.importConfig({
      defaultProvider: "fresh",
      providers: [account("fresh")],
      providerz: [account("typo")],
    })
  );

  const loaded = await service.loadAll();
  service.close();
  assertEquals(loaded.providers.map((p) => p.id), ["keep"]);
});
