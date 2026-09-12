import type {
  StateKey,
  StateStore,
} from "../../../packages/config/src/store.ts";
// Direct-path import (not via contracts/src/mod.ts): the mod re-export is an
// orchestrator-applied wiring line, so this module must compile without it.
import type { SettingsGroup } from "../../../packages/contracts/src/settings.ts";

/**
 * Durable operator-settings overrides on Deno KV. One key per group
 * (["settings", <group>]) holds a PARTIAL override object: only the fields the
 * operator has changed are stored, so untouched fields keep falling through to
 * the env/default layers (see apps/gateway/routes/settings.ts).
 *
 * A thin wrapper over the shared {@link StateStore} KV handle — it opens no
 * connection of its own (mirrors how LogStore reuses `ctx.config.raw()`), so it
 * lives alongside every other durable control-plane store.
 */
export class SettingsStore {
  constructor(private store: StateStore) {}

  private key(group: SettingsGroup): StateKey {
    return ["settings", group];
  }

  /** Current persisted override for one group (null when never set). */
  async getOverride(
    group: SettingsGroup,
  ): Promise<Record<string, unknown> | null> {
    return await this.store.get<Record<string, unknown>>(this.key(group));
  }

  /**
   * Shallow-merges a partial override into the group's stored override and
   * persists the result. Field-level replace semantics: arrays and scalars are
   * overwritten wholesale (matching PUT-a-field intent), never deep-merged.
   * Returns the merged override that is now durable.
   */
  async merge(
    group: SettingsGroup,
    partial: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const existing = (await this.getOverride(group)) ?? {};
    const merged = { ...existing, ...partial };
    await this.store.set(this.key(group), merged);
    return merged;
  }
}
