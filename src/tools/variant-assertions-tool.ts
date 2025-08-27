import { z } from "zod";
import { GraphQLClient } from "../utils/graphql-client.js";
import { ErrorHandler } from "../utils/error-handling.js";

export interface VariantAssertionsToolConfig {
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

export class VariantAssertionsTool {
    private graphqlClient: GraphQLClient;
    private errorHandler: ErrorHandler;
    private config: VariantAssertionsToolConfig;

    constructor(graphqlClient: GraphQLClient, config: VariantAssertionsToolConfig) {
        this.graphqlClient = graphqlClient;
        this.errorHandler = new ErrorHandler(graphqlClient);
        this.config = config;
    }

    getToolDefinition() {
        return {
            name: this.config.name,
            description: this.config.description,
            inputSchema: {
                molecular_profile_id: z.number().optional().describe("CIViC molecular profile ID (numeric)"),
                molecular_profile_name: z.string().optional().describe("CIViC molecular profile name (string)")
            },
            annotations: this.config.annotations
        };
    }

    async execute(params: { molecular_profile_id?: number; molecular_profile_name?: string }) {
        const startTime = Date.now();
        try {
            if (!params.molecular_profile_id && !params.molecular_profile_name) {
                throw new Error("Either molecular_profile_id or molecular_profile_name must be provided");
            }

            const result = await this.getVariantAssertions(params.molecular_profile_id, params.molecular_profile_name);
            const executionTime = Date.now() - startTime;
            
            return { 
                content: [{ 
                    type: "text" as const, 
                    text: JSON.stringify(result, null, 2) 
                }],
                _meta: {
                    tool_type: "variant_assertions",
                    execution_time_ms: executionTime,
                    molecular_profile_id: params.molecular_profile_id,
                    molecular_profile_name: params.molecular_profile_name,
                    assertion_count: result.data?.molecularProfiles?.nodes?.[0]?.assertions?.nodes?.length || 0,
                    timestamp: new Date().toISOString()
                }
            };
        } catch (error) {
            const executionTime = Date.now() - startTime;
            return this.errorHandler.createErrorResponse("Variant assertions retrieval failed", error, executionTime);
        }
    }

    private async getVariantAssertions(molecularProfileId?: number, molecularProfileName?: string): Promise<any> {
        let query: string;
        let variables: Record<string, any> = {};
        
        if (molecularProfileId) {
            query = `
                query GetAssertionsByProfileId($id: Int!) {
                    molecularProfile(id: $id) {
                        id
                        name
                        assertions {
                            nodes {
                                id
                                name
                                summary
                                description
                                assertionType
                                assertionDirection
                                significance
                                status
                                ampLevel
                                evidenceItems {
                                    id
                                    name
                                    description
                                    evidenceLevel
                                    evidenceType
                                    significance
                                    status
                                }
                                disease {
                                    id
                                    name
                                    displayName
                                }
                                therapies {
                                    id
                                    name
                                }
                                molecularProfile {
                                    id
                                    name
                                }
                                acmgCodes {
                                    code
                                    description
                                }
                            }
                        }
                    }
                }
            `;
            variables.id = molecularProfileId;
        } else if (molecularProfileName) {
            query = `
                query GetAssertionsByProfileName($name: String!) {
                    molecularProfiles(name: $name) {
                        nodes {
                            id
                            name
                            assertions {
                                nodes {
                                    id
                                    name
                                    summary
                                    description
                                    assertionType
                                    assertionDirection
                                    significance
                                    status
                                    ampLevel
                                    evidenceItems {
                                        id
                                        name
                                        description
                                        evidenceLevel
                                        evidenceType
                                        significance
                                        status
                                    }
                                    disease {
                                        id
                                        name
                                        displayName
                                    }
                                    therapies {
                                        id
                                        name
                                    }
                                    molecularProfile {
                                        id
                                        name
                                    }
                                    acmgCodes {
                                        code
                                        description
                                    }
                                }
                            }
                        }
                    }
                }
            `;
            variables.name = molecularProfileName;
        } else {
            throw new Error("Either molecularProfileId or molecularProfileName must be provided");
        }
        
        return await this.graphqlClient.executeQuery(query, variables);
    }
}