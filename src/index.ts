import { McpAgent } from "agents/mcp"; // Assuming McpAgent is available via this path as per the example.
                                        // This might be a project-local base class or an alias to an SDK import.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Define our CIViC MCP agent
export class CivicMCP extends McpAgent {
	// The McpServer instance. The example initializes it as a property.
	// We assume the McpAgent base class or McpServer itself handles the
	// asynchronous initialization flow (calling this.init()) when using
	// the static MyAgent.serveSSE(...).fetch(...) pattern.
	server = new McpServer({
		name: "CivicExplorer",
		version: "0.1.0",
		description: "MCP Server for querying the CIViC GraphQL API (V2). CIViC is an open access, open source, community-driven web resource for Clinical Interpretation of Variants in Cancer."
	});

	// CIViC API Configuration
	private readonly CIVIC_GRAPHQL_ENDPOINT = 'https://civicdb.org/api/graphql';
	private readonly CIVIC_API_VERSION_HEADER = 'application/vnd.civicdb.v2+json'; // Required for CIViC API V2

	async init() {
		console.error("CivicMCP Server initializing...");

		// Register the GraphQL execution tool
		this.server.tool(
			"civic_graphql_query",
			// Tool description (max 1024 chars for this string)
			`Executes GraphQL queries against CIViC API (V2: ${this.CIVIC_GRAPHQL_ENDPOINT}) for Clinical Interpretations of Variants in Cancer. Query genes, variants, evidence, assertions, etc. Example (gene V2): '{ gene(id: 12) { id name evidenceItems { totalCount } } }'. Example (variants V2 w/ pagination): '{ variants(first: 5) { edges { node { id name } } pageInfo { endCursor hasNextPage } } }'. IMPORTANT: Always use V2! Before ANY query, ALWAYS run introspection ('{ __schema { ... } }', '{ __type(name: "Gene") { ... } }') to confirm target fields/ops exist in the V2 schema. If errors, re-check syntax & re-introspect for V2. Use small page counts (e.g., first: 5) initially. For more data, use cursors from 'pageInfo'. API docs (schema at endpoint).`,
			{ // Input schema
				query: z.string().describe(
					`The GraphQL query string for CIViC API V2 (${this.CIVIC_GRAPHQL_ENDPOINT}). Example: '{ gene(id: 12) { id name } }'. Use introspection for V2 schema: '{ __schema { queryType { name } types { name kind } } }'.`
				),
				variables: z.record(z.any()).optional().describe(
					"Optional dictionary of variables for the GraphQL query. Example: { \"geneId\": 12 }"
				),
			},
			// Tool execution function. Return type is inferred based on McpServer.tool expectations.
			async ({ query, variables }: { query: string; variables?: Record<string, any> }) => {
				console.error(`Executing civic_graphql_query with query: ${query.slice(0, 200)}...`);
				if (variables) {
					console.error(`With variables: ${JSON.stringify(variables).slice(0,150)}...`);
				}
				
				const result = await this.executeCivicGraphQLQuery(query, variables);
				
				return { 
					content: [{ 
						type: "text", 
						text: JSON.stringify(result, null, 2) 
					}]
				};
			}
		);
		console.error("CivicMCP Server initialized and tool registered.");
	}

	// Helper function to execute CIViC GraphQL queries (V2)
	private async executeCivicGraphQLQuery(query: string, variables?: Record<string, any>): Promise<any> {
		try {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				"Accept": this.CIVIC_API_VERSION_HEADER, // Crucial for CIViC API V2
				"User-Agent": "MCPCivicServer/0.1.0 (ModelContextProtocol; +https://modelcontextprotocol.io)"
			};
			
			const bodyData: Record<string, any> = { query };
			if (variables) {
				bodyData.variables = variables;
			}
			
			console.error(`Making GraphQL request to: ${this.CIVIC_GRAPHQL_ENDPOINT} for V2`);

			const response = await fetch(this.CIVIC_GRAPHQL_ENDPOINT, {
				method: 'POST',
				headers,
				body: JSON.stringify(bodyData),
			});
			
			console.error(`CIViC API response status: ${response.status}`);
			
			let responseBody;
			try {
				responseBody = await response.json();
			} catch (e) {
				const errorText = await response.text();
				console.error(`CIViC API response is not JSON. Status: ${response.status}, Body: ${errorText.slice(0,500)}`);
				return {
					errors: [{
						message: `CIViC API Error ${response.status}: Non-JSON response. Ensure you are using the correct V2 schema and queries.`,
						extensions: {
							statusCode: response.status,
							responseText: errorText.slice(0, 1000) 
						}
					}]
				};
			}

			if (!response.ok) {
				console.error(`CIViC API HTTP Error ${response.status}: ${JSON.stringify(responseBody)}`);
				// responseBody may contain GraphQL errors, include it for context.
				return {
					errors: [{ 
						message: `CIViC API HTTP Error ${response.status}. Check query syntax against V2 schema via introspection. The server returned the following body:`,
						extensions: {
							statusCode: response.status,
							responseBody: responseBody 
						}
					}]
				};
			}
			
			// If response.ok, responseBody contains the GraphQL payload (which might include data and/or errors)
			return responseBody;

		} catch (error) {
			console.error(`Client-side error during CIViC GraphQL request: ${error instanceof Error ? error.message : String(error)}`);
			let errorMessage = "An unexpected client-side error occurred while attempting to query the CIViC GraphQL API.";
			if (error instanceof Error) {
					errorMessage = error.message;
			} else {
					errorMessage = String(error);
			}
			return { 
				errors: [{ 
					message: errorMessage,
                    extensions: {
                        clientError: true 
                    }
				}]
			};
		}
	}
}

// Define the Env interface for environment variables, matching example.
interface Env {
	MCP_HOST?: string; // Standard MCP env var
	MCP_PORT?: string; // Standard MCP env var
}

// Dummy ExecutionContext for type compatibility, matching example.
interface ExecutionContext {
	waitUntil(promise: Promise<any>): void;
	passThroughOnException(): void;
}

// Export the fetch handler, standard for environments like Cloudflare Workers or Deno Deploy.
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// SSE transport is primary
		if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
			// @ts-ignore - This is used in the example, presumably to handle potential slight
            // mismatches between the generic `fetch` signature expected by some runtimes
            // and the specific signature of the `fetch` method returned by `serveSSE`.
            // This pattern relies on `CivicMCP` (or its base `McpAgent`) having a static `serveSSE` method.
			return CivicMCP.serveSSE("/sse").fetch(request, env, ctx);
		}
		
		// Fallback for unhandled paths
		console.error(`CivicMCP Server. Requested path ${url.pathname} not found. Listening for SSE on /sse.`);
		
		return new Response(
			`CivicMCP Server - Path not found.\nAvailable MCP paths:\n- /sse (for Server-Sent Events transport)`, 
			{ 
				status: 404,
				headers: { "Content-Type": "text/plain" }
			}
		);
	},
};

// Export the agent class as MyMCP, matching the example's export style.
export { CivicMCP as MyMCP };