import { GraphQLClient } from './graphql-client.js';

export interface ErrorResponse {
    [x: string]: unknown;
    content: Array<{
        type: "text";
        text: string;
    }>;
    _meta?: {
        error: boolean;
        error_type: string;
        execution_time_ms: number;
        timestamp: string;
    };
    isError?: boolean;
}

export class ErrorHandler {
    private graphqlClient: GraphQLClient;

    constructor(graphqlClient: GraphQLClient) {
        this.graphqlClient = graphqlClient;
    }

    createErrorResponse(message: string, error: unknown, executionTime?: number): ErrorResponse {
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

    async enhanceGraphQLErrorResponse(graphqlResult: any): Promise<string> {
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
                    this.graphqlClient.getFieldSuggestions(error.extensions.typeName, error.extensions.fieldName),
                    this.graphqlClient.getTypeStructure(error.extensions.typeName)
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

    hasFieldErrors(result: any): boolean {
        return result?.errors?.some((error: any) => 
            error.extensions?.code === 'undefinedField'
        ) || false;
    }

    async attemptAutoCorrection(originalQuery: string, errorResult: any): Promise<string | null> {
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
        const validFields = await this.graphqlClient.getFieldSuggestions(typeName);
        
        // Filter transformations to only include valid fields
        const validCorrections = transformations.filter(transformation => 
            transformation !== invalidField && validFields.includes(transformation)
        );

        // Sort by similarity to original field name
        return validCorrections.sort((a, b) => 
            this.calculateSimilarity(b, invalidField) - this.calculateSimilarity(a, invalidField)
        );
    }

    private replaceFieldInQuery(query: string, oldField: string, newField: string): string {
        // Simple regex replacement - could be more sophisticated
        const fieldRegex = new RegExp(`\\b${oldField}\\b`, 'g');
        return query.replace(fieldRegex, newField);
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

    // String transformation utilities
    private toCamelCase(str: string): string {
        return str.replace(/(_\w)/g, (_, match) => match.charAt(1).toUpperCase());
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