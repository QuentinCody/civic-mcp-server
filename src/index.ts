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
	
	// MCP Specification Compliance
	mcpSpecVersion: "2025-06-18",
	features: {
		structuredToolOutput: true,
		metaFields: true,
		protocolVersionHeaders: true,
		titleFields: true,
		toolAnnotations: true
	},
	
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
                                const startTime = Date.now();
                                try {
                                        const graphqlResult = await this.executeGraphQLQuery(query, variables);
                                        const executionTime = Date.now() - startTime;

                                        if (this.shouldBypassStaging(graphqlResult, query)) {
                                                // For bypassed queries (like introspection), return as structured JSON
                                                return {
                                                        content: [{
                                                                type: "text" as const,
                                                                text: JSON.stringify(graphqlResult, null, 2)
                                                        }],
                                                        _meta: {
                                                                bypassed: true,
                                                                reason: this.getBypassReason(graphqlResult, query),
                                                                execution_time_ms: executionTime,
                                                                query_type: "graphql",
                                                                has_errors: !!(graphqlResult.errors && graphqlResult.errors.length > 0),
                                                                is_introspection: this.isIntrospectionQuery(query)
                                                        }
                                                };
                                        }

                                        const stagingResult = await this.stageDataInDurableObject(graphqlResult);
                                        
                                        // Return structured response with comprehensive metadata
                                        return {
                                                content: [{
                                                        type: "text" as const,
                                                        text: JSON.stringify(stagingResult, null, 2)
                                                }],
                                                _meta: {
                                                        data_access_id: stagingResult.data_access_id,
                                                        query_type: "graphql",
                                                        execution_time_ms: executionTime,
                                                        staging_bypassed: false,
                                                        tables_created: stagingResult.processing_details?.tables_created || [],
                                                        table_count: stagingResult.processing_details?.table_count || 0,
                                                        total_rows: stagingResult.processing_details?.total_rows || 0,
                                                        has_errors: false,
                                                        query_size_bytes: JSON.stringify(graphqlResult).length
                                                }
                                        };

                                } catch (error) {
                                        const executionTime = Date.now() - startTime;
                                        return this.createErrorResponse("GraphQL execution failed", error, executionTime);
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
				const startTime = Date.now();
				try {
					const queryResult = await this.executeSQLQuery(data_access_id, sql);
					const executionTime = Date.now() - startTime;
					
					return { 
						content: [{ 
							type: "text" as const, 
							text: JSON.stringify(queryResult, null, 2) 
						}],
						_meta: {
							data_access_id,
							query_type: queryResult.query_type || "select",
							execution_time_ms: executionTime,
							row_count: queryResult.row_count || 0,
							column_count: queryResult.column_names?.length || 0,
							chunked_content_resolved: queryResult.chunked_content_resolved || false,
							sql_query_length: sql.length,
							has_results: (queryResult.row_count || 0) > 0
						}
					};
				} catch (error) {
					const executionTime = Date.now() - startTime;
					return this.createErrorResponse("SQL execution failed", error, executionTime);
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

        private isIntrospectionQuery(query: string): boolean {
                if (!query) return false;
                
                // Remove comments and normalize whitespace for analysis
                const normalizedQuery = query
                        .replace(/\s*#.*$/gm, '') // Remove comments
                        .replace(/\s+/g, ' ')     // Normalize whitespace
                        .trim()
                        .toLowerCase();
                
                // Check for common introspection patterns
                const introspectionPatterns = [
                        '__schema',           // Schema introspection
                        '__type',            // Type introspection
                        '__typename',        // Typename introspection
                        'introspectionquery', // Named introspection queries
                        'getintrospectionquery'
                ];
                
                return introspectionPatterns.some(pattern => 
                        normalizedQuery.includes(pattern)
                );
        }

        private shouldBypassStaging(result: any, originalQuery?: string): boolean {
                if (!result) return true;

                // Bypass if this was an introspection query
                if (originalQuery && this.isIntrospectionQuery(originalQuery)) {
                        return true;
                }

                // Bypass if GraphQL reported errors
                if (result.errors) {
                        return true;
                }

                // Check if response contains introspection-like data structure
                if (result.data) {
                        // Common introspection response patterns
                        if (result.data.__schema || result.data.__type) {
                                return true;
                        }
                        
                        // Check for schema metadata structures
                        const hasSchemaMetadata = Object.values(result.data).some((value: any) => {
                                if (value && typeof value === 'object') {
                                        // Look for typical schema introspection fields
                                        const keys = Object.keys(value);
                                        const schemaFields = ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'];
                                        const typeFields = ['name', 'kind', 'description', 'fields', 'interfaces', 'possibleTypes', 'enumValues', 'inputFields'];
                                        
                                        return schemaFields.some(field => keys.includes(field)) ||
                                               typeFields.filter(field => keys.includes(field)).length >= 2;
                                }
                                return false;
                        });
                        
                        if (hasSchemaMetadata) {
                                return true;
                        }
                }

                // Only bypass very small payloads (reduced threshold for better staging)
                try {
                        if (JSON.stringify(result).length < 500) {
                                return true;
                        }
                } catch {
                        return true;
                }

                // Detect mostly empty data objects
                if (result.data) {
                        const values = Object.values(result.data);
                        const hasContent = values.some((v) => {
                                if (v === null || v === undefined) return false;
                                if (Array.isArray(v)) return v.length > 0;
                                if (typeof v === "object") return Object.keys(v).length > 0;
                                return true;
                        });
                        if (!hasContent) return true;
                }

                return false;
        }

        private getBypassReason(result: any, originalQuery?: string): string {
                if (!result) return "null_or_empty_result";
                
                if (originalQuery && this.isIntrospectionQuery(originalQuery)) {
                        return "introspection_query";
                }
                
                if (result.errors) {
                        return "graphql_errors_present";
                }
                
                if (result.data) {
                        if (result.data.__schema || result.data.__type) {
                                return "schema_introspection_response";
                        }
                        
                        const values = Object.values(result.data);
                        const hasContent = values.some((v) => {
                                if (v === null || v === undefined) return false;
                                if (Array.isArray(v)) return v.length > 0;
                                if (typeof v === "object") return Object.keys(v).length > 0;
                                return true;
                        });
                        if (!hasContent) return "empty_data_content";
                }
                
                try {
                        if (JSON.stringify(result).length < 500) {
                                return "small_payload_size";
                        }
                } catch {
                        return "serialization_error";
                }
                
                return "unknown_bypass_reason";
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
		
                const processingResult = await response.json() as any;
                datasetRegistry.set(accessId, {
                        created: new Date().toISOString(),
                        table_count: processingResult.table_count,
                        total_rows: processingResult.total_rows
                });
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
		
		// Use enhanced SQL execution that automatically resolves chunked content
		const response = await stub.fetch("http://do/query-enhanced", {
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

	// ========================================
	// ERROR HANDLING - Reusable
	// ========================================
	private createErrorResponse(message: string, error: unknown, executionTime?: number) {
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({
					success: false,
					error: message,
					details: error instanceof Error ? error.message : String(error),
					timestamp: new Date().toISOString()
				}, null, 2)
			}],
			_meta: {
				error: true,
				error_type: error instanceof Error ? error.constructor.name : "UnknownError",
				execution_time_ms: executionTime || 0,
				timestamp: new Date().toISOString()
			}
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

                // Handle SSE transport with protocol version header support
                // TODO: Update to Streamable HTTP transport per MCP 2025-03-26 specification
                if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
                        // Extract protocol version from request headers (MCP 2025-06-18 requirement)
                        const protocolVersion = request.headers.get("MCP-Protocol-Version");
                        
                        // Note: Current implementation uses SSE transport 
                        // Should be updated to use Streamable HTTP transport as per MCP 2025-03-26
                        // @ts-ignore - SSE transport handling - needs architectural update
                        const response = await CivicMCP.serveSSE("/sse").fetch(request, env, ctx);
                        
                        // Add protocol version header to response if provided in request
                        if (protocolVersion && response instanceof Response) {
                                const headers = new Headers(response.headers);
                                headers.set("MCP-Protocol-Version", protocolVersion);
                                return new Response(response.body, {
                                        status: response.status,
                                        statusText: response.statusText,
                                        headers
                                });
                        }
                        
                        return response;
                }

                if (url.pathname === "/datasets" && request.method === "GET") {
                        const list = Array.from(datasetRegistry.entries()).map(([id, info]) => ({
                                data_access_id: id,
                                ...info
                        }));
                        return new Response(JSON.stringify({ datasets: list }, null, 2), {
                                headers: { "Content-Type": "application/json" }
                        });
                }

                if (url.pathname.startsWith("/datasets/") && request.method === "DELETE") {
                        const id = url.pathname.split("/")[2];
                        if (!id || !datasetRegistry.has(id)) {
                                return new Response(JSON.stringify({ error: "Dataset not found" }), {
                                        status: 404,
                                        headers: { "Content-Type": "application/json" }
                                });
                        }

                        const doId = env.JSON_TO_SQL_DO.idFromName(id);
                        const stub = env.JSON_TO_SQL_DO.get(doId);
                        const resp = await stub.fetch("http://do/delete", { method: "DELETE" });
                        if (resp.ok) {
                                datasetRegistry.delete(id);
                                return new Response(JSON.stringify({ success: true }), {
                                        headers: { "Content-Type": "application/json" }
                                });
                        }

                        const text = await resp.text();
                        return new Response(JSON.stringify({ success: false, error: text }), {
                                status: 500,
                                headers: { "Content-Type": "application/json" }
                        });
                }

                // Schema initialization endpoint
                if (url.pathname === "/initialize-schema" && request.method === "POST") {
                        const globalDoId = env.JSON_TO_SQL_DO.idFromName("global-schema-config");
                        const stub = env.JSON_TO_SQL_DO.get(globalDoId);
                        const resp = await stub.fetch("http://do/initialize-schema", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: await request.text()
                        });
                        return new Response(await resp.text(), {
                                status: resp.status,
                                headers: { "Content-Type": "application/json" }
                        });
                }

                // Chunking stats endpoint
                if (url.pathname === "/chunking-stats" && request.method === "GET") {
                        const globalDoId = env.JSON_TO_SQL_DO.idFromName("global-schema-config");
                        const stub = env.JSON_TO_SQL_DO.get(globalDoId);
                        const resp = await stub.fetch("http://do/chunking-stats");
                        return new Response(await resp.text(), {
                                status: resp.status,
                                headers: { "Content-Type": "application/json" }
                        });
                }

                // Chunking analysis endpoint
                if (url.pathname === "/chunking-analysis" && request.method === "GET") {
                        const globalDoId = env.JSON_TO_SQL_DO.idFromName("global-schema-config");
                        const stub = env.JSON_TO_SQL_DO.get(globalDoId);
                        const resp = await stub.fetch("http://do/chunking-analysis");
                        return new Response(await resp.text(), {
                                status: resp.status,
                                headers: { "Content-Type": "application/json" }
                        });
                }

                return new Response(
                        `${API_CONFIG.name} - MCP Server v${API_CONFIG.mcpSpecVersion} - Available on /sse endpoint`,
                        { status: 404, headers: { "Content-Type": "text/plain" } }
                );
        },
};

export { CivicMCP as MyMCP };
export { JsonToSqlDO };