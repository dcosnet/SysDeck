import type { MCPRegistry } from "./registry.ts";
import type { MCPClient, MCPToolInfo } from "./client.ts";

export interface MCPHealth {
  clientId: string;
  status: "healthy" | "unhealthy" | "disconnected" | "disabled";
  toolCount: number;
  consecutiveFailures: number;
  lastError?: string;
  lastCheckedAt: string;
}

/**
 * Consecutive sync failures before a client is declared disconnected and a
 * reconnect is attempted. Kept above 1 so a single transient blip stays
 * "unhealthy" rather than triggering a teardown.
 */
export const DEFAULT_FAILURE_THRESHOLD = 3;

export class MCPHealthMonitor {
  private health = new Map<string, MCPHealth>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private registry: MCPRegistry,
    private failureThreshold: number = DEFAULT_FAILURE_THRESHOLD,
  ) {}

  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => {
      this.checkAll().catch(() => {});
    }, intervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Re-syncs every configured client and records health per client. */
  async checkAll(): Promise<MCPHealth[]> {
    const now = new Date().toISOString();
    for (const client of this.registry.list()) {
      const id = client.config.id;
      const prior = this.health.get(id);
      if (!client.config.enabled) {
        this.health.set(id, {
          clientId: id,
          status: "disabled",
          toolCount: 0,
          consecutiveFailures: 0,
          lastCheckedAt: now,
        });
        continue;
      }
      try {
        const tools = await client.sync();
        this.health.set(id, {
          clientId: id,
          status: "healthy",
          toolCount: tools.length,
          consecutiveFailures: 0,
          lastCheckedAt: now,
        });
      } catch (error) {
        const failures = (prior?.consecutiveFailures ?? 0) + 1;
        const message = error instanceof Error ? error.message : String(error);
        if (failures >= this.failureThreshold) {
          const recovered = await this.reconnect(client);
          if (recovered) {
            this.health.set(id, {
              clientId: id,
              status: "healthy",
              toolCount: recovered.length,
              consecutiveFailures: 0,
              lastCheckedAt: now,
            });
          } else {
            this.health.set(id, {
              clientId: id,
              status: "disconnected",
              toolCount: 0,
              consecutiveFailures: failures,
              lastError: message,
              lastCheckedAt: now,
            });
          }
        } else {
          this.health.set(id, {
            clientId: id,
            status: "unhealthy",
            toolCount: 0,
            consecutiveFailures: failures,
            lastError: message,
            lastCheckedAt: now,
          });
        }
      }
    }
    // Drop records for removed clients.
    const known = new Set(this.registry.list().map((c) => c.config.id));
    for (const id of this.health.keys()) {
      if (!known.has(id)) {
        this.health.delete(id);
      }
    }
    return this.statuses();
  }

  /**
   * Tears down the client's transport and attempts a fresh sync. Returns the
   * refreshed tools on success, or null when the server is still unreachable.
   */
  private async reconnect(client: MCPClient): Promise<MCPToolInfo[] | null> {
    try {
      await client.dispose();
    } catch {
      // A dispose failure must not mask the reconnect result below.
    }
    try {
      return await client.sync();
    } catch {
      return null;
    }
  }

  statuses(): MCPHealth[] {
    return [...this.health.values()];
  }
}
