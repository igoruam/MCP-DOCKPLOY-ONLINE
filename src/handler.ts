import type { ToolDefinition } from "./types.js";
import { createApiClient } from "./utils/apiClient.js";
import { getSettings } from "./utils/clientConfig.js";
import { MissingCredentialsError, resolveCredentials } from "./utils/context.js";
import { createLogger } from "./utils/logger.js";
import { redactSensitive } from "./utils/redactSensitive.js";
import { ResponseFormatter } from "./utils/responseFormatter.js";

const logger = createLogger("ToolHandler");

export function createHandler(tool: ToolDefinition) {
  return async (input: Record<string, unknown>) => {
    const { redactEnv, redactFields } = getSettings();
    const redact = <T>(value: T): T => (redactEnv ? redactSensitive(value, redactFields) : value);

    try {
      // Tool inputs can contain personal data (names, emails): never log them.
      logger.info(`Executing tool: ${tool.name}`);

      const apiClient = createApiClient(resolveCredentials());
      const response =
        tool.method === "GET"
          ? await apiClient.get(tool.path, { params: input })
          : await apiClient.post(tool.path, input);

      return ResponseFormatter.success(
        `${tool.name} completed successfully`,
        redact(response.data),
      );
    } catch (error) {
      logger.error(`Tool execution failed: ${tool.name}`, {
        error: error instanceof Error ? error.message : "Unknown error",
      });

      if (error instanceof MissingCredentialsError) {
        return ResponseFormatter.error("Missing Dokploy credentials", error.message);
      }

      if (error instanceof Error) {
        if (error.message.includes("401") || error.message.includes("Unauthorized")) {
          return ResponseFormatter.error(
            `Authentication failed for ${tool.name}`,
            "The Dokploy API key was rejected. Check the API key configured in the plugin.",
          );
        }
        if (error.message.includes("404") || error.message.includes("Not Found")) {
          return ResponseFormatter.error(
            "Resource not found",
            `The requested resource for ${tool.name} could not be found`,
          );
        }
      }

      return ResponseFormatter.error(
        `Failed to execute ${tool.name}`,
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  };
}
