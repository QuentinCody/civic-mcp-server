import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { JsonToSqlDO } from "./do.js";

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

export class CivicMCP extends McpAgent {
	server = new McpServer({
		name: API_CONFIG.name,
		version: API_CONFIG.version,
		description: API_CONFIG.description
	});

	async init() {
		// Tool #1: GraphQL to SQLite staging
		this.server.tool(
			API_CONFIG.tools.graphql.name,
			API_CONFIG.tools.graphql.description,
			{
				query: z.string().describe("GraphQL query string"),
				variables: z.record(z.any()).optional().describe("Optional variables for the GraphQL query"),
			},
					async ({ query, variables }) => {
						try {
							const graphqlResult = await this.executeGraphQLQuery(query, variables);

							if (graphqlResult.errors && !graphqlResult.data) {
								return { content: [{ type: "text" as const, text: JSON.stringify(graphqlResult, null, 2) }] };
							}

							// Intelligent Staging Logic
							const responseString = JSON.stringify(graphqlResult);
							if (responseString.length > API_CONFIG.stagingThresholdBytes) {
								// Response is large, stage it
								const stagingResult = await this.stageDataInDurableObject(graphqlResult);
								return { content: [{ type: "text" as const, text: JSON.stringify(stagingResult, null, 2) }] };
							} else {
								// Response is small, return it directly
								return { content: [{ type: "text" as const, text: responseString }] };
							}
						} catch (error) {
							return this.createErrorResponse("GraphQL execution failed", error);
						}
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
			async ({ data_access_id, sql }) => {
				const startTime = Date.now();
				try {
					const queryResult = await this.executeSQLQuery(data_access_id, sql);
					const executionTime = Date.now() - startTime;
					
					return { 
						content: [{ 
							type: "text" as const, 
							text: JSON.stringify(queryResult, null, 2) 
						}],
						_meta: {
							data_access_id,
							query_type: queryResult.query_type || "select",
							execution_time_ms: executionTime,
							row_count: queryResult.row_count || 0,
							column_count: queryResult.column_names?.length || 0,
							chunked_content_resolved: queryResult.chunked_content_resolved || false,
							sql_query_length: sql.length,
							has_results: (queryResult.row_count || 0) > 0
						}
					};
				} catch (error) {
					const executionTime = Date.now() - startTime;
					return this.createErrorResponse("SQL execution failed", error, executionTime);
				}
			}
		);
	}

	// ========================================
	// GRAPHQL CLIENT - Customize headers/auth as needed
	// ========================================
        private async executeGraphQLQuery(query: string, variables?: Record<string, any>): Promise<any> {
                const headers = {
                        "Content-Type": "application/json",
                        ...API_CONFIG.headers
                };
		
		const body = { query, ...(variables && { variables }) };
		
		const response = await fetch(API_CONFIG.endpoint, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		});
		
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`HTTP ${response.status}: ${errorText}`);
		}
		
                return await response.json();
        }

        private isIntrospectionQuery(query: string): boolean {
                if (!query) return false;
                
                // Remove comments and normalize whitespace for analysis
                const normalizedQuery = query
                        .replace(/\s*#.*$/gm, '') // Remove comments
                        .replace(/\s+/g, ' ')     // Normalize whitespace
                        .trim()
                        .toLowerCase();
                
                // Check for common introspection patterns
                const introspectionPatterns = [
                        '__schema',           // Schema introspection
                        '__type',            // Type introspection
                        '__typename',        // Typename introspection
                        'introspectionquery', // Named introspection queries
                        'getintrospectionquery'
                ];
                
                return introspectionPatterns.some(pattern => 
                        normalizedQuery.includes(pattern)
                );
        }

        private shouldBypassStaging(result: any, originalQuery?: string): boolean {
                if (!result) return true;

                // Bypass if this was an introspection query
                if (originalQuery && this.isIntrospectionQuery(originalQuery)) {
                        return true;
                }

                // Bypass if GraphQL reported errors
                if (result.errors) {
                        return true;
                }

                // Check if response contains introspection-like data structure
                if (result.data) {
                        // Common introspection response patterns
                        if (result.data.__schema || result.data.__type) {
                                return true;
                        }
                        
                        // Check for schema metadata structures
                        const hasSchemaMetadata = Object.values(result.data).some((value: any) => {
                                if (value && typeof value === 'object') {
                                        // Look for typical schema introspection fields
                                        const keys = Object.keys(value);
                                        const schemaFields = ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'];
                                        const typeFields = ['name', 'kind', 'description', 'fields', 'interfaces', 'possibleTypes', 'enumValues', 'inputFields'];
                                        
                                        return schemaFields.some(field => keys.includes(field)) ||
                                               typeFields.filter(field => keys.includes(field)).length >= 2;
                                }
                                return false;
                        });
                        
                        if (hasSchemaMetadata) {
                                return true;
                        }
                }

                // Only bypass very small payloads (reduced threshold for better staging)
                try {
                        if (JSON.stringify(result).length < 500) {
                                return true;
                        }
                } catch {
                        return true;
                }

                // Detect mostly empty data objects
                if (result.data) {
                        const values = Object.values(result.data);
                        const hasContent = values.some((v) => {
                                if (v === null || v === undefined) return false;
                                if (Array.isArray(v)) return v.length > 0;
                                if (typeof v === "object") return Object.keys(v).length > 0;
                                return true;
                        });
                        if (!hasContent) return true;
                }

                return false;
        }

        private getBypassReason(result: any, originalQuery?: string): string {
                if (!result) return "null_or_empty_result";
                
                if (originalQuery && this.isIntrospectionQuery(originalQuery)) {
                        return "introspection_query";
                }
                
                if (result.errors) {
                        return "graphql_errors_present";
                }
                
                if (result.data) {
                        if (result.data.__schema || result.data.__type) {
                                return "schema_introspection_response";
                        }
                        
                        const values = Object.values(result.data);
                        const hasContent = values.some((v) => {
                                if (v === null || v === undefined) return false;
                                if (Array.isArray(v)) return v.length > 0;
                                if (typeof v === "object") return Object.keys(v).length > 0;
                                return true;
                        });
                        if (!hasContent) return "empty_data_content";
                }
                
                try {
                        if (JSON.stringify(result).length < 500) {
                                return "small_payload_size";
                        }
                } catch {
                        return "serialization_error";
                }
                
                return "unknown_bypass_reason";
        }

	// ========================================
	// DURABLE OBJECT INTEGRATION - Use this.env directly
	// ========================================
	private async stageDataInDurableObject(graphqlResult: any): Promise<any> {
		const env = this.env as CivicEnv;
		if (!env?.JSON_TO_SQL_DO) {
			throw new Error("JSON_TO_SQL_DO binding not available");
		}
		
		const accessId = crypto.randomUUID();
		const doId = env.JSON_TO_SQL_DO.idFromName(accessId);
		const stub = env.JSON_TO_SQL_DO.get(doId);
		
		const response = await stub.fetch("http://do/process", {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(graphqlResult)
		});
		
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`DO staging failed: ${errorText}`);
		}
		
                const processingResult = await response.json() as any;
                datasetRegistry.set(accessId, {
                        created: new Date().toISOString(),
                        table_count: processingResult.table_count,
                        total_rows: processingResult.total_rows
                });
                return {
                        data_access_id: accessId,
                        processing_details: processingResult
                };
        }

        	private async executeSQLQuery(dataAccessId: string, sql: string): Promise<any> {
		const env = this.env as CivicEnv;
		if (!env?.JSON_TO_SQL_DO) {
			throw new Error("JSON_TO_SQL_DO binding not available");
		}
		
		const doId = env.JSON_TO_SQL_DO.idFromName(dataAccessId);
		const stub = env.JSON_TO_SQL_DO.get(doId);
		
		// Use enhanced SQL execution that automatically resolves chunked content
		const response = await stub.fetch("http://do/query-enhanced", {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sql })
		});
		
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`SQL execution failed: ${errorText}`);
		}
		
		return await response.json();
	}

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

	// ========================================
	// ERROR HANDLING - Reusable
	// ========================================
	private createErrorResponse(message: string, error: unknown, executionTime?: number) {
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({
					success: false,
					error: message,
					details: error instanceof Error ? error.message : String(error),
					timestamp: new Date().toISOString()
				}, null, 2)
			}],
			_meta: {
				error: true,
				error_type: error instanceof Error ? error.constructor.name : "UnknownError",
				execution_time_ms: executionTime || 0,
				timestamp: new Date().toISOString()
			}
		};
	}

	// ========================================
	// ENHANCED ERROR RESPONSE WITH FIELD SUGGESTIONS
	// ========================================
	private async enhanceGraphQLErrorResponse(graphqlResult: any): Promise<string> {
		if (!graphqlResult.errors || !Array.isArray(graphqlResult.errors)) {
			return JSON.stringify(graphqlResult, null, 2);
		}

		let enhancedResponse = JSON.stringify(graphqlResult, null, 2);
		
		// Add auto-correction info if available
		if (graphqlResult._auto_corrected) {
			enhancedResponse += `\n\n✅ Auto-Correction Applied:\n`;
			enhancedResponse += `Original query had field errors, successfully corrected automatically.\n`;
			enhancedResponse += `Use the corrected query format for future requests.`;
			return enhancedResponse;
		}
		
		// Look for field errors and add suggestions
		for (const error of graphqlResult.errors) {
			if (error.extensions?.code === 'undefinedField' && 
			    error.extensions?.typeName && 
			    error.extensions?.fieldName) {
				
				const [suggestions, typeStructure] = await Promise.all([
					this.getFieldSuggestions(error.extensions.typeName, error.extensions.fieldName),
					this.getTypeStructure(error.extensions.typeName)
				]);
				
				enhancedResponse += `\n\n📋 Type Structure:\n${typeStructure}`;
				
				if (suggestions.length > 0) {
					enhancedResponse += `\n\n🔍 Suggested fields similar to '${error.extensions.fieldName}':\n`;
					enhancedResponse += `${suggestions.join(', ')}`;
				}
			}
		}
		
		return enhancedResponse;
	}

	// Get field suggestions for a GraphQL type
	private async getFieldSuggestions(typeName: string, invalidField?: string): Promise<string[]> {
		try {
			// Use introspection to get valid fields for the type
			const introspectionQuery = `
				query GetTypeFields($typeName: String!) {
					__type(name: $typeName) {
						fields {
							name
							type {
								name
								kind
							}
						}
					}
				}
			`;
			
			const result = await this.executeGraphQLQuery(introspectionQuery, { typeName });
			
			if (result.data?.__type?.fields) {
				const fields = result.data.__type.fields.map((field: any) => field.name);
				
				// If we have an invalid field, try to find similar ones
				if (invalidField) {
					const similar = fields.filter((field: string) => 
						field.toLowerCase().includes(invalidField.toLowerCase()) ||
						invalidField.toLowerCase().includes(field.toLowerCase()) ||
						this.calculateSimilarity(field, invalidField) > 0.6
					);
					
					if (similar.length > 0) {
						return similar.slice(0, 5); // Return top 5 similar fields
					}
				}
				
				// Return first 10 available fields as fallback
				return fields.slice(0, 10);
			}
		} catch (introspectionError) {
			// Fallback to static suggestions if introspection fails
			return this.getStaticFieldSuggestions(typeName);
		}
		
		return [];
	}

	// Get basic type structure for schema hints
	private async getTypeStructure(typeName: string): Promise<string> {
		try {
			const introspectionQuery = `
				query GetTypeStructure($typeName: String!) {
					__type(name: $typeName) {
						name
						kind
						description
						fields {
							name
							type {
								name
								kind
								ofType {
									name
									kind
								}
							}
						}
					}
				}
			`;
			
			const result = await this.executeGraphQLQuery(introspectionQuery, { typeName });
			
			if (result.data?.__type) {
				const type = result.data.__type;
				let structure = `${type.name} (${type.kind})`;
				
				if (type.description) {
					structure += `\n  Description: ${type.description}`;
				}
				
				if (type.fields && type.fields.length > 0) {
					structure += '\n  Fields:';
					// Show first 15 fields with their types
					const fieldsToShow = type.fields.slice(0, 15);
					for (const field of fieldsToShow) {
						const fieldType = this.formatFieldType(field.type);
						structure += `\n    ${field.name}: ${fieldType}`;
					}
					
					if (type.fields.length > 15) {
						structure += `\n    ... and ${type.fields.length - 15} more fields`;
					}
				}
				
				return structure;
			}
		} catch (error) {
			// Fallback to static structure
			return this.getStaticTypeStructure(typeName);
		}
		
		return `Type '${typeName}' structure unavailable`;
	}

	// Format GraphQL field type for display
	private formatFieldType(type: any): string {
		if (!type) return 'Unknown';
		
		if (type.kind === 'NON_NULL') {
			return `${this.formatFieldType(type.ofType)}!`;
		}
		
		if (type.kind === 'LIST') {
			return `[${this.formatFieldType(type.ofType)}]`;
		}
		
		return type.name || type.kind;
	}

	// Static type structure as fallback
	private getStaticTypeStructure(typeName: string): string {
		const staticStructures: Record<string, string> = {
			'Gene': `Gene (OBJECT)
  Fields:
    id: Int!
    name: String!
    entrezId: Int
    description: String
    variants: [Variant!]!`,
			'Variant': `Variant (OBJECT) 
  Fields:
    id: Int!
    name: String!
    variantTypes: [VariantType!]!
    singleVariantMolecularProfile: MolecularProfile`,
			'EvidenceItem': `EvidenceItem (OBJECT)
  Fields:
    id: Int!
    description: String!
    evidenceLevel: EvidenceLevel
    evidenceType: EvidenceType
    significance: EvidenceSignificance
    status: EvidenceStatus!`
		};
		
		return staticStructures[typeName] || `${typeName} (OBJECT)\n  Basic type structure unavailable`;
	}
	
	// Calculate string similarity (simple Levenshtein-based approach)
	private calculateSimilarity(str1: string, str2: string): number {
		const len1 = str1.length;
		const len2 = str2.length;
		const matrix = Array(len2 + 1).fill(null).map(() => Array(len1 + 1).fill(null));
		
		for (let i = 0; i <= len1; i++) matrix[0][i] = i;
		for (let j = 0; j <= len2; j++) matrix[j][0] = j;
		
		for (let j = 1; j <= len2; j++) {
			for (let i = 1; i <= len1; i++) {
				const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
				matrix[j][i] = Math.min(
					matrix[j][i - 1] + 1,
					matrix[j - 1][i] + 1,
					matrix[j - 1][i - 1] + cost
				);
			}
		}
		
		const distance = matrix[len2][len1];
		return 1 - distance / Math.max(len1, len2);
	}
	
	// Static field suggestions as fallback
	private getStaticFieldSuggestions(typeName: string): string[] {
		const commonFields: Record<string, string[]> = {
			'Gene': ['id', 'name', 'entrezId', 'description', 'variants'],
			'Variant': ['id', 'name', 'variantTypes', 'singleVariantMolecularProfile'],
			'EvidenceItem': ['id', 'description', 'evidenceLevel', 'evidenceType', 'significance', 'status'],
			'Disease': ['id', 'name', 'doid', 'displayName'],
			'Therapy': ['id', 'name', 'ncitId'],
			'User': ['id', 'name', 'email', 'role'],
			'Organization': ['id', 'name', 'description']
		};
		
		return commonFields[typeName] || ['id', 'name', 'description'];
	}

	// ========================================
	// AUTO-CORRECTION FUNCTIONALITY
	// ========================================
	
	// Check if GraphQL result has field errors
	private hasFieldErrors(result: any): boolean {
		return result?.errors?.some((error: any) => 
			error.extensions?.code === 'undefinedField'
		) || false;
	}

	// Attempt to auto-correct field names in query
	private async attemptAutoCorrection(originalQuery: string, errorResult: any): Promise<string | null> {
		if (!errorResult?.errors) return null;

		let correctedQuery = originalQuery;
		let hasCorrections = false;

		for (const error of errorResult.errors) {
			if (error.extensions?.code === 'undefinedField' && 
			    error.extensions?.typeName && 
			    error.extensions?.fieldName) {
				
				const invalidField = error.extensions.fieldName;
				const typeName = error.extensions.typeName;
				
				// Try various field name transformations
				const corrections = await this.generateFieldCorrections(invalidField, typeName);
				
				if (corrections.length > 0) {
					// Use the first (most likely) correction
					const bestCorrection = corrections[0];
					correctedQuery = this.replaceFieldInQuery(correctedQuery, invalidField, bestCorrection);
					hasCorrections = true;
				}
			}
		}

		return hasCorrections ? correctedQuery : null;
	}

	// Generate possible field name corrections
	private async generateFieldCorrections(invalidField: string, typeName: string): Promise<string[]> {
		const transformations = [
			// Case transformations
			this.toCamelCase(invalidField),
			this.toPascalCase(invalidField),
			this.toSnakeCase(invalidField),
			
			// Common GraphQL naming patterns
			this.pluralize(invalidField),
			this.singularize(invalidField),
			
			// Add common prefixes/suffixes
			`${invalidField}s`,
			`${invalidField}Id`,
			`${invalidField}Type`,
			`${invalidField}Name`,
			
			// Remove common suffixes
			invalidField.replace(/Id$/, ''),
			invalidField.replace(/Type$/, ''),
			invalidField.replace(/Name$/, ''),
			invalidField.replace(/s$/, ''),
		];

		// Get actual field names for this type to validate against
		const validFields = await this.getFieldSuggestions(typeName);
		
		// Filter transformations to only include valid fields
		const validCorrections = transformations.filter(transformation => 
			transformation !== invalidField && validFields.includes(transformation)
		);

		// Sort by similarity to original field name
		return validCorrections.sort((a, b) => 
			this.calculateSimilarity(b, invalidField) - this.calculateSimilarity(a, invalidField)
		);
	}

	// Simple field replacement in GraphQL query
	private replaceFieldInQuery(query: string, oldField: string, newField: string): string {
		// Simple regex replacement - could be more sophisticated
		const fieldRegex = new RegExp(`\\b${oldField}\\b`, 'g');
		return query.replace(fieldRegex, newField);
	}

	// String transformation utilities
	private toCamelCase(str: string): string {
		return str.replace(/_(\w)/g, (_, letter) => letter.toUpperCase());
	}

	private toPascalCase(str: string): string {
		const camel = this.toCamelCase(str);
		return camel.charAt(0).toUpperCase() + camel.slice(1);
	}

	private toSnakeCase(str: string): string {
		return str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
	}

	private pluralize(str: string): string {
		if (str.endsWith('y')) {
			return str.slice(0, -1) + 'ies';
		}
		if (str.endsWith('s') || str.endsWith('x') || str.endsWith('z')) {
			return str + 'es';
		}
		return str + 's';
	}

	private singularize(str: string): string {
		if (str.endsWith('ies')) {
			return str.slice(0, -3) + 'y';
		}
		if (str.endsWith('es')) {
			return str.slice(0, -2);
		}
		if (str.endsWith('s') && !str.endsWith('ss')) {
			return str.slice(0, -1);
		}
		return str;
	}
}

// ========================================
// CLOUDFLARE WORKERS BOILERPLATE - Simplified
// ========================================
interface Env {
	MCP_HOST?: string;
	MCP_PORT?: string;
	JSON_TO_SQL_DO: DurableObjectNamespace;
}

interface ExecutionContext {
	waitUntil(promise: Promise<any>): void;
	passThroughOnException(): void;
}

export default {
        async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
                const url = new URL(request.url);

                // Handle new Streamable HTTP transport (MCP 2025-03-26 specification)
                if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
                        // Extract protocol version from request headers (MCP 2025-06-18 requirement)
                        const protocolVersion = request.headers.get("MCP-Protocol-Version");
                        
                        // Use CivicMCP.serve() for Streamable HTTP transport
                        const response = await CivicMCP.serve("/mcp").fetch(request, env, ctx);
                        
                        // Add protocol version header to response if provided in request
                        if (protocolVersion && response instanceof Response) {
                                const headers = new Headers(response.headers);
                                headers.set("MCP-Protocol-Version", protocolVersion);
                                return new Response(response.body, {
                                        status: response.status,
                                        statusText: response.statusText,
                                        headers
                                });
                        }
                        
                        return response;
                }

                // Handle SSE transport with protocol version header support (legacy support)
                // TODO: Migrate clients to use /mcp endpoint with Streamable HTTP transport
                if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
			// @ts-ignore - SSE transport handling
			return CivicMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		return new Response(
			`${API_CONFIG.name} - Available on /sse endpoint`,
			{ status: 404, headers: { "Content-Type": "text/plain" } }
		);
	},
};

export { CivicMCP as MyMCP };
export { JsonToSqlDO };