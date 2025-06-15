# MCP Server Template

This repository is a template for building a Cloudflare Workers based Model Context Protocol (MCP) server for **any** GraphQL API.  Originally created for the CIViC project, the code has been generalized so you can point it at your own endpoint and deploy a fully featured MCP server.

The server converts GraphQL responses into queryable SQLite tables using Durable Objects for efficient data staging.  It enables structured queries and data analysis of remote APIs through natural language interactions with AI assistants.

## Features

- **GraphQL to SQL Conversion**: Automatically converts API responses into queryable SQLite tables
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

2. Edit `wrangler.jsonc` and update the values in the `vars` section to match your API endpoint and metadata (name, version, headers, etc.).

3. Install dependencies:
   ```bash
   npm install
   ```

4. Deploy to Cloudflare Workers:
   ```bash
   npm run deploy
   ```

After deployment, you'll get a URL like: `https://civic-mcp-server.YOUR_SUBDOMAIN.workers.dev`

### Configure Claude Desktop

Add this configuration to your `claude_desktop_config.json` file:

```json
{
  "mcpServers": {
    "civic-mcp-server": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://civic-mcp-server.YOUR_SUBDOMAIN.workers.dev/sse"
      ]
    }
  }
}
```

Replace `quentincody` with your actual Cloudflare Workers subdomain.

## Usage

Once configured, restart Claude Desktop. The server provides two main tools:

1. **`civic_graphql_query`**: Execute GraphQL queries against your configured API
2. **`civic_query_sql`**: Query staged data using SQL

### Example Queries

You can ask your assistant domain-specific questions and the server will use the `civic_graphql_query` tool to fetch the data from your API. Adjust example questions to match the capabilities of your endpoint.

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

### Running tests

After starting the server locally with `npm run dev`, you can verify basic functionality using:

```bash
TEST_MCP_URL=http://localhost:8787/sse npm test
```

The test script connects to the server, performs a GraphQL query and a sample SQL query, and reports the results.
