import type { StateKey, StateStore } from "./store.ts";
import { MemoryStateStore } from "./store_memory.ts";
import { type ConfigCrypto, ConfigCryptoError } from "./crypto.ts";
import type {
  ConfigExport,
  GatewayConfig,
  GlobalProxyConfig,
  ProviderAccountConfig,
} from "../../contracts/src/mod.ts";
import {
  ConfigExportSchema,
  GatewayConfigSchema,
  GlobalProxyConfigSchema,
  ProviderAccountConfigSchema,
  redactProviderAccount,
} from "../../contracts/src/mod.ts";

import {
  type VirtualKey,
  VirtualKeySchema,
} from "../../governance/src/virtual_keys.ts";
import {
  type Customer,
  CustomerSchema,
  type Team,
  TeamSchema,
} from "../../governance/src/hierarchy.ts";
import {
  type MCPClientConfig,
  MCPClientConfigSchema,
} from "../../mcp/src/client.ts";

const PROVIDERS_PREFIX: StateKey = ["config", "providers"];
const SETTINGS_KEY: StateKey = ["config", "settings"];
const PRICING_KEY: StateKey = ["config", "pricing"];
const GLOBAL_PROXY_KEY: StateKey = ["config", "global-proxy"];
const VIRTUAL_KEYS_PREFIX: StateKey = ["governance", "virtual-keys"];
const USAGE_PREFIX: StateKey = ["governance", "usage"];
const COST_PREFIX: StateKey = ["governance", "cost"];
const TEAMS_PREFIX: StateKey = ["governance", "teams"];
const CUSTOMERS_PREFIX: StateKey = ["governance", "customers"];
const MCP_CLIENTS_PREFIX: StateKey = ["mcp", "clients"];

interface Settings {
  defaultProvider?: string;
}

/**
 * Durable control-plane configuration over a {@link StateStore}. CRUD
 * operations persist immediately; `loadAll` is the explicit reload point used
 * at boot and by POST /api/config/reload.
 *
 * The service is storage-agnostic on purpose: it is constructed with whichever
 * store the caller opened (Postgres in production, in-memory in unit tests), so
 * retiring Deno KV changed nothing in this file except the key type.
 */
export class ConfigService {
  /**
   * @param crypto Optional encryption-at-rest engine. When absent, every read
   * and write takes the byte-identical plaintext path (opt-in guarantee). When
   * present, secret fields are encrypted on write and decrypted on read at this
   * persistence boundary — transparent to callers and to the redacted public
   * views (which operate on the already-decrypted records).
   */
  constructor(private store: StateStore, private crypto?: ConfigCrypto) {}

  /**
   * Called after every mutation that changes CONFIG shape, so other processes
   * can re-read. Counter, anchor, and usage writers deliberately do not fire it:
   * they run on the request path and would fan out a reload per request.
   */
  #onMutation?: () => void | Promise<void>;

  /**
   * Registers the config-changed announcer. Set by `createDefaultContext` to
   * `InvalidationBus.publishConfigChanged`; unset in single-process tests, where
   * there is no peer to tell.
   */
  setMutationListener(
    listener: (() => void | Promise<void>) | undefined,
  ): void {
    this.#onMutation = listener;
  }

  /**
   * Never throws. The durable write has already committed; reporting the admin
   * call as failed because the fanout leg did would be wrong, and a retry would
   * double-apply. Staleness is bounded by the periodic reconcile instead.
   */
  async #announce(): Promise<void> {
    try {
      await this.#onMutation?.();
    } catch (error) {
      console.warn(
        `config change announcement failed; peers stay stale until the next ` +
          `reconcile: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Builds a service over a PROCESS-LOCAL store. This is the zero-infrastructure
   * path: unit tests, contract tests, and `createContext()` all use it, which is
   * what keeps `deno task test` runnable without Docker or a database.
   *
   * `name` addresses a store rather than a file. Reopening the same name returns
   * the same data, so tests that assert durability by closing and reopening
   * still measure what they intend. `:memory:` and no-argument are anonymous.
   *
   * Production does NOT call this: `createDefaultContext()` constructs
   * `new ConfigService(new PostgresStateStore(db))` directly.
   */
  static open(name?: string, crypto?: ConfigCrypto): Promise<ConfigService> {
    return Promise.resolve(
      new ConfigService(MemoryStateStore.named(name), crypto),
    );
  }

  /**
   * Attaches (or clears) the encryption engine after construction. Used by the
   * boot path, which opens the store, derives ConfigCrypto.fromEnv(raw()), then
   * attaches it before the first read. Passing undefined keeps plaintext mode.
   */
  setCrypto(crypto: ConfigCrypto | undefined): void {
    this.crypto = crypto;
  }

  /** Global egress settings are never permitted to fall back to plaintext. */
  hasActiveEncryption(): boolean {
    return this.crypto !== undefined;
  }

  async loadAll(): Promise<GatewayConfig> {
    const settings = await this.store.get<Settings>(SETTINGS_KEY) ?? {};
    const entries = await this.store.list<ProviderAccountConfig>(
      PROVIDERS_PREFIX,
    );
    const crypto = this.crypto;
    const providers = crypto
      ? await Promise.all(
        entries.map((e) => crypto.decryptRecord("provider", e.key, e.value)),
      )
      : entries.map((e) => e.value);
    return {
      defaultProvider: settings.defaultProvider,
      providers,
    };
  }

  async upsertProvider(config: ProviderAccountConfig): Promise<void> {
    const parsed = ProviderAccountConfigSchema.parse(config);
    const key: StateKey = [...PROVIDERS_PREFIX, parsed.id];
    await this.store.set(
      key,
      this.crypto
        ? await this.crypto.encryptRecord("provider", key, parsed)
        : parsed,
    );
    await this.#announce();
  }

  async getProvider(id: string): Promise<ProviderAccountConfig | null> {
    const key: StateKey = [...PROVIDERS_PREFIX, id];
    const value = await this.store.get<ProviderAccountConfig>(key);
    if (!value) return null;
    return this.crypto
      ? await this.crypto.decryptRecord("provider", key, value)
      : value;
  }

  async deleteProvider(id: string): Promise<void> {
    await this.store.delete([...PROVIDERS_PREFIX, id]);
    await this.#announce();
  }

  async setDefaultProvider(id: string | undefined): Promise<void> {
    const settings = await this.store.get<Settings>(SETTINGS_KEY) ?? {};
    await this.store.set(SETTINGS_KEY, { ...settings, defaultProvider: id });
    await this.#announce();
  }

  /** Encrypted, write-only-at-the-API global default for provider egress. */
  async getGlobalProxy(): Promise<GlobalProxyConfig | undefined> {
    const value = await this.store.get<GlobalProxyConfig>(GLOBAL_PROXY_KEY);
    if (!value) return undefined;
    if (!this.crypto) {
      throw new ConfigCryptoError(
        "Global proxy configuration requires FROSTY_ENCRYPTION_KEY.",
      );
    }
    const decrypted = await this.crypto.decryptRecord(
      "globalProxy",
      GLOBAL_PROXY_KEY,
      value,
    );
    return GlobalProxyConfigSchema.parse(decrypted);
  }

  async setGlobalProxy(config: GlobalProxyConfig): Promise<void> {
    if (!this.crypto) {
      throw new ConfigCryptoError(
        "Global proxy configuration requires FROSTY_ENCRYPTION_KEY.",
      );
    }
    const parsed = GlobalProxyConfigSchema.parse(config);
    await this.store.set(
      GLOBAL_PROXY_KEY,
      await this.crypto.encryptRecord("globalProxy", GLOBAL_PROXY_KEY, parsed),
    );
    await this.#announce();
  }

  async deleteGlobalProxy(): Promise<void> {
    await this.store.delete(GLOBAL_PROXY_KEY);
    await this.#announce();
  }

  async exportConfig(includeSecrets = false): Promise<ConfigExport> {
    const config = await this.loadAll();
    if (!includeSecrets) {
      // Redacted export must strip ALL secret fields (not just apiKey): route
      // through the canonical redaction so it never drifts from the public view
      // and never leaks AWS/GCP/proxy/cert secrets in a shareable export.
      config.providers = config.providers.map(
        (p) => redactProviderAccount(p) as unknown as ProviderAccountConfig,
      );
    }
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      config,
    };
  }

  /** Replaces the full provider set. Accepts a ConfigExport or a bare GatewayConfig. */
  async importConfig(data: unknown): Promise<GatewayConfig> {
    const asExport = ConfigExportSchema.safeParse(data);
    const config = asExport.success
      ? asExport.data.config
      : GatewayConfigSchema.parse(data);

    const existing = await this.store.list<ProviderAccountConfig>(
      PROVIDERS_PREFIX,
    );
    for (const entry of existing) {
      await this.store.delete(entry.key);
    }
    for (const provider of config.providers) {
      await this.upsertProvider(provider);
    }
    await this.setDefaultProvider(config.defaultProvider);
    return config;
  }

  async listVirtualKeys(): Promise<VirtualKey[]> {
    const entries = await this.store.list<VirtualKey>(VIRTUAL_KEYS_PREFIX);
    const crypto = this.crypto;
    return crypto
      ? await Promise.all(
        entries.map((e) => crypto.decryptRecord("virtualKey", e.key, e.value)),
      )
      : entries.map((e) => e.value);
  }

  async upsertVirtualKey(key: VirtualKey): Promise<void> {
    const parsed = VirtualKeySchema.parse(key);
    const kvKey: StateKey = [...VIRTUAL_KEYS_PREFIX, parsed.id];
    await this.store.set(
      kvKey,
      this.crypto
        ? await this.crypto.encryptRecord("virtualKey", kvKey, parsed)
        : parsed,
    );
    await this.#announce();
  }

  async deleteVirtualKey(id: string): Promise<void> {
    await this.store.delete([...VIRTUAL_KEYS_PREFIX, id]);
    await this.store.deleteCount([...USAGE_PREFIX, id]);
    await this.store.deleteCount([...COST_PREFIX, id]);
    await this.#announce();
  }

  /** Durable $-cost accounting (micro-USD atomic counters). */
  async addCost(keyId: string, microUsd: number): Promise<void> {
    if (microUsd > 0) {
      await this.store.sum([...COST_PREFIX, keyId], BigInt(microUsd));
    }
  }

  async loadCosts(): Promise<Record<string, number>> {
    const entries = await this.store.listCounts(COST_PREFIX);
    const costs: Record<string, number> = {};
    for (const entry of entries) {
      const id = String(entry.key[entry.key.length - 1]);
      costs[id] = entry.value;
    }
    return costs;
  }

  /**
   * Generic governance counters (hierarchy usage/cost): atomic u64 keyed by
   * ["governance", <kind>, id] — e.g. kind "team-usage" or "customer-cost".
   */
  async addCounter(kind: string, id: string, count: number): Promise<void> {
    if (count > 0) {
      await this.store.sum(["governance", kind, id], BigInt(count));
    }
  }

  async loadCounters(kind: string): Promise<Record<string, number>> {
    const entries = await this.store.listCounts(["governance", kind]);
    const counters: Record<string, number> = {};
    for (const entry of entries) {
      const id = String(entry.key[entry.key.length - 1]);
      counters[id] = entry.value;
    }
    return counters;
  }

  /**
   * Persists a window-anchor timestamp (a plain overwrite, not a sum) under
   * ["governance", <kind>-anchor, id]. Used so a windowed budget's reset
   * boundary survives a restart instead of re-anchoring to boot.
   */
  async setAnchor(
    kind: string,
    id: string,
    windowStart: number,
  ): Promise<void> {
    await this.store.set(["governance", `${kind}-anchor`, id], windowStart);
  }

  async loadAnchors(kind: string): Promise<Record<string, number>> {
    const entries = await this.store.list<number>([
      "governance",
      `${kind}-anchor`,
    ]);
    const anchors: Record<string, number> = {};
    for (const entry of entries) {
      const id = String(entry.key[entry.key.length - 1]);
      if (typeof entry.value === "number") {
        anchors[id] = entry.value;
      }
    }
    return anchors;
  }

  async listTeams(): Promise<Team[]> {
    const entries = await this.store.list<Team>(TEAMS_PREFIX);
    return entries.map((e) => e.value);
  }

  async upsertTeam(team: Team): Promise<void> {
    await this.store.set([...TEAMS_PREFIX, team.id], TeamSchema.parse(team));
    await this.#announce();
  }

  async deleteTeam(id: string): Promise<void> {
    await this.store.delete([...TEAMS_PREFIX, id]);
    await this.store.delete(["governance", "team-usage", id]);
    await this.store.delete(["governance", "team-cost", id]);
    await this.#announce();
  }

  async listCustomers(): Promise<Customer[]> {
    const entries = await this.store.list<Customer>(CUSTOMERS_PREFIX);
    return entries.map((e) => e.value);
  }

  async upsertCustomer(customer: Customer): Promise<void> {
    await this.store.set(
      [...CUSTOMERS_PREFIX, customer.id],
      CustomerSchema.parse(customer),
    );
    await this.#announce();
  }

  async deleteCustomer(id: string): Promise<void> {
    await this.store.delete([...CUSTOMERS_PREFIX, id]);
    await this.store.delete(["governance", "customer-usage", id]);
    await this.store.delete(["governance", "customer-cost", id]);
    await this.#announce();
  }

  /** Operator pricing overrides ({model: {inputPerMTokUsd, outputPerMTokUsd}}). */
  async loadPricing(): Promise<
    Record<string, { inputPerMTokUsd: number; outputPerMTokUsd: number }> | null
  > {
    return await this.store.get(PRICING_KEY);
  }

  async savePricing(
    prices: Record<
      string,
      { inputPerMTokUsd: number; outputPerMTokUsd: number }
    >,
  ): Promise<void> {
    await this.store.set(PRICING_KEY, prices);
    await this.#announce();
  }

  /**
   * Durable request-budget accounting (decision-log item 9 closure): usage is
   * an atomic KV counter per key, incremented fire-and-forget on admission
   * and rehydrated into the VirtualKeyManager at boot.
   */
  async addUsage(keyId: string, count = 1): Promise<void> {
    await this.store.sum([...USAGE_PREFIX, keyId], BigInt(count));
  }

  async loadUsage(): Promise<Record<string, number>> {
    const entries = await this.store.listCounts(USAGE_PREFIX);
    const usage: Record<string, number> = {};
    for (const entry of entries) {
      const id = String(entry.key[entry.key.length - 1]);
      usage[id] = entry.value;
    }
    return usage;
  }

  async listMCPClients(): Promise<MCPClientConfig[]> {
    const entries = await this.store.list<MCPClientConfig>(MCP_CLIENTS_PREFIX);
    const crypto = this.crypto;
    return crypto
      ? await Promise.all(
        entries.map((e) => crypto.decryptRecord("mcpClient", e.key, e.value)),
      )
      : entries.map((e) => e.value);
  }

  async upsertMCPClient(config: MCPClientConfig): Promise<void> {
    const parsed = MCPClientConfigSchema.parse(config);
    const key: StateKey = [...MCP_CLIENTS_PREFIX, parsed.id];
    await this.store.set(
      key,
      this.crypto
        ? await this.crypto.encryptRecord("mcpClient", key, parsed)
        : parsed,
    );
    await this.#announce();
  }

  async deleteMCPClient(id: string): Promise<void> {
    await this.store.delete([...MCP_CLIENTS_PREFIX, id]);
    await this.#announce();
  }

  /** Raw KV access for adjacent stores (durable log store). */
  raw(): StateStore {
    return this.store;
  }

  close(): void {
    this.store.close();
  }
}
