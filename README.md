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

### Molecular profile workflows in Code Mode

`civic_execute` now includes `civic.profiles`, `civic.profile`, `civic.evidence`,
`civic.assertions` and `civic.assertionEvidence` alongside arbitrary `gql.query()`.
These use the existing [CIViC GraphQL API](https://griffithlab.github.io/civic-v2/).
They are workflow additions, not a claim that new endpoints were released.

Discover candidates first:

```js
return await civic.profiles({name: "BRAF", first: 10});
```

The name search is a prefix/alias match. Review all candidates and page through
`pageInfo` before choosing a profile ID. A feature or variant match does not mean
the whole molecular profile matches a sample. Use `civic.profile(id)` to inspect
the complete `rawName`, ordered `parsedName`, `isComplex`, `isMultiVariant` and
variant membership. Preserve Boolean operators, negation and parentheses. The
helper retains Gene, Factor, Fusion and Region feature types, and region ISCN
notation, without converting every feature into a gene.

Then query evidence and assertions by that exact ID. Optional `diseaseId` and
`therapyId` filter each connection without automatic fallback to broader matches:

```js
// Replace 123 with a profile ID selected after inspecting discovery results.
const profileId = 123;
const evidence = await civic.evidence(profileId, {first: 5, status: "ACCEPTED"});
const assertions = await civic.assertions(profileId, {first: 5, status: "ACCEPTED"});
return {evidence, assertions};
```

Evidence underlying a selected assertion is a distinct relationship. Fetch it by
assertion ID; preserve each evidence row's own molecular profile and disease even
when they differ from the assertion. This helper defaults to `ALL` moderation
statuses so its linked evidence is not silently hidden. The other evidence and
assertion helpers default to `ACCEPTED`.

<!-- civic-assertion-evidence-example -->
```js
// Replace 456 with an assertion ID selected from the preceding results.
const assertionId = 456;
const options = {first: 5, after: null, status: "ALL"};
const result = await civic.assertionEvidence(assertionId, options);
if (result.__staged || result.__errors) return result;
return {...result, next: result.evidenceItems.pageInfo.hasNextPage
  ? {assertionId, options: {...options, after: result.evidenceItems.pageInfo.endCursor}}
  : null};
```
<!-- /civic-assertion-evidence-example -->

Each connection has its own cursor and filtered total. Page sizes are 1–50; pass
the unchanged filters and returned cursor explicitly. No helper downloads all
pages or silently selects the first profile. Source citations/retraction state,
moderation status, flagged/deprecated state, evidence direction/level/rating,
assertion AMP level, variant origin and therapy interaction types are retained.
A list of therapies is not automatically a combination treatment.

The existing 1KiB staging setting still applies, with an explicit UTF-8 check at
30KiB for helper results. Staged handles are not entity objects: return the handle
or inspect it through `api.query`/result tools before reading fields. The complete
response, including partial GraphQL errors and pagination, is retained in storage.
`_workflow` records the request and retrieval timestamp; CIViC's current API is
not an immutable historical-release selector. Reads stop at 8MB/30 seconds with
an explicit error so callers can narrow a request.

The focused tests check provider-documented fields/arguments and leaf fragments,
execute the recipe through the real shared GraphQL/staging proxies with fixture
storage, and exercise malformed responses, ambiguous matches and pagination.
The checked-in `civic-schema.graphql` predates Region support; the selected-field
fixture records the current documentation. Separate live acceptance on September
30, 2026 verified Gene, Factor, Fusion and Region profiles, AND/OR/parenthesized
expressions, independent evidence/assertion pagination, and disease/therapy
filters. All 19 evidence IDs retrieved for assertion 101 matched its native
linked-evidence list. Negation, cross-profile differences and retracted-source
cases retain fixture coverage; these selected live samples do not cover every
possible profile or evidence combination.

The legacy GraphQL, SQL and revision tools return both MCP response fields and
mark errors explicitly. Full responses over 30 KiB are staged with `_staging`;
`civic_get_schema` and `civic_query_data` (also available with the `mcp_` prefix)
inspect and query them. The `payloads` table preserves the original response.
Standard `query_data` returns rows, while legacy `civic_query_sql` retains its
native `results` shape. Its optional `params` use native SQLite bindings on a
bounded, read-only route; that route does not expand chunk references. Live
acceptance recovered a 39,984-byte evidence response and a 60,000-character SQL
result exactly. These changes are locally verified; deployment remains pending.

```bash
pnpm exec vitest run servers/civic-mcp-server/src/utils
```

### Existing prompts

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

<!-- license-and-data-terms:start -->
## License and data terms

The code in this repository is licensed under the Apache License 2.0 (see `LICENSE`).
If you use it in your work, please cite it (see `CITATION.cff`). Citation is requested, not required.

The license covers the code only. Data that this server returns comes from CIViC and stays under the terms of that source: CC0.
You are responsible for your use of the data under those terms.
<!-- license-and-data-terms:end -->
