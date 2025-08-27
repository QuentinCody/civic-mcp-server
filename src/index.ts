import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { JsonToSqlDO } from "./do.js";
import { GraphQLClient, GraphQLClientConfig } from "./utils/graphql-client.js";
import { ErrorHandler } from "./utils/error-handling.js";
import { GraphQLTool, GraphQLToolConfig } from "./tools/graphql-tool.js";
import { SQLTool, SQLToolConfig } from "./tools/sql-tool.js";
import { VariantAssertionsTool, VariantAssertionsToolConfig } from "./tools/variant-assertions-tool.js";
import { VariantEvidenceTool, VariantEvidenceToolConfig } from "./tools/variant-evidence-tool.js";

// ========================================
// API CONFIGURATION - Customize for your GraphQL API
// ========================================
const API_CONFIG = {
	name: "CivicExplorer",
	version: "0.1.0",
	description: "MCP Server for querying GraphQL APIs and converting responses to queryable SQLite tables",

	// Staging configuration
	stagingThresholdBytes: 1024, // Stage responses larger than 1KB

	// GraphQL API settings
	endpoint: 'https://civicdb.org/api/graphql',
	headers: {
		"Accept": 'application/vnd.civicdb.v2+json', // API-specific version header
		"User-Agent": "MCPCivicServer/0.1.0"
	},
	
	// Tool definitions with enhanced descriptions including annotations
	tools: {
		graphql: {
			name: 'civic_graphql_query',
			description: `Execute GraphQL queries against the CIViC API, automatically staging large datasets in SQLite for subsequent analysis.
			
🏷️ TOOL ANNOTATIONS:
• Type: Non-destructive, Non-idempotent, Open-world
• Interactions: External API calls to CIViC GraphQL endpoint
• Side Effects: May create temporary SQLite tables for large datasets
• Caching: None (fresh data on each query)
• Rate Limits: Subject to CIViC API rate limits
• MCP 2025-06-18 Compliant: ✅`,
			
			annotations: {
				destructive: false,
				idempotent: false,
				cacheable: false,
				world_interaction: "open",
				side_effects: ["creates_temporary_data", "external_api_calls"],
				resource_usage: "network_io_heavy"
			}
		},
		sql: {
			name: 'civic_query_sql',
			description: `Execute read-only SQL queries against staged CIViC data in SQLite. Use the data_access_id from a GraphQL query to access the corresponding dataset.
			
🏷️ TOOL ANNOTATIONS:
• Type: Read-only, Idempotent, Closed-world  
• Interactions: Local SQLite database queries only
• Side Effects: None (read-only operations)
• Caching: Data is pre-staged and cached
• Rate Limits: None (local operations)
• MCP 2025-06-18 Compliant: ✅`,
			
			annotations: {
				destructive: false,
				idempotent: true,
				cacheable: true,
				world_interaction: "closed",
				side_effects: [],
				resource_usage: "low"
			}
		},
		variant_assertions: {
			name: 'get_variant_assertions',
			description: `Retrieve CIViC assertions for a molecular profile by ID or name. Returns assertion data directly without SQLite staging.
			
🏷️ TOOL ANNOTATIONS:
• Type: Non-destructive, Idempotent, Open-world
• Interactions: Direct CIViC GraphQL API calls
• Side Effects: None (direct response, bypasses staging)
• Caching: None (fresh data on each query)
• Rate Limits: Subject to CIViC API rate limits
• MCP 2025-06-18 Compliant: ✅`,
			
			annotations: {
				destructive: false,
				idempotent: true,
				cacheable: false,
				world_interaction: "open",
				side_effects: ["external_api_calls"],
				resource_usage: "network_io_light"
			}
		},
		variant_evidence: {
			name: 'get_variant_evidence',
			description: `Retrieve up to 10 evidence items for a CIViC molecular profile by ID or name. Returns evidence data directly without SQLite staging.
			
🏷️ TOOL ANNOTATIONS:
• Type: Non-destructive, Idempotent, Open-world
• Interactions: Direct CIViC GraphQL API calls
• Side Effects: None (direct response, bypasses staging)
• Caching: None (fresh data on each query)
• Rate Limits: Subject to CIViC API rate limits
• MCP 2025-06-18 Compliant: ✅`,
			
			annotations: {
				destructive: false,
				idempotent: true,
				cacheable: false,
				world_interaction: "open",
				side_effects: ["external_api_calls"],
				resource_usage: "network_io_light"
			}
		}
	}
};

// In-memory registry of staged datasets
const datasetRegistry = new Map<string, { created: string; table_count?: number; total_rows?: number }>();

// ========================================
// ENVIRONMENT INTERFACE
// ========================================
interface CivicEnv {
	MCP_HOST?: string;
	MCP_PORT?: string;
	JSON_TO_SQL_DO: DurableObjectNamespace;
}

// ========================================
// CORE MCP SERVER CLASS - Reusable template
// ========================================

// Environment storage for tool access
let currentEnvironment: Env | null = null;

function setGlobalEnvironment(env: Env) {
	currentEnvironment = env;
}

function getGlobalEnvironment(): Env | null {
	return currentEnvironment;
}

export class CivicMCP extends McpAgent {
	server = new McpServer({
		name: API_CONFIG.name,
		version: API_CONFIG.version,
		description: API_CONFIG.description
	});

	private graphqlClient!: GraphQLClient;
	private errorHandler!: ErrorHandler;
	private graphqlTool!: GraphQLTool;
	private sqlTool!: SQLTool;
	private variantAssertionsTool!: VariantAssertionsTool;
	private variantEvidenceTool!: VariantEvidenceTool;

	async init() {
		// Initialize GraphQL client and tools
		const graphqlConfig: GraphQLClientConfig = {
			endpoint: API_CONFIG.endpoint,
			headers: API_CONFIG.headers
		};
		this.graphqlClient = new GraphQLClient(graphqlConfig);
		this.errorHandler = new ErrorHandler(this.graphqlClient);
		
		// Initialize tools
		this.graphqlTool = new GraphQLTool(
			this.graphqlClient,
			{
				name: API_CONFIG.tools.graphql.name,
				description: API_CONFIG.tools.graphql.description,
				stagingThresholdBytes: API_CONFIG.stagingThresholdBytes,
				annotations: API_CONFIG.tools.graphql.annotations
			} as GraphQLToolConfig,
			datasetRegistry
		);
		
		this.sqlTool = new SQLTool(
			this.graphqlClient,
			{
				name: API_CONFIG.tools.sql.name,
				description: API_CONFIG.tools.sql.description,
				annotations: API_CONFIG.tools.sql.annotations
			} as SQLToolConfig
		);
		
		this.variantAssertionsTool = new VariantAssertionsTool(
			this.graphqlClient,
			{
				name: API_CONFIG.tools.variant_assertions.name,
				description: API_CONFIG.tools.variant_assertions.description,
				annotations: API_CONFIG.tools.variant_assertions.annotations
			} as VariantAssertionsToolConfig
		);
		
		this.variantEvidenceTool = new VariantEvidenceTool(
			this.graphqlClient,
			{
				name: API_CONFIG.tools.variant_evidence.name,
				description: API_CONFIG.tools.variant_evidence.description,
				annotations: API_CONFIG.tools.variant_evidence.annotations
			} as VariantEvidenceToolConfig
		);

		// Tool #1: GraphQL to SQLite staging
		this.server.tool(
			API_CONFIG.tools.graphql.name,
			API_CONFIG.tools.graphql.description,
			{
				query: z.string().describe("GraphQL query string"),
				variables: z.record(z.any()).optional().describe("Optional variables for the GraphQL query"),
			},
			async ({ query, variables }) => {
				return await this.graphqlTool.execute({ query, variables }, this.env);
			}
		);

		// Tool #2: SQL querying against staged data
		this.server.tool(
			API_CONFIG.tools.sql.name,
			API_CONFIG.tools.sql.description,
			{
				data_access_id: z.string().describe("Data access ID from the GraphQL query tool"),
				sql: z.string().describe("SQL SELECT query to execute"),
				params: z.array(z.string()).optional().describe("Optional query parameters"),
			},
			async ({ data_access_id, sql, params }) => {
				return await this.sqlTool.execute({ data_access_id, sql, params }, this.env);
			}
		);

		// Tool #3: Get variant assertions (bypasses staging)
		this.server.tool(
			API_CONFIG.tools.variant_assertions.name,
			API_CONFIG.tools.variant_assertions.description,
			{
				molecular_profile_id: z.number().optional().describe("CIViC molecular profile ID (numeric)"),
				molecular_profile_name: z.string().optional().describe("CIViC molecular profile name (string)")
			},
			async ({ molecular_profile_id, molecular_profile_name }) => {
				return await this.variantAssertionsTool.execute({ molecular_profile_id, molecular_profile_name });
			}
		);

		// Tool #4: Get variant evidence (bypasses staging)
		this.server.tool(
			API_CONFIG.tools.variant_evidence.name,
			API_CONFIG.tools.variant_evidence.description,
			{
				molecular_profile_id: z.number().optional().describe("CIViC molecular profile ID (numeric)"),
				molecular_profile_name: z.string().optional().describe("CIViC molecular profile name (string)"),
				limit: z.number().max(50).default(10).describe("Maximum number of evidence items to return (max 50, default 10)")
			},
			async ({ molecular_profile_id, molecular_profile_name, limit = 10 }) => {
				return await this.variantEvidenceTool.execute({ molecular_profile_id, molecular_profile_name, limit });
			}
		);
	}

	// Keep the dataset deletion utility method
	private async deleteDataset(dataAccessId: string): Promise<boolean> {
		const env = this.env as CivicEnv;
		if (!env?.JSON_TO_SQL_DO) {
			throw new Error("JSON_TO_SQL_DO binding not available");
		}

		const doId = env.JSON_TO_SQL_DO.idFromName(dataAccessId);
		const stub = env.JSON_TO_SQL_DO.get(doId);

		const response = await stub.fetch("http://do/delete", { method: 'DELETE' });

		return response.ok;
	}
}

// ========================================
// CLOUDFLARE WORKERS BOILERPLATE - Simplified
// ========================================
interface Env {
	MCP_HOST?: string;
	MCP_PORT?: string;
	JSON_TO_SQL_DO: DurableObjectNamespace;
}

interface ExecutionContext {
	waitUntil(promise: Promise<any>): void;
	passThroughOnException(): void;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		setGlobalEnvironment(env);

		// Handle standard MCP requests
		if (url.pathname.startsWith("/mcp")) {
			// @ts-ignore
			return CivicMCP.serve("/mcp").fetch(request, env, ctx);
		}

		if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
			// @ts-ignore - SSE transport handling
			return CivicMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		return new Response(
			`${API_CONFIG.name} - Available on /sse and /mcp endpoints`,
			{ status: 404, headers: { "Content-Type": "text/plain" } }
		);
	},
};

export { CivicMCP as MyMCP };
export { JsonToSqlDO };