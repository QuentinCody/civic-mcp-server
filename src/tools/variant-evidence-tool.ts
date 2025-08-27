import { z } from "zod";
import { GraphQLClient } from "../utils/graphql-client.js";
import { ErrorHandler } from "../utils/error-handling.js";

export interface VariantEvidenceToolConfig {
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

export class VariantEvidenceTool {
    private graphqlClient: GraphQLClient;
    private errorHandler: ErrorHandler;
    private config: VariantEvidenceToolConfig;

    constructor(graphqlClient: GraphQLClient, config: VariantEvidenceToolConfig) {
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
                molecular_profile_name: z.string().optional().describe("CIViC molecular profile name (string)"),
                limit: z.number().max(50).default(10).describe("Maximum number of evidence items to return (max 50, default 10)")
            },
            annotations: this.config.annotations
        };
    }

    async execute(params: { molecular_profile_id?: number; molecular_profile_name?: string; limit?: number }) {
        const startTime = Date.now();
        const limit = params.limit ?? 10;
        try {
            if (!params.molecular_profile_id && !params.molecular_profile_name) {
                throw new Error("Either molecular_profile_id or molecular_profile_name must be provided");
            }

            const result = await this.getVariantEvidence(params.molecular_profile_id, params.molecular_profile_name, limit);
            const executionTime = Date.now() - startTime;
            
            return { 
                content: [{ 
                    type: "text" as const, 
                    text: JSON.stringify(result, null, 2) 
                }],
                _meta: {
                    tool_type: "variant_evidence",
                    execution_time_ms: executionTime,
                    molecular_profile_id: params.molecular_profile_id,
                    molecular_profile_name: params.molecular_profile_name,
                    evidence_count: result.data?.evidenceItems?.nodes?.length || 0,
                    limit_requested: limit,
                    timestamp: new Date().toISOString()
                }
            };
        } catch (error) {
            const executionTime = Date.now() - startTime;
            return this.errorHandler.createErrorResponse("Variant evidence retrieval failed", error, executionTime);
        }
    }

    private async getVariantEvidence(molecularProfileId?: number, molecularProfileName?: string, limit: number = 10): Promise<any> {
        let query: string;
        let variables: Record<string, any> = { first: Math.min(limit, 50) };
        
        if (molecularProfileId) {
            query = `
                query GetEvidenceByProfileId($profileId: Int!, $first: Int!) {
                    evidenceItems(molecularProfileId: $profileId, first: $first) {
                        totalCount
                        nodes {
                            id
                            name
                            description
                            evidenceLevel
                            evidenceType
                            significance
                            evidenceDirection
                            status
                            source {
                                id
                                sourceType
                                citation
                                publicationDate
                            }
                            disease {
                                id
                                name
                                displayName
                                doid
                            }
                            therapies {
                                id
                                name
                                ncitId
                            }
                            molecularProfile {
                                id
                                name
                            }
                            variantOrigin
                        }
                        pageInfo {
                            hasNextPage
                            hasPreviousPage
                        }
                    }
                }
            `;
            variables.profileId = molecularProfileId;
        } else if (molecularProfileName) {
            query = `
                query GetEvidenceByProfileName($profileName: String!, $first: Int!) {
                    molecularProfiles(name: $profileName) {
                        nodes {
                            id
                            name
                            evidenceItems(first: $first) {
                                totalCount
                                nodes {
                                    id
                                    name
                                    description
                                    evidenceLevel
                                    evidenceType
                                    significance
                                    evidenceDirection
                                    status
                                    source {
                                        id
                                        sourceType
                                        citation
                                        publicationDate
                                    }
                                    disease {
                                        id
                                        name
                                        displayName
                                        doid
                                    }
                                    therapies {
                                        id
                                        name
                                        ncitId
                                    }
                                    molecularProfile {
                                        id
                                        name
                                    }
                                    variantOrigin
                                }
                                pageInfo {
                                    hasNextPage
                                    hasPreviousPage
                                }
                            }
                        }
                    }
                }
            `;
            variables.profileName = molecularProfileName;
        } else {
            throw new Error("Either molecularProfileId or molecularProfileName must be provided");
        }
        
        return await this.graphqlClient.executeQuery(query, variables);
    }
}