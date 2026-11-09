import { AsyncLocalStorage } from "node:async_hooks";
import { parseCustomHeaders } from "./clientConfig.js";

/**
 * Per-request settings. In HTTP (hosted, multi-tenant) mode every MCP request
 * carries its own Dokploy URL and API key, so nothing is read from process.env.
 */
export interface RequestContext {
  dokployUrl?: string | undefined;
  apiKey?: string | undefined;
  customHeaders?: Record<string, string> | undefined;
  toolPreset?: string | undefined;
  enabledTags?: string | undefined;
  disabledTags?: string | undefined;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export interface Credentials {
  dokployUrl: string;
  apiKey: string;
  customHeaders: Record<string, string>;
}

export class MissingCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingCredentialsError";
  }
}

export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

/** Builds a RequestContext from HTTP headers (names are case-insensitive). */
export function contextFromHeaders(get: (name: string) => string | undefined): RequestContext {
  const rawCustom = get("x-dokploy-custom-headers");
  return {
    dokployUrl: get("x-dokploy-url")?.trim() || undefined,
    apiKey: get("x-dokploy-api-key")?.trim() || undefined,
    customHeaders: rawCustom ? parseCustomHeaders(rawCustom) : undefined,
    toolPreset: get("x-dokploy-tool-preset")?.trim() || undefined,
    enabledTags: get("x-dokploy-enabled-tags")?.trim() || undefined,
    disabledTags: get("x-dokploy-disabled-tags")?.trim() || undefined,
  };
}

/**
 * Credentials for the current call. Inside an HTTP request they come only from
 * the request headers (never from the server environment, so a public instance
 * can't be used with the operator's key). In stdio mode they come from env.
 */
export function resolveCredentials(): Credentials {
  const ctx = getRequestContext();
  if (ctx) {
    if (!ctx.dokployUrl || !ctx.apiKey) {
      throw new MissingCredentialsError(
        "Missing credentials: send the X-Dokploy-Url and X-Dokploy-Api-Key headers with every MCP request.",
      );
    }
    return {
      dokployUrl: ctx.dokployUrl,
      apiKey: ctx.apiKey,
      customHeaders: ctx.customHeaders ?? {},
    };
  }
  const dokployUrl = process.env.DOKPLOY_URL;
  const apiKey = process.env.DOKPLOY_API_KEY;
  if (!dokployUrl || !apiKey) {
    throw new MissingCredentialsError(
      "Environment variables DOKPLOY_URL and DOKPLOY_API_KEY must be defined in stdio mode.",
    );
  }
  return {
    dokployUrl,
    apiKey,
    customHeaders: parseCustomHeaders(process.env.DOKPLOY_CUSTOM_HEADERS),
  };
}
