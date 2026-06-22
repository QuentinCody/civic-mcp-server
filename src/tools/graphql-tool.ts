import { z } from "zod/v3";
import { buildPassthroughCitation, type Citation, type SourceDescriptor } from "@bio-mcp/shared";
import type { GraphQLClient, GraphQLResponse, GraphQLError } from "../utils/graphql-client.js";
import { ErrorHandler } from "../utils/error-handling.js";

export interface CivicEnv {
    MCP_HOST?: string;
    MCP_PORT?: string;
    JSON_TO_SQL_DO: DurableObjectNamespace;
    CODE_MODE_LOADER?: { get: (...args: unknown[]) => unknown };
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
    private source?: SourceDescriptor;

    constructor(
        graphqlClient: GraphQLClient,
        config: GraphQLToolConfig,
        datasetRegistry: Map<string, { created: string; table_count?: number; total_rows?: number }>,
        source?: SourceDescriptor
    ) {
        this.graphqlClient = graphqlClient;
        this.errorHandler = new ErrorHandler(graphqlClient);
        this.config = config;
        this.datasetRegistry = datasetRegistry;
        this.source = source;
    }

    getToolDefinition() {
        return {
            name: this.config.name,
            description: this.config.description,
            inputSchema: {
                query: z.string().describe("GraphQL query string"),
                variables: z.record(z.string(), z.unknown()).optional().describe("Optional variables for the GraphQL query"),
            },
            annotations: this.config.annotations
        };
    }

    async execute(params: { query: string; variables?: Record<string, unknown> }, env: CivicEnv) {
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
                // Response is large, stage it. Cite the staged GraphQL data
                // (not the staging envelope), with the access id + row count.
                const stagingResult = await this.stageDataInDurableObject(graphqlResult, env);
                const meta = await this.buildCitationMeta({
                    query: params.query,
                    variables: params.variables,
                    result: graphqlResult,
                    recordCount: stagingResult.processing_details.total_rows,
                    dataAccessId: stagingResult.data_access_id,
                });
                return {
                    content: [{ type: "text" as const, text: JSON.stringify(stagingResult) }],
                    structuredContent: { ...stagingResult, _meta: meta },
                };
            } else {
                // Response is small, return it directly (well below the staging
                // threshold, so it is safe to carry inline in structuredContent).
                const meta = await this.buildCitationMeta({
                    query: params.query,
                    variables: params.variables,
                    result: graphqlResult,
                });
                return {
                    content: [{ type: "text" as const, text: responseString }],
                    structuredContent: { ...graphqlResult, _meta: meta },
                };
            }
        } catch (error) {
            return this.errorHandler.createErrorResponse("GraphQL execution failed", error);
        }
    }

    private shouldAutoCorrectEvidenceStatusSelection(query: string, graphqlResult: GraphQLResponse): boolean {
        if (!query || !graphqlResult?.errors || !Array.isArray(graphqlResult.errors)) {
            return false;
        }

        const hasStatusSelectionSet = /\bstatus\s*\{[^{}]*\}/m.test(query);
        if (!hasStatusSelectionSet) {
            return false;
        }

        return graphqlResult.errors.some((error: GraphQLError) =>
            error?.extensions?.code === "undefinedField" &&
            error?.extensions?.typeName === "EvidenceStatus" &&
            error?.extensions?.fieldName === "name"
        );
    }

    private fixEvidenceStatusSelection(query: string): string {
        return query.replace(/\bstatus\s*\{[^{}]*\}/gm, "status");
    }

    private async stageDataInDurableObject(graphqlResult: GraphQLResponse, env: CivicEnv): Promise<StagingResult> {
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

        const processingResult = await response.json() as ProcessingResult;
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

    // Verifiable provenance: build the _meta.citation envelope for a passthrough
    // result so civic_graphql_query shows up in the chat Sources strip, exactly
    // like the civic_execute Code Mode tool. Returns {} when no source is set.
    private buildCitationMeta(args: {
        query: string;
        variables?: Record<string, unknown>;
        result: unknown;
        recordCount?: number;
        dataAccessId?: string;
    }): Promise<{ citation?: Citation }> {
        return buildPassthroughCitation({
            source: this.source,
            server: "civic",
            tool: this.config.name,
            query: { query: args.query, variables: args.variables },
            result: args.result,
            recordCount: args.recordCount,
            dataAccessId: args.dataAccessId,
        });
    }
}

interface ProcessingResult {
    table_count?: number;
    total_rows?: number;
    [key: string]: unknown;
}

interface StagingResult {
    data_access_id: string;
    processing_details: ProcessingResult;
}
