import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { JsonToSqlDO } from "./do.js";
import { GraphQLClient, GraphQLClientConfig } from "./utils/graphql-client.js";
import { ErrorHandler } from "./utils/error-handling.js";
import { GraphQLTool, GraphQLToolConfig } from "./tools/graphql-tool.js";
import { SQLTool, SQLToolConfig } from "./tools/sql-tool.js";
import { registerCivicPrompts } from "./prompts/civic-tool-prompts.js";

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
		description: API_CONFIG.description,
		capabilities: {
			prompts: {
				listChanged: true
			},
			tools: {
				listChanged: true
			}
		}
	});

	private graphqlClient!: GraphQLClient;
	private errorHandler!: ErrorHandler;
	private graphqlTool!: GraphQLTool;
	private sqlTool!: SQLTool;

	constructor(ctx: DurableObjectState, env: any) {
		super(ctx, env);
	}

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

		// Register MCP Prompts that guide LLM to use civic_graphql_query
		registerCivicPrompts(this.server);
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
	MCP_OBJECT: DurableObjectNamespace;
	[key: string]: any;
}

interface ExecutionContext {
	waitUntil(promise: Promise<any>): void;
	passThroughOnException(): void;
}

// ========================================
// DOCUMENTATION PAGE FOR GET REQUESTS
// ========================================
function getDocumentationHTML(baseUrl: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CIViC MCP Server</title>
    <style>
        :root {
            --civic-blue: #1a73e8;
            --civic-dark: #1e293b;
            --civic-light: #f8fafc;
            --civic-border: #e2e8f0;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
            line-height: 1.6;
            color: var(--civic-dark);
            background: var(--civic-light);
            padding: 2rem;
            max-width: 900px;
            margin: 0 auto;
        }
        header {
            text-align: center;
            margin-bottom: 2rem;
            padding-bottom: 1.5rem;
            border-bottom: 2px solid var(--civic-border);
        }
        h1 { font-size: 2rem; margin-bottom: 0.5rem; }
        .subtitle { color: #64748b; font-size: 1.1rem; }
        h2 {
            font-size: 1.25rem;
            margin: 2rem 0 1rem;
            color: var(--civic-blue);
        }
        .card {
            background: white;
            border-radius: 8px;
            padding: 1.5rem;
            margin-bottom: 1rem;
            border: 1px solid var(--civic-border);
        }
        code {
            background: #f1f5f9;
            padding: 0.2rem 0.4rem;
            border-radius: 4px;
            font-size: 0.9em;
        }
        pre {
            background: var(--civic-dark);
            color: #e2e8f0;
            padding: 1rem;
            border-radius: 8px;
            overflow-x: auto;
            font-size: 0.85rem;
            line-height: 1.5;
        }
        pre code { background: none; padding: 0; color: inherit; }
        .tool {
            border-left: 3px solid var(--civic-blue);
            padding-left: 1rem;
            margin: 1rem 0;
        }
        .tool-name { font-weight: 600; color: var(--civic-blue); }
        .badge {
            display: inline-block;
            background: var(--civic-blue);
            color: white;
            padding: 0.2rem 0.6rem;
            border-radius: 4px;
            font-size: 0.75rem;
            margin-left: 0.5rem;
        }
        a { color: var(--civic-blue); }
        .links { display: flex; gap: 1rem; flex-wrap: wrap; margin-top: 1rem; }
        .links a {
            display: inline-flex;
            align-items: center;
            gap: 0.3rem;
            text-decoration: none;
            padding: 0.5rem 1rem;
            border: 1px solid var(--civic-border);
            border-radius: 6px;
            transition: background 0.2s;
        }
        .links a:hover { background: #f1f5f9; }
        footer {
            margin-top: 2rem;
            padding-top: 1rem;
            border-top: 1px solid var(--civic-border);
            text-align: center;
            color: #64748b;
            font-size: 0.9rem;
        }
    </style>
</head>
<body>
    <header>
        <h1>CIViC MCP Server</h1>
        <p class="subtitle">Query the Clinical Interpretation of Variants in Cancer database using natural language</p>
    </header>

    <div class="card">
        <strong>This is a Model Context Protocol (MCP) server.</strong>
        Connect it to an MCP-compatible client (Claude Desktop, Cursor, etc.) to query CIViC through natural language.
    </div>

    <h2>Quick Start</h2>
    <div class="card">
        <p>Add this to your Claude Desktop configuration (<code>claude_desktop_config.json</code>):</p>
        <pre><code>{
  "mcpServers": {
    "civic": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "${baseUrl}/sse"
      ]
    }
  }
}</code></pre>
        <p style="margin-top: 1rem;">Then restart Claude Desktop. You can now ask questions like:</p>
        <ul style="margin: 0.5rem 0 0 1.5rem;">
            <li>"What is the clinical significance of BRAF V600E in melanoma?"</li>
            <li>"What therapies are effective for EGFR L858R in lung cancer?"</li>
            <li>"Show me evidence for ALK fusions in non-small cell lung cancer"</li>
        </ul>
    </div>

    <h2>Available Tools</h2>

    <div class="tool">
        <p><span class="tool-name">get_variant_evidence</span> <span class="badge">Recommended</span></p>
        <p>Retrieve evidence items for a molecular profile, optionally filtered by disease and therapy.</p>
    </div>

    <div class="tool">
        <p><span class="tool-name">get_variant_assertions</span></p>
        <p>Retrieve clinical assertions for a molecular profile with optional disease filtering.</p>
    </div>

    <div class="tool">
        <p><span class="tool-name">civic_graphql_query</span> <span class="badge">Advanced</span></p>
        <p>Execute custom GraphQL queries against the CIViC API with automatic SQLite staging for large results.</p>
    </div>

    <h2>Resources</h2>
    <div class="links">
        <a href="https://civicdb.org">CIViC Database</a>
        <a href="https://github.com/QuentinCody/civic-mcp-server">GitHub Repository</a>
        <a href="https://griffithlab.github.io/civic-v2/docs/api/">CIViC API Docs</a>
        <a href="https://modelcontextprotocol.io">MCP Specification</a>
    </div>

    <footer>
        <p>CIViC MCP Server v${API_CONFIG.version}</p>
        <p style="margin-top: 0.5rem;">
            Created by <a href="https://github.com/QuentinCody">Quentin Cody</a>
        </p>
    </footer>
</body>
</html>`;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const baseUrl = `${url.protocol}//${url.host}`;
		setGlobalEnvironment(env);

		// Handle standard MCP requests
		if (url.pathname.startsWith("/mcp")) {
			// For GET requests, return human-readable documentation
			if (request.method === "GET") {
				return new Response(getDocumentationHTML(baseUrl), {
					status: 200,
					headers: { "Content-Type": "text/html; charset=utf-8" }
				});
			}

			// POST requests go to MCP server as normal
			// @ts-ignore - Type mismatch in agents library
			return CivicMCP.serve("/mcp", { binding: "MCP_OBJECT" }).fetch(request, env, ctx);
		}

		if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
			// @ts-ignore - Type mismatch in agents library
			return CivicMCP.serveSSE("/sse", { binding: "MCP_OBJECT" }).fetch(request, env, ctx);
		}

		// Root path redirects to /mcp documentation
		if (url.pathname === "/") {
			return Response.redirect(`${baseUrl}/mcp`, 302);
		}

		return new Response(
			`${API_CONFIG.name} - Available on /sse and /mcp endpoints`,
			{ status: 404, headers: { "Content-Type": "text/plain" } }
		);
	},
};

export { CivicMCP as MyMCP };
export { JsonToSqlDO };