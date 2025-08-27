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
            const graphqlResult = await this.graphqlClient.executeQuery(params.query, params.variables);

            if (graphqlResult.errors && !graphqlResult.data) {
                return { content: [{ type: "text" as const, text: JSON.stringify(graphqlResult, null, 2) }] };
            }

            // Intelligent Staging Logic
            const responseString = JSON.stringify(graphqlResult);
            if (responseString.length > this.config.stagingThresholdBytes) {
                // Response is large, stage it
                const stagingResult = await this.stageDataInDurableObject(graphqlResult, env);
                return { content: [{ type: "text" as const, text: JSON.stringify(stagingResult, null, 2) }] };
            } else {
                // Response is small, return it directly
                return { content: [{ type: "text" as const, text: responseString }] };
            }
        } catch (error) {
            return this.errorHandler.createErrorResponse("GraphQL execution failed", error);
        }
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