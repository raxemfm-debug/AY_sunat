import type { IncomingMessage, ServerResponse } from "node:http";
import type { PublicUser } from "../../modules/auth/types.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Usuario autenticado. Siempre presente salvo en rutas públicas. */
  user?: PublicUser;
  /** Hash del token de la sesión actual (para cerrar sesión). */
  sessionTokenHash?: string;
}

export type RouteHandler = (context: RouteContext) => Promise<void>;

export interface RouteOptions {
  /** Ruta accesible sin sesión (inicio de sesión, registro). Por defecto toda ruta exige sesión. */
  public?: boolean;
}

interface Route {
  method: HttpMethod;
  segments: string[];
  handler: RouteHandler;
  public: boolean;
}

export type RouteMatch =
  | { kind: "found"; handler: RouteHandler; params: Record<string, string>; public: boolean }
  | { kind: "method_not_allowed" }
  | { kind: "not_found" };

const PARAM_VALUE = /^[A-Za-z0-9._-]{1,128}$/;

/** Enrutador mínimo: rutas en orden de registro, parámetros `:nombre` validados por formato. */
export class Router {
  private readonly routes: Route[] = [];

  on(method: HttpMethod, pattern: string, handler: RouteHandler, options: RouteOptions = {}): this {
    this.routes.push({ method, segments: pattern.split("/").filter(Boolean), handler, public: options.public === true });
    return this;
  }

  match(method: string, pathname: string): RouteMatch {
    const parts = pathname.split("/").filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      pathMatched = true;
      if (route.method === method) return { kind: "found", handler: route.handler, params, public: route.public };
    }
    return pathMatched ? { kind: "method_not_allowed" } : { kind: "not_found" };
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
