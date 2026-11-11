import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { buildGraphqlProxySource } from "@bio-mcp/shared/codemode/graphql-proxy";
import { createStageProxyTool } from "@bio-mcp/shared/tools/api-proxy";
import { createGraphqlProxyTool } from "@bio-mcp/shared/tools/graphql-proxy";
import { afterEach, expect, it, vi } from "vitest";
import { createCivicGqlFetch } from "./code-mode-fetch";
import { CIVIC_PROFILE_PREAMBLE } from "./profile-preamble";

afterEach(() => vi.unstubAllGlobals());
const ctx = { sql: () => [] };
const json = (value: unknown) => new Response(JSON.stringify(value));
const recipe = readFileSync(new NodeURL("../../README.md", import.meta.url), "utf8")
  .split("<!-- civic-assertion-evidence-example -->")[1].split("```js\n")[1].split("```")[0];
function execute(code: string, proxy: ReturnType<typeof createGraphqlProxyTool>, stage?: ReturnType<typeof createStageProxyTool>) {
  return new Function("codemode", `var __stagedResults=[]; ${buildGraphqlProxySource()} ${CIVIC_PROFILE_PREAMBLE} return (async () => {${code}})();`)({
    __graphql_proxy: (input: Record<string, unknown>) => proxy.handler(input, ctx),
    __stage_proxy: (input: Record<string, unknown>) => stage?.handler(input, ctx),
  });
}

it("executes the README relationship recipe preserving distinct profiles and exact continuation", async () => {
  const data = { assertion: { id: 456, molecularProfile: { id: 100, rawName: "1 AND 2" } }, evidenceItems: { totalCount: 9, pageInfo: { hasNextPage: true, endCursor: "opaque+/=" }, nodes: [{ id: 1, molecularProfile: { id: 101, rawName: "1" }, status: "REJECTED", evidenceDirection: "DOES_NOT_SUPPORT", source: { retracted: true } }] } };
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    const request = JSON.parse(String(options.body));
    expect(request.variables).toEqual({ id: 456, first: 5, after: null, status: "ALL" });
    expect(request.query).toContain("evidenceItems(assertionId: $id");
    expect(request.query).not.toContain("molecularProfileId: $id");
    return json({ data });
  });
  vi.stubGlobal("fetch", fetcher);
  const proxy = createGraphqlProxyTool({ gqlFetch: createCivicGqlFetch(), stagingPrefix: "civic", stagingThreshold: 1024 });
  const result = await execute(recipe, proxy);
  expect(result).toMatchObject(data);
  expect(result.next).toEqual({ assertionId: 456, options: { first: 5, after: "opaque+/=", status: "ALL" } });
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each([32_000, 110_000])("stages profile/Boolean/source/error data losslessly through real proxies (%i chars)", async size => {
  const data = { assertion: { id: 456, molecularProfile: { rawName: "(1 OR 2) AND NOT 3", description: "α".repeat(size), variants: [{ feature: { featureType: "REGION" }, iscnName: "del(17p)" }] } }, evidenceItems: { totalCount: 9, pageInfo: { hasNextPage: true, endCursor: "opaque+/=" }, nodes: [{ id: 1, status: "REJECTED", molecularProfile: { id: 101 }, source: { retracted: true } }] } };
  const stored: unknown[] = [];
  const ns = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/process") {
        stored.push((await request.json() as { data: unknown }).data);
        return json({ success: true, tables_created: ["evidence"], total_rows: 1, input_rows: 1, table_row_counts: { evidence: 1 } });
      }
      if (path === "/schema") return json({ success: true, schema: { tables: { evidence: { columns: [{ name: "id" }] } } } });
      return json({ success: true });
    } }),
  };
  vi.stubGlobal("fetch", vi.fn(async () => json({ data, errors: [{ message: "partial source failure" }] })));
  const proxy = createGraphqlProxyTool({ gqlFetch: createCivicGqlFetch(), doNamespace: ns, stagingPrefix: "civic", stagingThreshold: 1024 });
  const stage = createStageProxyTool({ doNamespace: ns, stagingPrefix: "civic" });
  const result = await execute(recipe, proxy, stage);
  expect(result).toMatchObject({ __staged: true, data_access_id: expect.stringMatching(/^civic_/), _staging: expect.any(Object) });
  expect(stored).toHaveLength(2); // Canonical raw JSON and table-inference input.
  expect(typeof stored[0]).toBe("string");
  expect(JSON.parse(stored[0] as string)).toEqual(stored[1]);
  expect(stored[1]).toMatchObject({ ...data, __errors: [{ message: "partial source failure" }] });
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(30 * 1024);
});

it("retains partial results in the documented recipe and throws pure GraphQL errors", async () => {
  const partial = { data: { assertion: null, evidenceItems: null }, errors: [{ message: "partial" }] };
  vi.stubGlobal("fetch", vi.fn(async () => json(partial)));
  const proxy = createGraphqlProxyTool({ gqlFetch: createCivicGqlFetch(), stagingPrefix: "civic" });
  expect(await execute(recipe, proxy)).toMatchObject({ assertion: null, evidenceItems: null, __errors: partial.errors });
  vi.stubGlobal("fetch", vi.fn(async () => json({ errors: [{ message: "schema mismatch" }] })));
  await expect(execute(recipe, proxy)).rejects.toThrow("schema mismatch");
});
