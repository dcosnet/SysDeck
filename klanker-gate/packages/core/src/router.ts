import { errorResponse } from "./errors.ts";

type Handler = (
  req: Request,
  match: URLPatternResult,
) => Response | Promise<Response>;

export class Router {
  private routes: { method: string; pattern: URLPattern; handler: Handler }[] =
    [];

  add(method: string, pathname: string, handler: Handler) {
    this.routes.push({
      method,
      pattern: new URLPattern({ pathname }),
      handler,
    });
  }

  get(pathname: string, handler: Handler) {
    this.add("GET", pathname, handler);
  }

  post(pathname: string, handler: Handler) {
    this.add("POST", pathname, handler);
  }

  put(pathname: string, handler: Handler) {
    this.add("PUT", pathname, handler);
  }

  delete(pathname: string, handler: Handler) {
    this.add("DELETE", pathname, handler);
  }

  async handle(req: Request): Promise<Response> {
    for (const route of this.routes) {
      if (route.method === req.method || route.method === "ANY") {
        const match = route.pattern.exec(req.url);
        if (match) {
          return await route.handler(req, match);
        }
      }
    }
    const pathname = new URL(req.url).pathname;
    // Path known but method not registered: 405 with an Allow header.
    // (An explicitly registered handler for the method wins above.)
    const allowed = [
      ...new Set(
        this.routes
          .filter((route) => route.pattern.test(req.url))
          .map((route) => route.method.toUpperCase()),
      ),
    ];
    if (allowed.length > 0) {
      const allow = allowed.join(", ");
      const res = errorResponse(
        405,
        `Method ${req.method} not allowed for ${pathname}. Allowed: ${allow}.`,
      );
      res.headers.set("Allow", allow);
      return res;
    }
    return errorResponse(404, `No route for ${req.method} ${pathname}.`);
  }
}
