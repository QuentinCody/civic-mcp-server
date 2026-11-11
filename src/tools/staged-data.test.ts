import {expect, it} from "vitest";
import type {McpServer} from "@bio-mcp/shared/mcp";
import {registerStagedData} from "./staged-data";

it("registers both standard tool pairs and returns complete missing-storage errors", async () => {
  type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<Record<string, unknown>>;
  const handlers = new Map<string, Handler>();
  const server = {tool: (name: string, _description: string, _schema: unknown, handler: Handler) => handlers.set(name, handler)};
  registerStagedData(server as unknown as McpServer, {});
  expect([...handlers.keys()].sort()).toEqual(["civic_get_schema", "civic_query_data", "mcp_civic_get_schema", "mcp_civic_query_data"]);
  for (const handler of handlers.values()) {
    const result = await handler({data_access_id: "missing", sql: "SELECT 1"}, {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({success: false, error: {code: "DATA_ACCESS_ERROR"}});
    expect(Array.isArray(result.content)).toBe(true);
  }
});
