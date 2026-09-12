import {
  errorResponse,
  type Router,
  SideEffectDeniedError,
} from "../../../packages/core/src/mod.ts";
import type { AppContext } from "../context.ts";
import { jsonResponse, mapDispatchError, parseJsonBody } from "./helpers.ts";
import {
  buildVfs,
  normalizeBinding,
} from "../../../packages/mcp/src/codemode/vfs.ts";
import {
  codeModeExecutorEnabled,
  vfsSurfaceEnabled,
} from "../../../packages/mcp/src/codemode/flag.ts";
import {
  CodeModeBusyError,
  CodeModeTimeoutError,
  type CodeModeToolInfo,
  runCodeModeProgram,
} from "../../../packages/mcp/src/codemode/executor.ts";

/**
 * The PUBLIC tool catalog the worker's SDK is seeded from: `{ server,
 * qualifiedName }` only — the same names `GET /api/mcp/tools` exposes, no
 * schemas, no secrets (S-INV). Honors the registry's enabled + `toolsToExecute`
 * allowlists because `toolCatalog()` already does.
 */
export function codeModePublicCatalog(ctx: AppContext): CodeModeToolInfo[] {
  return ctx.mcp.toolCatalog().map((entry) => ({
    server: entry.clientId,
    qualifiedName: entry.qualifiedName,
  }));
}

/** Maps run-harness failures onto the canonical error envelope. */
export function mapCodeModeRunError(error: unknown): Response {
  if (error instanceof SideEffectDeniedError) {
    // Parity with the inference tool-loop: an unconfirmed side effect ⇒ 403.
    return errorResponse(403, error.message, "side_effect_denied");
  }
  if (error instanceof CodeModeTimeoutError) {
    return errorResponse(504, error.message, "code_mode_timeout");
  }
  if (error instanceof CodeModeBusyError) {
    return errorResponse(429, error.message, "code_mode_busy");
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    // The client ended the exchange mid-flight — not a denial (403), capacity
    // (429), or deadline (504). 499 (nginx's convention) is the precise,
    // non-confusable code; each of the four is guarded by a disjoint instanceof.
    return errorResponse(
      499,
      "Client closed request (Code Mode run aborted).",
      "client_closed_request",
    );
  }
  // GatewayError (e.g. malformed JSON body) → 400; anything else → 500 envelope.
  return mapDispatchError(error);
}

export function registerCodeModeRoutes(router: Router, ctx: AppContext): void {
  router.get("/api/mcp/codemode/vfs", async (req) => {
    // Optional operator switch to hide even the inert metadata surface.
    if (!vfsSurfaceEnabled()) {
      return errorResponse(
        404,
        "Code Mode VFS surface is disabled (FROSTY_CODE_MODE_VFS=off).",
        "not_found",
      );
    }
    ctx.metrics.increment("requests.codemode_vfs");
    const binding = normalizeBinding(
      new URL(req.url).searchParams.get("binding"),
    );
    const vfs = await buildVfs(ctx.mcp.toolCatalog(), binding);
    return jsonResponse(vfs);
  });

  router.post("/api/mcp/codemode/run", async (req) => {
    // Disabled path FIRST: no worker spawned, no code parsed, no tool executed
    // (design §3.6 refusal contract). Both gates (app gate on + capability probe
    // passed) must hold; either off ⇒ 403.
    if (!codeModeExecutorEnabled()) {
      ctx.metrics.increment("requests.codemode_run_denied");
      return errorResponse(
        403,
        "Code Mode executor is disabled (FROSTY_CODE_MODE=off); this is an " +
          "experimental, security-gated surface.",
        "code_mode_disabled",
      );
    }

    ctx.metrics.increment("requests.codemode_run");
    try {
      const body = await parseJsonBody(req) as { program?: unknown };
      const program = typeof body?.program === "string" ? body.program : "";
      if (!program) {
        return errorResponse(
          400,
          "Request body must include a non-empty string `program`.",
          "invalid_request_error",
          "program",
        );
      }
      // The confirm flag is REQUEST-sourced (never model/worker) — the sandbox
      // cannot forge it (broker reads only `sideEffectsConfirmed`).
      const sideEffectsConfirmed =
        req.headers.get("x-frosty-confirm-side-effects") === "true";
      const result = await runCodeModeProgram({
        program,
        sideEffectsConfirmed,
        executor: ctx.toolExecutor,
        catalog: codeModePublicCatalog(ctx),
        signal: req.signal,
      });
      return jsonResponse({ result });
    } catch (error) {
      // Observability parity with the denied path: count backpressure rejections
      // (bounded queue full -> 429 code_mode_busy). Response is unchanged.
      if (error instanceof CodeModeBusyError) {
        ctx.metrics.increment("requests.codemode_run_busy");
      }
      // Observability parity: count client-disconnect aborts (-> 499), mirroring
      // the busy counter. Response is unchanged.
      if (error instanceof DOMException && error.name === "AbortError") {
        ctx.metrics.increment("requests.codemode_run_aborted");
      }
      return mapCodeModeRunError(error);
    }
  });
}
