import type { GraphqlFetchFn } from "@bio-mcp/shared/codemode/graphql-introspection";

export function createCivicGqlFetch(): GraphqlFetchFn {
  return async (query, variables) => {
    const response = await fetch("https://civicdb.org/api/graphql", {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
      headers: {
        "Content-Type": "application/json", Accept: "application/vnd.civicdb.v2+json",
        "User-Agent": "MCPCivicServer/0.2.0",
      },
      body: JSON.stringify({ query, ...(variables && { variables }) }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`CIViC HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("CIViC returned no response body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    let text = "";
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8_000_000) throw new Error("CIViC response exceeds 8MB; narrow the query");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => undefined); }
    const envelope: unknown = JSON.parse(text);
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("CIViC returned an invalid GraphQL envelope");
    const result = envelope as Record<string, unknown>;
    const hasData = result.data && typeof result.data === "object" && !Array.isArray(result.data);
    if (!hasData && !(Array.isArray(result.errors) && result.errors.length)) throw new Error("CIViC returned neither GraphQL data nor errors");
    // The shared proxy retains partial errors and handles pure GraphQL failures.
    return result;
  };
}
