#!/usr/bin/env node

/**
 * Debug test script for the CIViC MCP Server
 * Shows full responses to understand what's happening
 */

import {
    Client,
    StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const MCP_URL = process.env.MCP_URL || "http://localhost:8790/mcp";

async function debugCivicMCP() {
    console.log("🐛 Debug Testing CIViC MCP Server...\n");

    try {
        // Negotiate MCP 2026-07-28 over stateless Streamable HTTP.
        const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
        const client = new Client(
            {
                name: "debug-client",
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

        console.log("🔍 Raw Tool #1 Response:");
        console.log("Full result object:", JSON.stringify(result1, null, 2));
        console.log("\n📄 Response text content:");
        console.log(result1.content[0].text);

        // Parse and analyze the response
        let response1;
        try {
            response1 = JSON.parse(result1.content[0].text);
            console.log("\n📊 Parsed Tool #1 Response:");
            console.log("- Has data_access_id:", !!response1.data_access_id);
            console.log("- Has processing_details:", !!response1.processing_details);
            console.log("- Has error:", !!response1.error);

            if (response1.data_access_id) {
                console.log("- Data Access ID:", response1.data_access_id);
            }

            if (response1.processing_details) {
                console.log("- Processing Details:", JSON.stringify(response1.processing_details, null, 2));
            }

            if (response1.error) {
                console.log("- Error:", response1.error);
                console.log("- Error Message:", response1.message);
            }

            // Check if this might be a raw GraphQL response (not processed by DO)
            if (response1.data && !response1.data_access_id) {
                console.log("\n⚠️  This looks like a raw GraphQL response, not a processed MCPlus response!");
                console.log("- GraphQL data:", JSON.stringify(response1.data, null, 2));
            }

        } catch (parseError) {
            console.log("❌ Failed to parse response as JSON:", parseError.message);
        }

        await client.close();
        console.log("\n🎯 Analysis Complete!");

    } catch (error) {
        console.error("❌ Debug test failed:", error.message);
        console.error(error.stack);
    }
}

// Run the debug test
debugCivicMCP().catch(console.error);
