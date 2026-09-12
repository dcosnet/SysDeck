import type { CompletionRequest } from "../../../packages/contracts/src/mod.ts";
import {
  ChatCompletionRequestSchema,
  CompletionRequestSchema,
  EmbeddingRequestSchema,
} from "../../../packages/contracts/src/mod.ts";
import { GatewayError, type Router } from "../../../packages/core/src/mod.ts";
import type { AppContext } from "../context.ts";
import {
  mapDispatchError,
  parseJsonBody,
  validationErrorResponse,
} from "./helpers.ts";
import { runChatCompletion, runCompletion } from "./inference.ts";

/**
 * Deployment id from a raw `/openai/deployments/{deployment}/...` pathname.
 * Governance imports this so admission sees the EXACT string this file
 * dispatches; an undecodable segment yields undefined (deny) there and a 400
 * here.
 */
export function azureDeploymentFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/openai\/deployments\/([^/?]+)\//);
  if (!match) {
    return undefined;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

/**
 * Percent-decoded `:deployment` group. URLPattern hands groups back RAW, so
 * `a%2Fb` arrives still encoded; a malformed escape is a client error.
 */
function deploymentFromMatch(match: URLPatternResult): string {
  const raw = match.pathname.groups.deployment ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new GatewayError(
      400,
      "Azure deployment path segment is not valid percent-encoding.",
      "invalid_request_error",
      "deployment",
    );
  }
}

/**
 * Body with `model` forced to the URL deployment. Azure routes on the URL, so a
 * body `model` is ignored rather than merged.
 */
function withDeployment(
  body: unknown,
  deployment: string,
): Record<string, unknown> {
  const raw = body !== null && typeof body === "object"
    ? body as Record<string, unknown>
    : {};
  return { ...raw, model: deployment };
}

/**
 * Azure OpenAI deployment-scoped ingress: the inverse of the Azure egress
 * adapter. Azure's newer undated `/openai/v1/*` family needs no routes here -
 * the compat prefix rewrite already strips `/openai` before `/v1/*`.
 */
export function registerAzureIngressRoutes(
  router: Router,
  ctx: AppContext,
): void {
  // `?api-version=` is accepted with ANY value and ignored; the resolved
  // account's own configured version governs egress.
  router.post(
    "/openai/deployments/:deployment/chat/completions",
    async (req, match) => {
      ctx.metrics.increment("requests.compat.azure");
      try {
        const deployment = deploymentFromMatch(match);
        const parsed = ChatCompletionRequestSchema.safeParse(
          withDeployment(await parseJsonBody(req), deployment),
        );
        if (!parsed.success) {
          return validationErrorResponse(parsed.error);
        }
        return await runChatCompletion(ctx, req, parsed.data);
      } catch (error) {
        return mapDispatchError(error);
      }
    },
  );

  router.post(
    "/openai/deployments/:deployment/completions",
    async (req, match) => {
      ctx.metrics.increment("requests.compat.azure");
      try {
        const deployment = deploymentFromMatch(match);
        const parsed = CompletionRequestSchema.safeParse(
          withDeployment(await parseJsonBody(req), deployment),
        );
        if (!parsed.success) {
          return validationErrorResponse(parsed.error);
        }
        return await runCompletion(ctx, req, parsed.data as CompletionRequest);
      } catch (error) {
        return mapDispatchError(error);
      }
    },
  );

  router.post(
    "/openai/deployments/:deployment/embeddings",
    async (req, match) => {
      ctx.metrics.increment("requests.compat.azure");
      try {
        const deployment = deploymentFromMatch(match);
        const parsed = EmbeddingRequestSchema.safeParse(
          withDeployment(await parseJsonBody(req), deployment),
        );
        if (!parsed.success) {
          return validationErrorResponse(parsed.error);
        }
        const target = ctx.providers.resolve(parsed.data.model);
        if (
          !target.capabilities.supportsEmbeddings || !target.adapter.embeddings
        ) {
          throw new GatewayError(
            400,
            `Provider "${target.providerId}" does not support embeddings.`,
            "invalid_request_error",
          );
        }
        return await target.adapter.embeddings(
          { ...parsed.data, model: target.model },
          { signal: req.signal },
        );
      } catch (error) {
        return mapDispatchError(error);
      }
    },
  );
}
