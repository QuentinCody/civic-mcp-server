import { z } from "zod";
import { stageToDoAndRespond, shouldStage } from "@bio-mcp/shared/staging/utils";
import { buildPassthroughCitation, type Citation, inspectGraphqlErrors, type SourceDescriptor } from "@bio-mcp/shared";
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

    async execute(params: { query: string; variables?: Record<string, unknown> }, env: CivicEnv, extra?: unknown) {
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

            // GraphQL rejects a query with HTTP 200 + {errors:[…]}. Errors WITHOUT data
            // are an upstream failure — report one, and never cite an error payload.
            const gqlErr = inspectGraphqlErrors(graphqlResult);
            if (gqlErr && !gqlErr.partial) {
                const enhancedError = await this.errorHandler.enhanceGraphQLErrorResponse(graphqlResult, params.query);
                return this.errorHandler.createGraphqlErrorResponse(gqlErr.messages, enhancedError);
            }
            // Errors alongside data: the data is real, so this stays a success — but the
            // errors ride along so a partial result never reads as clean.
            const partialErrors = gqlErr?.messages;

            return await this.respondGraphqlResult(graphqlResult, params, env, partialErrors, extra);
        } catch (error) {
            return this.errorHandler.createErrorResponse("GraphQL execution failed", error);
        }
    }

    private async respondGraphqlResult(graphqlResult: GraphQLResponse, params: {query: string; variables?: Record<string, unknown>}, env: CivicEnv, partialErrors?: string[], extra?: unknown) {
        // Intelligent Staging Logic
        const responseString = JSON.stringify(graphqlResult);
        if (shouldStage(new TextEncoder().encode(responseString).byteLength, this.config.stagingThresholdBytes)) {
            // Response is large, stage it. Cite the staged GraphQL data
            // (not the staging envelope), with the access id + row count.
            const stagingResult = await this.stageDataInDurableObject(graphqlResult, env, extra);
            const meta = await this.buildCitationMeta({
                query: params.query,
                variables: params.variables,
                result: graphqlResult,
                recordCount: stagingResult.processing_details.total_rows,
                dataAccessId: stagingResult.data_access_id,
            });
            return {
                content: [{ type: "text" as const, text: JSON.stringify(stagingResult) }],
                structuredContent: {
                    success: true,
                    ...stagingResult,
                    ...(partialErrors?.length ? { partial_errors: partialErrors } : {}),
                    _meta: meta,
                },
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
                structuredContent: {
                    success: true,
                    ...graphqlResult,
                    ...(partialErrors?.length ? { partial_errors: partialErrors } : {}),
                    _meta: meta,
                },
            };
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

    private async stageDataInDurableObject(graphqlResult: GraphQLResponse, env: CivicEnv, extra?: unknown): Promise<StagingResult> {
        if (!env.JSON_TO_SQL_DO) throw new Error("JSON_TO_SQL_DO binding not available");
        const staged = await stageToDoAndRespond(graphqlResult, env.JSON_TO_SQL_DO, "civic", undefined,
            {toolName: this.config.name, serverName: "civic"}, "civic", extra as Parameters<typeof stageToDoAndRespond>[6]);
        const processing = {table_count: staged.tablesCreated?.length, total_rows: staged.totalRows, tables_created: staged.tablesCreated, schema: staged.schema};
        this.datasetRegistry.set(staged.dataAccessId, {created: new Date().toISOString(), table_count: processing.table_count, total_rows: processing.total_rows});
        return {data_access_id: staged.dataAccessId, processing_details: processing, _staging: staged._staging};
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
    _staging: Awaited<ReturnType<typeof stageToDoAndRespond>>["_staging"];
}
