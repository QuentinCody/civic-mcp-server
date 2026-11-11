import type { McpServer } from "@bio-mcp/shared/mcp";
import { createGetSchemaHandler, createQueryDataHandler } from "@bio-mcp/shared/staging/utils";
import { z } from "zod";
import { civicResponse, type CivicDataEnv } from "../utils/tool-result.js";

function registerQuery(server: McpServer, env: CivicDataEnv) {
  const handler = createQueryDataHandler("JSON_TO_SQL_DO", "civic");
  for (const name of ["civic_query_data", "mcp_civic_query_data"]) server.tool(name,
    "Run bounded read-only SQL against staged CIViC data. Use get_schema to inspect tables; payloads preserves the full original response.",
    {data_access_id: z.string().min(1), sql: z.string().min(1), limit: z.number().int().positive().max(10000).optional()},
    async (args, extra) => civicResponse(() => handler(args, env), env, name, extra));
}

export function registerStagedData(server: McpServer, env: CivicDataEnv) {
  registerQuery(server, env);
  const handler = createGetSchemaHandler("JSON_TO_SQL_DO", "civic");
  for (const name of ["civic_get_schema", "mcp_civic_get_schema"]) server.tool(name,
    "Inspect staged CIViC tables and columns, or omit data_access_id to list datasets in this request's scope.",
    {data_access_id: z.string().min(1).optional()},
    async (args, extra) => civicResponse(() => handler(args, env, extra), env, name, extra));
}
