import { defineConfig } from "@playwright/test";

// Browser tests run against an ALREADY-DEPLOYED gateway (the docker compose
// stack by default) — never a mock or a dev server, so a green run is
// evidence about the shipped container (grilling G8). Chromium-only per
// decision D12; point FROSTY_BASE_URL elsewhere to retarget.
export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  retries: 1,
  workers: 1, // tests share one live gateway's control-plane state
  reporter: [["list"]],
  use: {
    baseURL: process.env.FROSTY_BASE_URL ?? "http://localhost:8080",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
