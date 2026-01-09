/**
 * Regression tests for documentation HTML
 *
 * IMPORTANT: These tests ensure that documentation always points users to the
 * correct MCP endpoint using Streamable HTTP transport.
 *
 * Background: The MCP specification supports multiple transports:
 * - Streamable HTTP (POST /mcp) - The modern, recommended approach
 * - Server-Sent Events (GET /sse) - Legacy transport, being phased out
 *
 * All documentation and configuration examples MUST use the /mcp endpoint
 * with Streamable HTTP, NOT the /sse endpoint with SSE transport.
 *
 * If these tests fail, DO NOT change them to use /sse - fix the source code instead.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// Read the source file to extract the documentation HTML
const indexPath = path.join(__dirname, "../index.ts");
const indexContent = fs.readFileSync(indexPath, "utf-8");

// Extract the HTML template from getDocumentationHTML function
const htmlMatch = indexContent.match(/function getDocumentationHTML\(baseUrl: string\): string \{[\s\S]*?return `([\s\S]*?)`;[\s\S]*?\}/);
const documentationHTML = htmlMatch ? htmlMatch[1] : "";

describe("Documentation HTML", () => {
    describe("MCP Transport Configuration", () => {
        it("should use /mcp endpoint in Claude Desktop configuration, NOT /sse", () => {
            // The config should point to /mcp for Streamable HTTP transport
            expect(documentationHTML).toContain('${baseUrl}/mcp"');

            // It should NOT point to /sse (legacy SSE transport)
            expect(documentationHTML).not.toMatch(/\$\{baseUrl\}\/sse["']/);
        });

        it("should not mention SSE or Server-Sent Events as the recommended transport", () => {
            // Documentation should not recommend SSE transport
            expect(documentationHTML.toLowerCase()).not.toContain("server-sent events");
            expect(documentationHTML).not.toMatch(/\bSSE\b/); // Case-sensitive SSE
        });

        it("should include mcp-remote in the configuration example", () => {
            // mcp-remote is the bridge that connects to remote MCP servers
            expect(documentationHTML).toContain("mcp-remote");
        });
    });

    describe("Configuration Example Structure", () => {
        it("should have a valid Claude Desktop configuration structure", () => {
            expect(documentationHTML).toContain('"mcpServers"');
            expect(documentationHTML).toContain('"civic"');
            expect(documentationHTML).toContain('"command"');
            expect(documentationHTML).toContain('"npx"');
            expect(documentationHTML).toContain('"args"');
        });
    });

    describe("Documentation Content", () => {
        it("should mention this is an MCP server", () => {
            expect(documentationHTML).toContain("Model Context Protocol");
        });

        it("should include quick start instructions", () => {
            expect(documentationHTML).toContain("Quick Start");
            expect(documentationHTML).toContain("claude_desktop_config.json");
        });

        it("should list available tools", () => {
            expect(documentationHTML).toContain("get_variant_evidence");
            expect(documentationHTML).toContain("get_variant_assertions");
        });

        it("should link to the correct GitHub repository (QuentinCody)", () => {
            expect(documentationHTML).toContain("github.com/QuentinCody/civic-mcp-server");
            // Should NOT link to the fork as the primary repo
            expect(documentationHTML).not.toContain("github.com/griffithlab/civic-mcp-server");
        });
    });
});

describe("Source Code Routing", () => {
    it("should have GET handler for /mcp that returns documentation", () => {
        // Verify the routing logic exists
        expect(indexContent).toContain('if (request.method === "GET")');
        expect(indexContent).toContain("getDocumentationHTML(baseUrl)");
    });

    it("should route POST /mcp requests to MCP server", () => {
        // Verify POST requests go to the actual MCP server
        expect(indexContent).toContain('CivicMCP.serve("/mcp"');
    });

    it("should still support /sse endpoint for backwards compatibility", () => {
        // The /sse endpoint can remain for backwards compatibility,
        // but documentation should NOT point users to it
        expect(indexContent).toContain('url.pathname === "/sse"');
        expect(indexContent).toContain('CivicMCP.serveSSE("/sse"');
    });
});
