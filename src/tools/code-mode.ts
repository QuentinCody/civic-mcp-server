/**
 * CIViC Code Mode — registers the civic_execute tool for full GraphQL API access.
 *
 * The V8 isolate gets gql.query() for GraphQL execution and schema.* helpers
 * for introspection-based discovery. CIViC-specific quirks are documented
 * in the preamble so the LLM can avoid common pitfalls.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createGraphqlExecuteTool } from "@bio-mcp/shared/codemode/graphql-execute-tool";
import type { GraphqlFetchFn } from "@bio-mcp/shared/codemode/graphql-introspection";

const CIVIC_ENDPOINT = "https://civicdb.org/api/graphql";

// CIViC-specific quirks and helpers injected into the V8 isolate
const CIVIC_PREAMBLE = `
// --- CIViC quirks ---
// Gene lookup uses entrezSymbol, NOT symbol:
//   gql.query('{ gene(entrezSymbol: "EGFR") { id name } }')
// Genes by list: gql.query('{ genes(entrezSymbols: ["EGFR","BRAF"]) { nodes { id name } } }')
//
// Variants require gene ID (integer), NOT gene symbol:
//   Step 1: const g = await gql.query('{ gene(entrezSymbol: "BRAF") { id } }');
//   Step 2: const v = await gql.query('{ variants(geneId: ' + g.data.gene.id + ') { nodes { id name } } }');
//
// EvidenceItem.status is a scalar enum (string), NOT an object.
//   Correct: status (returns string like "ACCEPTED")
//   WRONG: status { name } — this will error
//
// Known field name mappings (common mistakes):
//   direction -> evidenceDirection (on EvidenceItem)
//   level -> evidenceLevel
//   type -> evidenceType
//   direction -> assertionDirection (on Assertion)
//   type -> assertionType
//   cytobands -> cytogeneticRegions (on Region)
//   iscn -> iscnName (on RegionVariant)
//
// Feature types: Gene, Factor, Fusion, Region
// Regions represent chromosome/cytoband-level features (e.g., 17p Deletion)
// Region variants carry ISCN notation in their 'iscnName' field
//
// Region lookup: gql.query('{ region(id: 62862) { id name featureType cytogeneticRegions { chromosome band } } }')
// Cytoband typeahead: gql.query('{ cytogeneticRegionTypeahead(queryTerm: "17p") { id name chromosome band } }')
`;

function createCivicGqlFetch(): GraphqlFetchFn {
	return async (query: string, variables?: Record<string, unknown>) => {
		const response = await fetch(CIVIC_ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Accept": "application/vnd.civicdb.v2+json",
				"User-Agent": "MCPCivicServer/0.2.0",
			},
			body: JSON.stringify({ query, ...(variables && { variables }) }),
		});
		return await response.json();
	};
}

interface CivicCodeModeEnv {
	JSON_TO_SQL_DO: DurableObjectNamespace;
	CODE_MODE_LOADER: { get: (...args: unknown[]) => unknown };
}

/**
 * Register civic_execute tool on the MCP server.
 */
export function registerCodeMode(
	server: McpServer,
	env: CivicCodeModeEnv,
): void {
	const gqlFetch = createCivicGqlFetch();

	const executeTool = createGraphqlExecuteTool({
		prefix: "civic",
		apiName: "CIViC",
		gqlFetch,
		doNamespace: env.JSON_TO_SQL_DO,
		loader: env.CODE_MODE_LOADER,
		preamble: CIVIC_PREAMBLE,
		stagingThreshold: 1024, // CIViC's existing 1KB threshold
	});

	executeTool.register(server as unknown as { tool: (...args: unknown[]) => void });
}
