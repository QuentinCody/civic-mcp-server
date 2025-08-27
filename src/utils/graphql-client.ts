export interface GraphQLResponse {
    data?: any;
    errors?: any[];
    _auto_corrected?: boolean;
}

export interface GraphQLClientConfig {
    endpoint: string;
    headers: Record<string, string>;
}

export class GraphQLClient {
    private config: GraphQLClientConfig;

    constructor(config: GraphQLClientConfig) {
        this.config = config;
    }

    async executeQuery(query: string, variables?: Record<string, any>): Promise<GraphQLResponse> {
        const headers = {
            "Content-Type": "application/json",
            ...this.config.headers
        };

        const body = { query, ...(variables && { variables }) };

        const response = await fetch(this.config.endpoint, {
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

    isIntrospectionQuery(query: string): boolean {
        if (!query) return false;
        
        const normalizedQuery = query
            .replace(/\s*#.*$/gm, '') // Remove comments
            .replace(/\s+/g, ' ')     // Normalize whitespace
            .trim()
            .toLowerCase();
        
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

    shouldBypassStaging(result: any, originalQuery?: string): boolean {
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

    getBypassReason(result: any, originalQuery?: string): string {
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

    async getFieldSuggestions(typeName: string, invalidField?: string): Promise<string[]> {
        try {
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
            
            const result = await this.executeQuery(introspectionQuery, { typeName });
            
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

    async getTypeStructure(typeName: string): Promise<string> {
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
            
            const result = await this.executeQuery(introspectionQuery, { typeName });
            
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
}