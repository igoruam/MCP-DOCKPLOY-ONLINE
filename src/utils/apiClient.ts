import axios, { type AxiosInstance } from "axios";
import { getSettings } from "./clientConfig.js";
import type { Credentials } from "./context.js";
import { createLogger } from "./logger.js";
import { assertSafeDokployUrl, guardedHttpAgent, guardedHttpsAgent } from "./urlGuard.js";

const logger = createLogger("AxiosClient");

/** Builds an axios client bound to one caller's Dokploy instance and API key. */
export function createApiClient(credentials: Credentials): AxiosInstance {
  const url = assertSafeDokployUrl(credentials.dokployUrl);
  const { timeout } = getSettings();

  const client = axios.create({
    baseURL: `${url.origin}${url.pathname.replace(/\/+$/, "")}/api`,
    timeout,
    maxRedirects: 0, // a redirect could point at an internal address
    httpAgent: guardedHttpAgent,
    httpsAgent: guardedHttpsAgent,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...credentials.customHeaders,
      "x-api-key": credentials.apiKey,
    },
  });

  client.interceptors.response.use(
    (response) => {
      logger.info("API request completed", {
        method: response.config.method?.toUpperCase(),
        url: response.config.url,
        status: response.status,
      });
      return response;
    },
    (error) => {
      logger.error("API request failed", {
        method: error.config?.method?.toUpperCase(),
        url: error.config?.url,
        status: error.response?.status,
        message: error.response?.data?.message ?? error.message,
      });
      return Promise.reject(error);
    },
  );

  return client;
}
