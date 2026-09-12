// Canonical OpenAI-style error envelope used by every gateway surface.

export class GatewayError extends Error {
  constructor(
    public status: number,
    message: string,
    public type: string = "invalid_request_error",
    public param?: string,
    public code?: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export function errorResponse(
  status: number,
  message: string,
  type = "invalid_request_error",
  param?: string,
  code?: string,
): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type,
        param: param ?? null,
        code: code ?? null,
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

export function gatewayErrorResponse(err: GatewayError): Response {
  return errorResponse(err.status, err.message, err.type, err.param, err.code);
}
