# CIViC MCP Server

This is a Cloudflare Workers-based Model Context Protocol (MCP) server that provides tools for querying the CIViC (Clinical Interpretation of Variants in Cancer) API. The server converts GraphQL responses into queryable SQLite tables using Durable Objects for efficient data processing.

The CIViC database is a crowd-sourced repository of clinical interpretations of cancer variants. This MCP server enables structured queries and data analysis of cancer genomics information through natural language interactions with AI assistants.

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
