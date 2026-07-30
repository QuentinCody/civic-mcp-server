#!/usr/bin/env node

/**
 * Simple test script for the CIViC MCP Server
 * Tests the SQLite-based MCPlus pipeline with a basic introspection query
 */

import {
    Client,
    StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const MCP_URL = process.env.MCP_URL || "http://localhost:8790/mcp";

async function testCivicMCP() {
    console.log("🧪 Testing CIViC MCP Server...\n");

    try {
        // Negotiate MCP 2026-07-28 over stateless Streamable HTTP.
        const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
        const client = new Client(
            {
                name: "test-client",
                version: "1.0.0",
            },
            {
                capabilities: {
                    tools: {},
                },
                versionNegotiation: { mode: "auto" },
            }
        );

        // Connect to the server
        console.log("📡 Connecting to MCP server...");
        await client.connect(transport);
        console.log("✅ Connected successfully!\n");

        // List available tools
        console.log("🔧 Available tools:");
        const { tools } = await client.listTools();
        tools.forEach(tool => {
            console.log(`  - ${tool.name}: ${tool.description?.slice(0, 100)}...`);
        });
        console.log();

        // Test Tool #1: Execute a simple GraphQL introspection query
        console.log("🧬 Testing Tool #1 (civic_graphql_query) with introspection query...");
        const introspectionQuery = `{
            __schema {
                queryType { name }
                types(filter: { name: ["Query", "Gene"] }) {
                    name
                    kind
                    description
                }
            }
        }`;

        const result1 = await client.callTool({
            name: "civic_graphql_query",
            arguments: {
                query: introspectionQuery
            }
        });

        console.log("📊 Tool #1 Result:");
        const response1 = JSON.parse(result1.content[0].text);
        console.log(`  - Success: ${!response1.error}`);
        console.log(`  - Data Access ID: ${response1.data_access_id || 'N/A'}`);

        if (response1.processing_details) {
            const details = response1.processing_details;
            console.log(`  - Tables Created: ${details.table_count || 0}`);
            console.log(`  - Total Records: ${details.total_records || 0}`);
            if (details.schema_summary) {
                console.log(`  - Schema: ${details.schema_summary}`);
            }
            if (details.error) {
                console.log(`  - ❌ Processing Error: ${details.error}`);
            }
        }
        console.log();

        // Test Tool #2: Query the staged data (if Tool #1 succeeded)
        if (response1.data_access_id && !response1.processing_details?.error) {
            console.log("🔍 Testing Tool #2 (civic_query_sql) with simple query...");

            // First, get table names
            const result2 = await client.callTool({
                name: "civic_query_sql",
                arguments: {
                    data_access_id: response1.data_access_id,
                    sql: "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                }
            });

            console.log("📋 Tool #2 Result:");
            const response2 = JSON.parse(result2.content[0].text);
            console.log(`  - Success: ${response2.success}`);
            console.log(`  - Rows Returned: ${response2.rowCount || 0}`);

            if (response2.success && response2.results.length > 0) {
                console.log("  - Available Tables:");
                response2.results.forEach(row => {
                    console.log(`    • ${row.name}`);
                });

                // Try to query the first table
                const firstTable = response2.results[0].name;
                console.log(`\n🔎 Querying first table: ${firstTable}`);

                const result3 = await client.callTool({
                    name: "civic_query_sql",
                    arguments: {
                        data_access_id: response1.data_access_id,
                        sql: `SELECT * FROM ${firstTable} LIMIT 3`
                    }
                });

                const response3 = JSON.parse(result3.content[0].text);
                console.log(`  - Success: ${response3.success}`);
                console.log(`  - Sample Records: ${response3.rowCount || 0}`);
                if (response3.success && response3.results.length > 0) {
                    console.log("  - Sample Data:", JSON.stringify(response3.results[0], null, 2));
                }
            } else if (response2.error) {
                console.log(`  - ❌ Query Error: ${response2.error}`);
            }
        } else {
            console.log("⏭️ Skipping Tool #2 test (Tool #1 failed or no data access ID)");
        }

        await client.close();
        console.log("\n🎉 Test completed!");

    } catch (error) {
        console.error("❌ Test failed:", error.message);
        console.error(error.stack);
    }
}

// Run the test
testCivicMCP().catch(console.error);
