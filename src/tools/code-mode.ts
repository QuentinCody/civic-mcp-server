/**
 * CIViC Code Mode — registers the civic_execute tool for full GraphQL API access.
 *
 * The V8 isolate gets gql.query() for GraphQL execution and schema.* helpers
 * for introspection-based discovery. CIViC-specific quirks are documented
 * in the preamble so the LLM can avoid common pitfalls.
 */

import type { SourceDescriptor } from "@bio-mcp/shared";
import { createGraphqlExecuteTool } from "@bio-mcp/shared/codemode/graphql-execute-tool";
import type { McpServer } from "@bio-mcp/shared/mcp";
import { createCivicGqlFetch } from "../utils/code-mode-fetch.js";
import { CIVIC_PROFILE_PREAMBLE } from "../utils/profile-preamble.js";

// Verifiable provenance: the canonical CIViC source descriptor, shared by the
// civic_execute Code Mode tool and the civic_graphql_query passthrough so both
// stamp _meta.citation identically (single source of truth — avoids drift).
export const CIVIC_SOURCE: SourceDescriptor = {
	id: "civic",
	name: "CIViC",
	url: "https://civicdb.org",
	license: "CC0 1.0",
};

// CIViC-specific quirks and helpers injected into the V8 isolate
const CIVIC_PREAMBLE = `
// --- CIViC quirks ---
// Gene lookup uses entrezSymbol, NOT symbol:
//   gql.query('{ gene(entrezSymbol: "EGFR") { id name } }')
// Genes by list: gql.query('{ genes(entrezSymbols: ["EGFR","BRAF"]) { nodes { id name } } }')
//
// Filtering variants by gene uses the CIViC gene ID (integer), NOT a symbol:
//   Step 1: const g = await gql.query('{ gene(entrezSymbol: "BRAF") { id } }');
//   Step 2: if (g.__staged) return g; // inspect the staged handle before continuing
//   Step 3: if (!g.gene) return g; // gql.query returns data directly, with no .data wrapper
//   Step 4: const v = await gql.query('query($id:Int!){ variants(geneId:$id,first:10) { nodes { id name } } }', {id:g.gene.id});
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
		// Verifiable provenance: civic_execute results carry a _meta.citation.
		source: CIVIC_SOURCE,
		apiName: "CIViC",
		gqlFetch,
		doNamespace: env.JSON_TO_SQL_DO,
		loader: env.CODE_MODE_LOADER,
		preamble: CIVIC_PREAMBLE + CIVIC_PROFILE_PREAMBLE,
		stagingThreshold: 1024, // CIViC's existing 1KB threshold
	});

	executeTool.register(server as unknown as { tool: (...args: unknown[]) => void });
}
