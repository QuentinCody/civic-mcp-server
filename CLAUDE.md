# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Cloudflare Workers-based Model Context Protocol (MCP) server that provides tools for querying the CIViC (Clinical Interpretation of Variants in Cancer) API. The server converts GraphQL responses into queryable SQLite tables using Durable Objects for efficient data processing and analysis.

## Key Architecture Components

### Core Pattern: GraphQL to SQLite Pipeline
- **GraphQL Tool** (`src/tools/graphql-tool.ts`): Executes GraphQL queries against CIViC API, stages large responses (>1KB) in SQLite via Durable Objects
- **SQL Tool** (`src/tools/sql-tool.ts`): Enables SQL queries against staged data using `data_access_id` from GraphQL tool
- **Durable Object** (`src/do.ts`): Manages SQLite database creation and querying with sophisticated JSON-to-SQL conversion

### Tool Ecosystem
- **Core Tools**: `civic_graphql_query` and `civic_query_sql` (main pipeline)
- **Convenience Tools**: `get_variant_evidence` and `get_variant_assertions` (direct API access, bypass staging)
- **Smart Response Handling**: Small responses (<1KB), errors, and introspection queries bypass staging

### Data Processing Libraries
- **Schema Inference** (`src/lib/SchemaInferenceEngine.ts`): Auto-detects SQLite table schemas from JSON
- **Chunking Engine** (`src/lib/ChunkingEngine.ts`): Handles large text content that exceeds SQLite limits
- **Pagination Analyzer** (`src/lib/PaginationAnalyzer.ts`): Detects and handles paginated GraphQL responses

## Essential Development Commands

### Local Development
```bash
npm run dev          # Start local development server with hot reload
npm run start        # Alternative to npm run dev
```

### Code Quality
```bash
npm run format       # Format code with Biome (indentWidth: 4, lineWidth: 100)
npm run lint:fix     # Run Biome linter with auto-fix
```

### Deployment
```bash
npm run deploy       # Deploy to Cloudflare Workers
npm run cf-typegen   # Generate Cloudflare Worker types
```

### Testing MCP Server
Use MCP Inspector with the deployed Worker URL:
```bash
npx @modelcontextprotocol/inspector
# Connect to: https://your-worker.workers.dev/sse
```

## MCP Implementation Details

### Transport & Compliance
- **Current**: HTTP+SSE transport on `/sse` endpoint (legacy but functional)
- **MCP Specification**: 2025-06-18 compliant with structured tool output and `_meta` fields
- **Tool Annotations**: Comprehensive annotations defined but pending SDK integration

### MCP Prompts
The server provides two prompts using the original tool names that generate complete GraphQL queries:
- **`get_variant_evidence`**: Fetches evidence items with full schema support (evidenceType, significance, etc.)
- **`get_variant_assertions`**: Fetches assertions with fallback to evidence items if no results found

**Prompt Features**:
- Complete, ready-to-run GraphQL queries with proper CIViC v2 schema
- Name-based filtering using `molecularProfileName`, `diseaseName`, `variantName`
- Status filtering (defaults to `ACCEPTED` for cleaner results)
- Rich field selection including `therapies`, `assertionDirection`, `evidenceLevel`
- Clear instructions to use `civic_graphql_query` tool only

**Usage Examples**:
- `/get_variant_evidence molecularProfileName:"TP53 Mutation" diseaseName:"Lung Adenocarcinoma" evidenceType:"PROGNOSTIC"`
- `/get_variant_assertions molecularProfileName:"EGFR" diseaseName:"Lung Cancer" variantName:"L858R"`

### Tool Registration Pattern
Tools and prompts are registered in `src/index.ts`:
```typescript
// Tools
this.server.tool(toolName, description, schema, handler);

// Prompts
registerCivicSimplePrompts(this.server);
```

Each tool class provides:
- Configuration via constructor injection
- Standardized `execute()` method
- Error handling via `ErrorHandler` class

## Cloudflare Workers Configuration

### Durable Objects
- `JSON_TO_SQL_DO`: Main data processing and storage
- `MCP_OBJECT`: Legacy binding (may be unused)

### Environment Variables
- `MCP_HOST`, `MCP_PORT`: Optional MCP server configuration
- Bindings defined in `wrangler.jsonc`

## Code Style & Conventions

- **TypeScript**: ES2021 target with strict mode enabled
- **Module System**: ES2022 modules with `.js` extensions in imports
- **Formatting**: Biome with 4-space indentation, 100-character line width
- **Error Handling**: Centralized via `ErrorHandler` class with structured responses

## CIViC API Integration

### GraphQL Endpoint
- **URL**: `https://civicdb.org/api/graphql`
- **Version**: API v2 (`Accept: application/vnd.civicdb.v2+json`)
- **Schema**: Available in `civic-schema.graphql` for reference

### Common Query Patterns
- **Evidence Items**: `evidenceItems(molecularProfileId: $id, first: $limit)`
- **Assertions**: `assertions` or `molecularProfile.assertions`
- **Typeahead**: `entityTypeahead(query: $q)` for ID resolution

## Dataset Management

### Storage Lifecycle
- Large GraphQL responses generate unique `data_access_id` 
- SQLite tables created in Durable Objects with auto-inferred schemas
- Datasets tracked in in-memory registry with metadata

### Helper Endpoints
- `GET /datasets`: List active datasets with metadata
- `DELETE /datasets/:id`: Clean up specific dataset

## Development Tips

### Testing GraphQL Queries
Test queries directly against CIViC API before integrating:
```bash
curl -H "Accept: application/vnd.civicdb.v2+json" \
     -H "Content-Type: application/json" \
     -d '{"query": "{ genes(first: 5) { nodes { name } } }"}' \
     https://civicdb.org/api/graphql
```

### Debugging Durable Objects
Access DO endpoints directly during development:
```typescript
// In worker: stub.fetch("http://do/debug") for introspection
```

### MCP Tool Development
When adding new tools:
1. Create tool class in `src/tools/`
2. Implement `execute()` method with structured response
3. Add error handling via `ErrorHandler`
4. Register in `src/index.ts` init method
5. Update annotations in `API_CONFIG.tools`