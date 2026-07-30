# CIViC MCP Server

This is a Cloudflare Workers-based Model Context Protocol (MCP) server that provides tools for querying the CIViC (Clinical Interpretation of Variants in Cancer) API. The server converts GraphQL responses into queryable SQLite tables using Durable Objects for efficient data processing.

The CIViC database is a crowd-sourced repository of clinical interpretations of cancer variants. This MCP server enables structured queries and data analysis of cancer genomics information through natural language interactions with AI assistants.

## MCP Specification Compliance

This server implements **MCP 2026-07-28** through the fleet's stateless SDK v2 adapter:

- `server/discover` replaces initialization and every request carries its protocol/capability envelope.
- The Worker uses stateless Streamable HTTP with no MCP session Durable Object or `Mcp-Session-Id`.
- The SDK validates `Mcp-Method` / `Mcp-Name`, stamps `resultType` and `serverInfo`, and supplies cache hints.
- Tool lists have deterministic registration order.
- Tools return `content` and `structuredContent` on success and error, with `isError: true` for errors.
- Large structured results retain the fleet's staging and 100KB transport protections.

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

## Transport

```typescript
// MCP 2026-07-28 stateless Streamable HTTP
CivicMCP.serve("/mcp").fetch(request, env, ctx)
```

The only Durable Objects retained are application/data objects used for staging;
they are not MCP transport sessions.

## Features

- **GraphQL to SQL Conversion**: Automatically converts CIViC API responses into structured SQLite tables
- **Efficient Data Storage**: Uses Cloudflare Durable Objects with SQLite for data staging and querying
- **Smart Response Handling**: Optimizes performance by bypassing staging for small responses, errors, and schema introspection queries
- **Tool Pipeline**: 
  1. `civic_graphql_query`: Executes GraphQL queries and stages large datasets
  2. `civic_query_sql`: Enables SQL-based analysis of staged data
  3. `civic_execute`: Code Mode — runs JavaScript in a V8 isolate with `gql.query()` and schema helpers for full GraphQL access

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
        "https://civic-mcp-server.quentincody.workers.dev/mcp"
      ]
    }
  }
}
```

Replace `quentincody` with your actual Cloudflare Workers subdomain.

## Usage

Once configured, restart Claude Desktop. The server provides three main tools:

1. **`civic_graphql_query`**: Execute GraphQL queries against the CIViC API
2. **`civic_query_sql`**: Query staged data using SQL
3. **`civic_execute`**: Code Mode — write JavaScript against the CIViC GraphQL API in a V8 isolate

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

## License

MIT License with Academic Citation Requirement - see [LICENSE.md](LICENSE.md)
