import { assert, assertEquals } from "@std/assert";
import { loadProvidersFromEnv } from "./env.ts";
import type { ProviderAccountConfig } from "../../contracts/src/mod.ts";

// Every env var the three generic providers consume. Snapshotted and cleared
// around each case so an ambient environment cannot make these assertions
// spuriously pass or fail, then restored verbatim afterwards.
const GENERIC_ENV_KEYS = [
  "OPENAI_COMPAT_BASE_URL",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_DEFAULT_MODEL",
  "ANTHROPIC_COMPAT_BASE_URL",
  "ANTHROPIC_COMPAT_API_KEY",
  "ANTHROPIC_COMPAT_DEFAULT_MODEL",
  "LMSTUDIO_BASE_URL",
  "LMSTUDIO_API_KEY",
  "LMSTUDIO_DEFAULT_MODEL",
] as const;

function withEnv(vars: Record<string, string>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of GENERIC_ENV_KEYS) {
    saved.set(key, Deno.env.get(key));
    Deno.env.delete(key);
  }
  try {
    for (const [key, value] of Object.entries(vars)) {
      Deno.env.set(key, value);
    }
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

function find(
  configs: ProviderAccountConfig[],
  id: string,
): ProviderAccountConfig | undefined {
  return configs.find((c) => c.id === id);
}

Deno.test("openai-compatible registers only when OPENAI_COMPAT_BASE_URL is set", () => {
  withEnv({}, () => {
    assertEquals(find(loadProvidersFromEnv(), "openai-compatible"), undefined);
  });
  withEnv({
    OPENAI_COMPAT_BASE_URL: "https://compat.example/v1",
    OPENAI_COMPAT_API_KEY: "sk-compat",
    OPENAI_COMPAT_DEFAULT_MODEL: "custom-model",
  }, () => {
    const cfg = find(loadProvidersFromEnv(), "openai-compatible");
    assert(cfg, "expected an openai-compatible account");
    assertEquals(cfg.type, "openai-compatible");
    assertEquals(cfg.baseUrl, "https://compat.example/v1");
    assertEquals(cfg.apiKey, "sk-compat");
    assertEquals(cfg.models, ["custom-model"]);
    assertEquals(cfg.enabled, true);
    assertEquals(cfg.priority, 0);
  });
});

Deno.test("openai-compatible defaults to an empty key and empty model list", () => {
  withEnv({ OPENAI_COMPAT_BASE_URL: "https://compat.example/v1" }, () => {
    const cfg = find(loadProvidersFromEnv(), "openai-compatible");
    assert(cfg);
    assertEquals(cfg.apiKey, "");
    assertEquals(cfg.models, []);
  });
});

Deno.test("anthropic-compatible registers only when ANTHROPIC_COMPAT_BASE_URL is set", () => {
  withEnv({}, () => {
    assertEquals(
      find(loadProvidersFromEnv(), "anthropic-compatible"),
      undefined,
    );
  });
  withEnv({
    ANTHROPIC_COMPAT_BASE_URL: "https://anthropic.example",
    ANTHROPIC_COMPAT_API_KEY: "sk-ant-compat",
    ANTHROPIC_COMPAT_DEFAULT_MODEL: "claude-custom",
  }, () => {
    const cfg = find(loadProvidersFromEnv(), "anthropic-compatible");
    assert(cfg, "expected an anthropic-compatible account");
    assertEquals(cfg.type, "anthropic-compatible");
    assertEquals(cfg.baseUrl, "https://anthropic.example");
    assertEquals(cfg.apiKey, "sk-ant-compat");
    assertEquals(cfg.models, ["claude-custom"]);
    assertEquals(cfg.enabled, true);
  });
});

Deno.test("anthropic-compatible defaults to an empty key and empty model list", () => {
  withEnv({ ANTHROPIC_COMPAT_BASE_URL: "https://anthropic.example" }, () => {
    const cfg = find(loadProvidersFromEnv(), "anthropic-compatible");
    assert(cfg);
    assertEquals(cfg.apiKey, "");
    assertEquals(cfg.models, []);
  });
});

Deno.test("lmstudio registers when either its base URL or default model is set", () => {
  withEnv({}, () => {
    assertEquals(find(loadProvidersFromEnv(), "lmstudio"), undefined);
  });
  // The default model alone triggers registration; the base URL falls back to
  // the local LM Studio default.
  withEnv({ LMSTUDIO_DEFAULT_MODEL: "local-model" }, () => {
    const cfg = find(loadProvidersFromEnv(), "lmstudio");
    assert(cfg, "expected an lmstudio account");
    assertEquals(cfg.type, "lmstudio");
    assertEquals(cfg.baseUrl, "http://localhost:1234/v1");
    assertEquals(cfg.apiKey, "");
    assertEquals(cfg.models, ["local-model"]);
  });
  // A base URL alone also triggers it, with an empty model list and the key
  // passed through when supplied.
  withEnv({
    LMSTUDIO_BASE_URL: "http://127.0.0.1:5000/v1",
    LMSTUDIO_API_KEY: "lm-key",
  }, () => {
    const cfg = find(loadProvidersFromEnv(), "lmstudio");
    assert(cfg);
    assertEquals(cfg.baseUrl, "http://127.0.0.1:5000/v1");
    assertEquals(cfg.apiKey, "lm-key");
    assertEquals(cfg.models, []);
  });
});
