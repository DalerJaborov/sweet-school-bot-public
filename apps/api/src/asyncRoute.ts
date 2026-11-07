import type { Router, RequestHandler } from "express";

// Express 4 does not forward rejected handler promises to error middleware.
// Both already-registered layers and subsequent registrations must be protected.
type Layer = { handle: RequestHandler & { stack?: Layer[] }; route?: { stack: Layer[] } };
type Container = { stack?: Layer[] };
const patched = new WeakSet<object>();
const wrappers = new WeakMap<RequestHandler, RequestHandler>();
const methods = ["get", "post", "put", "patch", "delete", "head", "options", "all", "use", "route"];

function wrap(handler: RequestHandler): RequestHandler {
  // Express identifies error middleware by its four-argument signature.
  if (handler.length >= 4) return handler;
  const existing = wrappers.get(handler);
  if (existing) return existing;
  const wrapped: RequestHandler = (req, res, next) => {
    try {
      const result: unknown = handler(req, res, next);
      if (result != null && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch(next);
      }
    } catch (error) { next(error); }
  };
  wrappers.set(handler, wrapped);
  wrappers.set(wrapped, wrapped);
  return wrapped;
}

function protect(container: Container, visited = new Set<Layer[]>()): void {
  if (container.stack && !visited.has(container.stack)) {
    visited.add(container.stack);
    for (const layer of container.stack) {
      if (layer.route) protect(layer.route, visited);
      else if (Array.isArray(layer.handle.stack)) protect(layer.handle, visited);
      else layer.handle = wrap(layer.handle);
    }
  }
  if (patched.has(container)) return;
  patched.add(container);
  const mutable = container as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of methods) {
    const original = mutable[method];
    if (typeof original !== "function") continue;
    mutable[method] = function (...args: unknown[]) {
      const result = original.apply(container, args);
      // router.route(path).get(handler) registers on a Route, not on Router.
      if (method === "route" && result && typeof result === "object" && "stack" in result) {
        protect(result as Container);
      }
      protect(container);
      return result;
    };
  }
}

export function autoCatch(router: Router): Router {
  protect(router as unknown as Container);
  return router;
}
