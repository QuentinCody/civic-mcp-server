import { z } from "zod";
import { ErrorHandler } from "../utils/error-handling.js";
import { GraphQLClient } from "../utils/graphql-client.js";

export interface CivicEnv {
    MCP_HOST?: string;
    MCP_PORT?: string;
    JSON_TO_SQL_DO: DurableObjectNamespace;
}

export interface SQLToolConfig {
    name: string;
    description: string;
    annotations: {
        destructive: boolean;
        idempotent: boolean;
        cacheable: boolean;
        world_interaction: string;
        side_effects: string[];
        resource_usage: string;
    };
}

export class SQLTool {
    private errorHandler: ErrorHandler;
    private config: SQLToolConfig;

    constructor(graphqlClient: GraphQLClient, config: SQLToolConfig) {
        this.errorHandler = new ErrorHandler(graphqlClient);
        this.config = config;
    }

    getToolDefinition() {
        return {
            name: this.config.name,
            description: this.config.description,
            inputSchema: {
                data_access_id: z.string().describe("Data access ID from the GraphQL query tool"),
                sql: z.string().describe("SQL SELECT query to execute"),
                params: z.array(z.string()).optional().describe("Optional query parameters"),
            },
            annotations: this.config.annotations
        };
    }

    async execute(params: { data_access_id: string; sql: string; params?: string[] }, env: any) {
        const startTime = Date.now();
        try {
            const queryResult = await this.executeSQLQuery(params.data_access_id, params.sql, env);
            const executionTime = Date.now() - startTime;
            
            return { 
                content: [{ 
                    type: "text" as const, 
                    text: JSON.stringify(queryResult, null, 2) 
                }],
                _meta: {
                    data_access_id: params.data_access_id,
                    query_type: queryResult.query_type || "select",
                    execution_time_ms: executionTime,
                    row_count: queryResult.row_count || 0,
                    column_count: queryResult.column_names?.length || 0,
                    chunked_content_resolved: queryResult.chunked_content_resolved || false,
                    sql_query_length: params.sql.length,
                    has_results: (queryResult.row_count || 0) > 0
                }
            };
        } catch (error) {
            const executionTime = Date.now() - startTime;
            return this.errorHandler.createErrorResponse("SQL execution failed", error, executionTime);
        }
    }

    private async executeSQLQuery(dataAccessId: string, sql: string, env: CivicEnv): Promise<any> {
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
}