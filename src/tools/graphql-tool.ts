import { z } from "zod";
import { GraphQLClient } from "../utils/graphql-client.js";
import { ErrorHandler } from "../utils/error-handling.js";

export interface CivicEnv {
    MCP_HOST?: string;
    MCP_PORT?: string;
    JSON_TO_SQL_DO: DurableObjectNamespace;
}

export interface GraphQLToolConfig {
    name: string;
    description: string;
    stagingThresholdBytes: number;
    annotations: {
        destructive: boolean;
        idempotent: boolean;
        cacheable: boolean;
        world_interaction: string;
        side_effects: string[];
        resource_usage: string;
    };
}

export class GraphQLTool {
    private graphqlClient: GraphQLClient;
    private errorHandler: ErrorHandler;
    private config: GraphQLToolConfig;
    private datasetRegistry: Map<string, { created: string; table_count?: number; total_rows?: number }>;

    constructor(
        graphqlClient: GraphQLClient,
        config: GraphQLToolConfig,
        datasetRegistry: Map<string, { created: string; table_count?: number; total_rows?: number }>
    ) {
        this.graphqlClient = graphqlClient;
        this.errorHandler = new ErrorHandler(graphqlClient);
        this.config = config;
        this.datasetRegistry = datasetRegistry;
    }

    getToolDefinition() {
        return {
            name: this.config.name,
            description: this.config.description,
            inputSchema: {
                query: z.string().describe("GraphQL query string"),
                variables: z.record(z.any()).optional().describe("Optional variables for the GraphQL query"),
            },
            annotations: this.config.annotations
        };
    }

    async execute(params: { query: string; variables?: Record<string, any> }, env: any) {
        try {
            let graphqlResult = await this.graphqlClient.executeQuery(params.query, params.variables);
            // Track the latest query version so chained corrections build on each other
            let currentQuery = params.query;

            // CIViC-specific ergonomic fix: status is a scalar (not an object).
            if (this.shouldAutoCorrectEvidenceStatusSelection(currentQuery, graphqlResult)) {
                const correctedQuery = this.fixEvidenceStatusSelection(currentQuery);
                if (correctedQuery !== currentQuery) {
                    const correctedResult = await this.graphqlClient.executeQuery(correctedQuery, params.variables);
                    if (!correctedResult.errors || correctedResult.data) {
                        currentQuery = correctedQuery;
                        graphqlResult = {
                            ...correctedResult,
                            _auto_corrected: true
                        };
                    } else {
                        graphqlResult = correctedResult;
                    }
                }
            }

            // Auto-correct known field errors (e.g., direction → evidenceDirection)
            if (this.errorHandler.hasFieldErrors(graphqlResult)) {
                const corrected = await this.errorHandler.attemptAutoCorrection(currentQuery, graphqlResult);
                if (corrected) {
                    const retryResult = await this.graphqlClient.executeQuery(corrected, params.variables);
                    if (!retryResult.errors || retryResult.data) {
                        graphqlResult = {
                            ...retryResult,
                            _auto_corrected: true,
                            _original_query: params.query,
                        };
                    }
                }
            }

            if (graphqlResult.errors && !graphqlResult.data) {
                const enhancedError = await this.errorHandler.enhanceGraphQLErrorResponse(graphqlResult, params.query);
                return { content: [{ type: "text" as const, text: enhancedError }] };
            }

            // Intelligent Staging Logic
            const responseString = JSON.stringify(graphqlResult);
            if (responseString.length > this.config.stagingThresholdBytes) {
                // Response is large, stage it
                const stagingResult = await this.stageDataInDurableObject(graphqlResult, env);
                return { content: [{ type: "text" as const, text: JSON.stringify(stagingResult) }] };
            } else {
                // Response is small, return it directly
                return { content: [{ type: "text" as const, text: responseString }] };
            }
        } catch (error) {
            return this.errorHandler.createErrorResponse("GraphQL execution failed", error);
        }
    }

    private shouldAutoCorrectEvidenceStatusSelection(query: string, graphqlResult: any): boolean {
        if (!query || !graphqlResult?.errors || !Array.isArray(graphqlResult.errors)) {
            return false;
        }

        const hasStatusSelectionSet = /\bstatus\s*\{[^{}]*\}/m.test(query);
        if (!hasStatusSelectionSet) {
            return false;
        }

        return graphqlResult.errors.some((error: any) =>
            error?.extensions?.code === "undefinedField" &&
            error?.extensions?.typeName === "EvidenceStatus" &&
            error?.extensions?.fieldName === "name"
        );
    }

    private fixEvidenceStatusSelection(query: string): string {
        return query.replace(/\bstatus\s*\{[^{}]*\}/gm, "status");
    }

    private async stageDataInDurableObject(graphqlResult: any, env: CivicEnv): Promise<any> {
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
        this.datasetRegistry.set(accessId, {
            created: new Date().toISOString(),
            table_count: processingResult.table_count,
            total_rows: processingResult.total_rows
        });
        return {
            data_access_id: accessId,
            processing_details: processingResult
        };
    }
}
