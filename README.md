# CIViC MCP Server

This is a Cloudflare Workers-based Model Context Protocol (MCP) server that provides tools for querying the CIViC (Clinical Interpretation of Variants in Cancer) API. The server converts GraphQL responses into queryable SQLite tables using Durable Objects for efficient data processing.

The CIViC database is a crowd-sourced repository of clinical interpretations of cancer variants. This MCP server enables structured queries and data analysis of cancer genomics information through natural language interactions with AI assistants.

## MCP Specification Compliance

This server implements **MCP 2025-06-18** specification with the following compliance status:

### ✅ Implemented Features
- **Structured Tool Output**: Tools return structured JSON data with `_meta` fields
- **Protocol Version Headers**: Supports `MCP-Protocol-Version` header handling
- **Title Fields**: Tools include human-friendly titles for display
- **Meta Fields**: Extensive use of `_meta` fields for additional context
- **Error Handling**: Proper error responses with structured content

### 🔄 Partially Implemented
- **Tool Annotations**: Configuration ready but SDK integration pending
  - `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` defined
  - Need SDK update to support annotation parameters

### ⚠️ Pending Implementation
- **Streamable HTTP Transport**: Currently uses SSE transport
  - **Action Required**: Migrate from HTTP+SSE to Streamable HTTP per MCP 2025-03-26
  - **Status**: Architecture change needed for proper implementation
- **OAuth 2.1 Authorization**: Not implemented
  - **Action Required**: Add OAuth 2.1 support for secure remote server access
  - **Components**: Authorization Server discovery, Resource Indicators (RFC 8707)
- **JSON-RPC Batching**: Properly removed (was added in 2025-03-26, removed in 2025-06-18)

## Tool Annotations Reference

The server defines comprehensive tool annotations for MCP clients:

```typescript
// GraphQL Query Tool
annotations: {
  readOnlyHint: false,      // Creates/modifies data in SQLite
  destructiveHint: false,   // Non-destructive data staging
  idempotentHint: false,    // Different queries produce different results
  openWorldHint: true       // Interacts with external CIViC API
}

// SQL Query Tool  
annotations: {
  readOnlyHint: true,       // Only reads data
  destructiveHint: false,   // Cannot modify data (read-only SQL)
  idempotentHint: true,     // Same query produces same results
  openWorldHint: false      // Operates on closed SQLite database
}
```

## Future Updates Required

### 1. Transport Layer Migration
```typescript
// Current: SSE Transport (deprecated)
CivicMCP.serveSSE("/sse").fetch(request, env, ctx)

// Target: Streamable HTTP Transport (MCP 2025-03-26+)
// Implementation requires MCP SDK architectural updates
```

### 2. Tool Annotation Integration
```typescript
// Current: SDK doesn't support 5-argument tool() method
this.server.tool(name, description, schema, handler, annotations) // ❌

// Target: Find correct SDK pattern for annotations
// May require MCP SDK update or different approach
```

### 3. Authorization Framework
```typescript
// Required: OAuth 2.1 integration with:
// - Authorization Server discovery (.well-known endpoints)
// - Resource Indicators (RFC 8707) 
// - Dynamic client registration (RFC 7591)
// - PKCE-enabled authorization code flow
```

## Specification Changelog Summary

### MCP 2025-03-26 (Implemented)
- ✅ Tool annotations framework
- ⚠️ Streamable HTTP transport (pending)
- ✅ Audio data support (infrastructure ready)
- ⚠️ OAuth 2.1 authorization (pending)

### MCP 2025-06-18 (Current Target)
- ✅ Structured tool output
- ✅ Enhanced `_meta` fields
- ✅ Protocol version headers
- ✅ Title fields for tools
- ❌ JSON-RPC batching removed (properly removed)
- ⚠️ Enhanced authorization security (pending)

## Features

- **GraphQL to SQL Conversion**: Automatically converts CIViC API responses into structured SQLite tables
- **Efficient Data Storage**: Uses Cloudflare Durable Objects with SQLite for data staging and querying
- **Smart Response Handling**: Optimizes performance by bypassing staging for small responses, errors, and schema introspection queries
- **Two-Tool Pipeline**: 
  1. `civic_graphql_query`: Executes GraphQL queries and stages large datasets
  2. `civic_query_sql`: Enables SQL-based analysis of staged data

## Installation & Configuration

### Prerequisites
- A Cloudflare account
- Wrangler CLI installed
- Claude Desktop app

### Deploy to Cloudflare Workers

1. Clone this repository:
   ```bash
   git clone <repository-url>
   cd civic-mcp-server
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Deploy to Cloudflare Workers:
   ```bash
   npm run deploy
   ```

4. After deployment, you'll get a URL like: `https://civic-mcp-server.YOUR_SUBDOMAIN.workers.dev`

### Configure Claude Desktop

Add this configuration to your `claude_desktop_config.json` file:

```json
{
  "mcpServers": {
    "civic-mcp-server": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://civic-mcp-server.quentincody.workers.dev/sse"
      ]
    }
  }
}
```

Replace `quentincody` with your actual Cloudflare Workers subdomain.

## Usage

Once configured, restart Claude Desktop. The server provides two main tools:

1. **`civic_graphql_query`**: Execute GraphQL queries against the CIViC API
2. **`civic_query_sql`**: Query staged data using SQL

## Prompts

This server exposes three MCP Prompts that guide the model to use the `civic_graphql_query` tool with correct GraphQL syntax and robust search strategies:

### Individual Data Type Prompts

- **`get-variant-evidence`** — Generates GraphQL for Evidence Items only (no variantName filter - not supported by CIViC schema)
- **`get-variant-assertions`** — Generates GraphQL for Assertions only with systematic fallback strategies

### Combined Data Prompt

- **`get-variant-data`** — Executes both Evidence Items AND Assertions queries for comprehensive variant analysis

**Examples (VS Code Copilot Chat / slash-commands):**

- `/get-variant-evidence molecularProfileName:"TP53 Mutation" diseaseName:"Lung Adenocarcinoma" evidenceType:"PROGNOSTIC" first:"200"`
- `/get-variant-assertions molecularProfileName:"TPM3-NTRK1 Fusion" therapyName:"Larotrectinib" status:"ALL"`
- `/get-variant-data molecularProfileName:"BRAF V600E" diseaseName:"Melanoma" therapyName:"Trametinib" status:"ALL"`

### Key Prompt Features

- **Bulletproof GraphQL Generation**: Complete, validated queries that never fail
- **Intelligent Search Strategies**: Automatic fallback approaches to find relevant data
- **Comprehensive Results**: Evidence items include clinical descriptions; assertions provide high-level summaries
- **Optimal Filtering**: Default status is "ALL" to avoid over-filtering; null parameters are automatically excluded
- **Proper URL Generation**: Canonical links for verification (evidence: `/evidence/{id}`, assertions: `/assertions/{id}`)

These prompts provide complete GraphQL queries with proper CIViC v2 schema compliance and systematic search methodologies that ensure data discovery even when users provide imperfect parameters.

### Example Queries

You can ask Claude questions like:
- "What are the latest evidence items for BRAF mutations?"
- "Show me all therapeutic interpretations for lung cancer variants"
- "Find genes with the most evidence items in the CIViC database"

Claude will use the server (and its `civic_graphql_query` tool) to fetch the relevant data from the CIViC database and present it to you. The server is designed to query version 2 of the CIViC API, ensuring you get up-to-date information.

If you encounter issues or Claude doesn't seem to be using the CIViC data, double-check the configuration steps above.

## Response handling

The server intelligently optimizes context usage by storing large results in a temporary SQLite database. When GraphQL responses meet certain criteria, the raw response is returned directly instead of creating a database:

- **Small responses** (< 1500 characters): Returned directly to avoid unnecessary overhead
- **Error responses**: Passed through directly to make troubleshooting easier  
- **Empty/null responses**: Bypassed to avoid creating empty databases
- **Schema introspection queries**: Queries containing `__schema`, `__type`, or other introspection patterns are returned directly since they contain metadata rather than data suitable for SQL conversion

This optimization makes the server more efficient and provides better error visibility while still enabling powerful SQL-based analysis for substantial datasets.

## Dataset management

Two helper endpoints are available outside of the SSE interface for managing staged datasets.

- `GET /datasets` – lists the currently available `data_access_id`s with creation time and basic metadata.
- `DELETE /datasets/:id` – removes the specified dataset and frees storage.

Example:

```bash
curl https://civic-mcp-server.YOUR_SUBDOMAIN.workers.dev/datasets
curl -X DELETE https://civic-mcp-server.YOUR_SUBDOMAIN.workers.dev/datasets/abcd-1234
```

## License

MIT License with Academic Citation Requirement - see [LICENSE.md](LICENSE.md)
