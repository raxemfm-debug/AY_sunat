import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "./http-utils.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
}

export type RouteHandler = (context: RouteContext) => Promise<void>;

interface Route {
  method: HttpMethod;
  segments: string[];
  handler: RouteHandler;
}

const PARAM_VALUE = /^[A-Za-z0-9._-]{1,128}$/;

/** Enrutador mínimo: rutas en orden de registro, parámetros `:nombre` validados por formato. */
export class Router {
  private readonly routes: Route[] = [];

  on(method: HttpMethod, pattern: string, handler: RouteHandler): this {
    this.routes.push({ method, segments: pattern.split("/").filter(Boolean), handler });
    return this;
  }

  /** Devuelve el handler y sus parámetros, o null si ninguna ruta coincide con la ruta. */
  match(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
    const parts = pathname.split("/").filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      pathMatched = true;
      if (route.method === method) return { handler: route.handler, params };
    }
    if (pathMatched) throw new ApiError(405, "METHOD_NOT_ALLOWED", "Método no permitido para esta ruta.");
    return null;
  }
}

function matchSegments(segments: string[], parts: string[]): Record<string, string> | null {
  if (segments.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (segment.startsWith(":")) {
      let value: string;
      try {
        value = decodeURIComponent(parts[index]);
      } catch {
        return null;
      }
      if (!PARAM_VALUE.test(value)) return null;
      params[segment.slice(1)] = value;
    } else if (segment !== parts[index]) {
      return null;
    }
  }
  return params;
}
