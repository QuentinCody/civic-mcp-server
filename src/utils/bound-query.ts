import { pullBoundedRows, pullSignals, queryCostError, readOnlySqlError } from "@bio-mcp/shared/staging/query-endpoint";

type Execute = (sql: string, ...bindings: string[]) => Parameters<typeof pullBoundedRows>[0];

/** SQLite binds values; never interpolate them into the SQL program. */
export function boundQuery(input: unknown, execute: Execute): Response {
  try {
    const {sql, params} = input as {sql?: unknown; params?: unknown};
    if (typeof sql !== "string" || !Array.isArray(params) || params.length > 1000 || params.some(value => typeof value !== "string")) throw new Error("Expected SQL and at most 1000 string bindings");
    const body = {sql};
    const blocked = readOnlySqlError(body) ?? queryCostError(body);
    if (blocked) return Response.json(blocked, {status: 400});
    const pull = pullBoundedRows(execute(sql, ...params));
    if (pull.cost_error) return Response.json({success: false, code: "QUERY_COST_LIMIT", error: pull.cost_error}, {status: 400});
    return Response.json({success: true, results: pull.rows, row_count: pull.rows.length, ...pullSignals(pull)});
  } catch (error) {
    return Response.json({success: false, error: error instanceof Error ? error.message : "Bound query failed"}, {status: 400});
  }
}
