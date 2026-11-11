import { shouldStage, stageToDoAndRespond } from "@bio-mcp/shared/staging/utils";

type Result = { [key: string]: unknown; content: Array<{type: "text"; text: string}>;
  structuredContent: Record<string, unknown>; isError?: boolean };
export type CivicDataEnv = {JSON_TO_SQL_DO?: Parameters<typeof stageToDoAndRespond>[1]};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Preserve complete legacy responses while enforcing the MCP byte and error contracts. */
export async function civicResponse(work: () => Promise<Omit<Result, "structuredContent"> & {structuredContent?: Record<string, unknown>}>, env: CivicDataEnv, toolName: string, extra: unknown): Promise<Result> {
  try {
    const value = await work();
    const original = {...value, structuredContent: value.structuredContent ?? {success: value.isError !== true}} as Result;
    const failed = original.isError === true || original.structuredContent.success === false;
    const result = {...original, ...(failed ? {isError: true} : {})};
    if (!shouldStage(bytes(result))) return result;
    if (!env.JSON_TO_SQL_DO) throw new Error("Missing staging storage");
    const staged = await stageToDoAndRespond(result, env.JSON_TO_SQL_DO, "civic", undefined,
      {toolName, serverName: "civic"}, "civic", extra as Parameters<typeof stageToDoAndRespond>[6]);
    const structuredContent = {success: !failed, staged: true, data: undefined,
      data_access_id: staged.dataAccessId, _staging: staged._staging, _meta: result.structuredContent._meta};
    if (bytes(structuredContent) > 100000) throw new Error("Staging metadata exceeds transport limit");
    return {content: [{type: "text", text: "Response staged. Use civic_query_sql; payloads retains the complete original response."}],
      structuredContent, ...(failed ? {isError: true} : {})};
  } catch {
    return {content: [{type: "text", text: "CIViC response could not be returned."}],
      structuredContent: {success: false, error: {code: "RESPONSE_ERROR", message: "CIViC response could not be returned."}}, isError: true};
  }
}
