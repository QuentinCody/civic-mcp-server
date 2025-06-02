import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { JsonToSqlDO } from "./do.js";

// ========================================
// API CONFIGURATION - Customize for your GraphQL API
// ========================================
const API_CONFIG = {
	name: "CivicExplorer",
	version: "0.1.0",
	description: "MCP Server for querying GraphQL APIs and converting responses to queryable SQLite tables",
	
	// GraphQL API settings
	endpoint: 'https://civicdb.org/api/graphql',
	headers: {
		"Accept": 'application/vnd.civicdb.v2+json', // API-specific version header
		"User-Agent": "MCPCivicServer/0.1.0"
	},
	
	// Tool names and descriptions
	tools: {
		graphql: {
			name: "civic_graphql_query",
			description: "Executes GraphQL queries against CIViC API (V2), processes responses into SQLite tables, and returns metadata for subsequent SQL querying. Returns a data_access_id and schema information."
		},
		sql: {
			name: "civic_query_sql", 
			description: "Execute read-only SQL queries against staged data. Use the data_access_id from civic_graphql_query to query the SQLite tables."
		}
	}
};

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

export class CivicMCP extends McpAgent {
	server = new McpServer({
		name: API_CONFIG.name,
		version: API_CONFIG.version,
		description: API_CONFIG.description
	});

	async init() {
		// Tool #1: GraphQL to SQLite staging
		this.server.tool(
			API_CONFIG.tools.graphql.name,
			API_CONFIG.tools.graphql.description,
			{
				query: z.string().describe("GraphQL query string"),
				variables: z.record(z.any()).optional().describe("Optional variables for the GraphQL query"),
			},
			async ({ query, variables }) => {
				try {
					const graphqlResult = await this.executeGraphQLQuery(query, variables);
					
					if (graphqlResult.errors && !graphqlResult.data) {
						return { content: [{ type: "text" as const, text: JSON.stringify(graphqlResult, null, 2) }] };
					}
					
					const stagingResult = await this.stageDataInDurableObject(graphqlResult);
					return { content: [{ type: "text" as const, text: JSON.stringify(stagingResult, null, 2) }] };
					
				} catch (error) {
					return this.createErrorResponse("GraphQL execution failed", error);
				}
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
			async ({ data_access_id, sql }) => {
				try {
					const queryResult = await this.executeSQLQuery(data_access_id, sql);
					return { content: [{ type: "text" as const, text: JSON.stringify(queryResult, null, 2) }] };
				} catch (error) {
					return this.createErrorResponse("SQL execution failed", error);
				}
			}
		);
	}

	// ========================================
	// GRAPHQL CLIENT - Customize headers/auth as needed
	// ========================================
	private async executeGraphQLQuery(query: string, variables?: Record<string, any>): Promise<any> {
		const headers = {
			"Content-Type": "application/json",
			...API_CONFIG.headers
		};
		
		const body = { query, ...(variables && { variables }) };
		
		const response = await fetch(API_CONFIG.endpoint, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		});
		
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`HTTP ${response.status}: ${errorText}`);
		}
		
		return await response.json();
	}

	// ========================================
	// DURABLE OBJECT INTEGRATION - Use this.env directly
	// ========================================
	private async stageDataInDurableObject(graphqlResult: any): Promise<any> {
		const env = this.env as CivicEnv;
		if (!env?.JSON_TO_SQL_DO) {
			throw new Error("JSON_TO_SQL_DO binding not available");
		}
		
		const accessId = crypto.randomUUID();
		const doId = env.JSON_TO_SQL_DO.idFromName(accessId);
		const stub = env.JSON_TO_SQL_DO.get(doId);
		
		const response = await stub.fetch("http://do/process", {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(graphqlResult)
		});
		
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`DO staging failed: ${errorText}`);
		}
		
		const processingResult = await response.json();
		return {
			data_access_id: accessId,
			processing_details: processingResult
		};
	}

	private async executeSQLQuery(dataAccessId: string, sql: string): Promise<any> {
		const env = this.env as CivicEnv;
		if (!env?.JSON_TO_SQL_DO) {
			throw new Error("JSON_TO_SQL_DO binding not available");
		}
		
		const doId = env.JSON_TO_SQL_DO.idFromName(dataAccessId);
		const stub = env.JSON_TO_SQL_DO.get(doId);
		
		const response = await stub.fetch("http://do/query", {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sql })
		});
		
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`SQL execution failed: ${errorText}`);
		}
		
		return await response.json();
	}

	// ========================================
	// ERROR HANDLING - Reusable
	// ========================================
	private createErrorResponse(message: string, error: unknown) {
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({
					success: false,
					error: message,
					details: error instanceof Error ? error.message : String(error)
				}, null, 2)
			}]
		};
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

		if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
			// @ts-ignore - SSE transport handling
			return CivicMCP.serveSSE("/sse").fetch(request, env, ctx);
		}
		
		return new Response(
			`${API_CONFIG.name} - Available on /sse endpoint`, 
			{ status: 404, headers: { "Content-Type": "text/plain" } }
		);
	},
};

export { CivicMCP as MyMCP };
export { JsonToSqlDO };