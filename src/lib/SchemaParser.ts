import { GraphQLSchemaInfo, GraphQLTypeInfo, GraphQLFieldInfo, FieldChunkingRule } from "./ChunkingEngine.js";

export interface EntityRelationshipInfo {
	fromType: string;
	toType: string;
	fieldName: string;
	cardinality: 'one-to-one' | 'one-to-many' | 'many-to-many';
	isEntityList: boolean;
}

export interface FieldExtractionRule {
	fieldName: string;
	typeName: string;
	shouldExtractEntities: boolean;
	targetEntityType?: string;
	isListField: boolean;
}

/**
 * Parses GraphQL schema files and extracts chunking-relevant information
 */
export class SchemaParser {
	private schemaInfo?: GraphQLSchemaInfo;
	private extractionRules: FieldExtractionRule[] = [];
	private relationships: EntityRelationshipInfo[] = [];

	/**
	 * Parse a GraphQL schema string and extract type information
	 */
	static parseSchema(schemaContent: string): GraphQLSchemaInfo {
		const types: Record<string, GraphQLTypeInfo> = {};
		const relationships: Array<{
			fromType: string;
			toType: string;
			fieldName: string;
			cardinality: string;
		}> = [];

		// Parse types using regex patterns
		const typeMatches = schemaContent.matchAll(/type\s+(\w+)(?:\s+implements\s+[\w\s&]+)?\s*\{([^}]+(?:\}[^}]*)*)\}/g);
		
		for (const match of typeMatches) {
			const typeName = match[1];
			const typeBody = match[2];
			
			if (this.shouldSkipType(typeName)) {
				continue;
			}

			const fields = this.parseFields(typeBody, typeName, relationships);
			
			types[typeName] = {
				name: typeName,
				kind: 'OBJECT',
				fields,
				description: this.extractDescription(match[0])
			};
		}

		return { types, relationships };
	}

	/**
	 * Generate chunking rules based on parsed schema
	 */
	static generateChunkingRulesFromSchema(schemaInfo: GraphQLSchemaInfo): FieldChunkingRule[] {
		const rules: FieldChunkingRule[] = [
			// Base rules that apply to all types
			{ fieldName: 'id', typeName: '*', chunkThreshold: Infinity, priority: 'never', reason: 'ID fields should never be chunked' },
			{ fieldName: 'entrezId', typeName: '*', chunkThreshold: Infinity, priority: 'never', reason: 'External ID fields should never be chunked' },
			{ fieldName: 'pmcId', typeName: '*', chunkThreshold: Infinity, priority: 'never', reason: 'External ID fields should never be chunked' },
			{ fieldName: 'citationId', typeName: '*', chunkThreshold: Infinity, priority: 'never', reason: 'External ID fields should never be chunked' },
		];

		// Analyze schema types for large content fields
		for (const [typeName, typeInfo] of Object.entries(schemaInfo.types)) {
			for (const [fieldName, fieldInfo] of Object.entries(typeInfo.fields)) {
				const rule = this.generateFieldRule(typeName, fieldName, fieldInfo);
				if (rule) {
					rules.push(rule);
				}
			}
		}

		// Add CIViC-specific knowledge
		rules.push(
			// Known large text fields from schema analysis
			{ fieldName: 'description', typeName: 'EvidenceItem', chunkThreshold: 2048, priority: 'always', reason: 'Evidence descriptions are typically very long' },
			{ fieldName: 'description', typeName: 'Gene', chunkThreshold: 1024, priority: 'always', reason: 'Gene descriptions can be extensive' },
			{ fieldName: 'abstract', typeName: 'Source', chunkThreshold: 4096, priority: 'always', reason: 'Paper abstracts are typically long' },
			{ fieldName: 'statement', typeName: '*', chunkThreshold: 2048, priority: 'always', reason: 'Statement fields contain detailed explanations' },
			{ fieldName: 'summary', typeName: '*', chunkThreshold: 1024, priority: 'always', reason: 'Summary fields are often long' },
			
			// JSON fields that can be very large
			{ fieldName: 'myGeneInfoDetails', typeName: 'Gene', chunkThreshold: 8192, priority: 'size-based', reason: 'External API responses can be very large' },
			{ fieldName: 'clinicalTrials', typeName: '*', chunkThreshold: 4096, priority: 'size-based', reason: 'Clinical trial data arrays can be extensive' },
			
			// Connection fields (GraphQL pagination) - these can be huge
			{ fieldName: 'comments', typeName: '*', chunkThreshold: 8192, priority: 'size-based', reason: 'Comment connections can contain many large comment objects' },
			{ fieldName: 'events', typeName: '*', chunkThreshold: 6144, priority: 'size-based', reason: 'Event connections can be extensive' },
			{ fieldName: 'revisions', typeName: '*', chunkThreshold: 6144, priority: 'size-based', reason: 'Revision connections can be extensive' },
			{ fieldName: 'flags', typeName: '*', chunkThreshold: 4096, priority: 'size-based', reason: 'Flag connections can contain detailed flag information' },
			
			// Conservative chunking for names and short text
			{ fieldName: 'name', typeName: '*', chunkThreshold: 256, priority: 'size-based', reason: 'Names are usually short but some can be long' },
			{ fieldName: 'fullName', typeName: '*', chunkThreshold: 512, priority: 'size-based', reason: 'Full names might be longer than regular names' },
			{ fieldName: 'title', typeName: '*', chunkThreshold: 1024, priority: 'size-based', reason: 'Titles can be moderately long' },
			{ fieldName: 'citation', typeName: '*', chunkThreshold: 2048, priority: 'size-based', reason: 'Citations can be long formatted strings' }
		);

		return rules;
	}

	/**
	 * Identify the most critical types for chunking optimization
	 */
	static identifyHighValueTypes(schemaInfo: GraphQLSchemaInfo): Array<{
		typeName: string;
		reason: string;
		largeFields: string[];
		estimatedSize: 'small' | 'medium' | 'large' | 'very_large';
	}> {
		const highValueTypes = [];

		// Core entity types that typically have large content
		const coreTypes = ['EvidenceItem', 'Gene', 'Source', 'Assertion', 'MolecularProfile'];
		
		for (const typeName of coreTypes) {
			const typeInfo = schemaInfo.types[typeName];
			if (typeInfo) {
				const largeFields = Object.keys(typeInfo.fields).filter(fieldName => 
					this.isLikelyLargeField(fieldName, typeInfo.fields[fieldName])
				);
				
				highValueTypes.push({
					typeName,
					reason: `Core CIViC entity with ${largeFields.length} potentially large fields`,
					largeFields,
					estimatedSize: this.estimateTypeSize(typeInfo)
				});
			}
		}

		return highValueTypes;
	}

	// Private helper methods

	private static shouldSkipType(typeName: string): boolean {
		// Skip GraphQL built-in types, input types, and connection/edge types
		const skipPatterns = [
			/^__/,  // Introspection types
			/Input$/,  // Input types
			/Payload$/,  // Mutation payloads
			/Connection$/,  // GraphQL connections
			/Edge$/,  // GraphQL edges
			/^(String|Int|Float|Boolean|ID)$/,  // Scalars
		];
		
		return skipPatterns.some(pattern => pattern.test(typeName));
	}

	private static parseFields(typeBody: string, typeName: string, relationships: any[]): Record<string, GraphQLFieldInfo> {
		const fields: Record<string, GraphQLFieldInfo> = {};
		
		// Match field definitions - handle both simple and complex cases
		const fieldMatches = typeBody.matchAll(/^\s*([a-zA-Z]\w*)\s*(?:\([^)]*\))?\s*:\s*([^!\n]+[!]?)/gm);
		
		for (const match of fieldMatches) {
			const fieldName = match[1];
			const fieldType = match[2].trim();
			
			// Skip comment-like patterns
			if (fieldName.includes('"""') || fieldType.includes('"""')) {
				continue;
			}

			const fieldInfo = this.parseFieldType(fieldType);
			fields[fieldName] = {
				name: fieldName,
				...fieldInfo
			};

			// Track relationships
			if (this.isRelationshipField(fieldInfo, typeName)) {
				relationships.push({
					fromType: typeName,
					toType: this.extractRelatedType(fieldInfo.type),
					fieldName: fieldName,
					cardinality: fieldInfo.isList ? 'one-to-many' : 'one-to-one'
				});
			}
		}

		return fields;
	}

	private static parseFieldType(typeString: string): Omit<GraphQLFieldInfo, 'name'> {
		let type = typeString.trim();
		let isList = false;
		let isNullable = true;

		// Handle list types
		if (type.startsWith('[') && type.endsWith(']')) {
			isList = true;
			type = type.slice(1, -1);
		}

		// Handle non-null types
		if (type.endsWith('!')) {
			isNullable = false;
			type = type.slice(0, -1);
		}

		// Handle nested non-null in lists
		if (isList && type.endsWith('!')) {
			type = type.slice(0, -1);
		}

		return {
			type: type.trim(),
			isList,
			isNullable
		};
	}

	private static isRelationshipField(fieldInfo: Omit<GraphQLFieldInfo, 'name'>, typeName: string): boolean {
		// Skip scalar types
		const scalarTypes = ['String', 'Int', 'Float', 'Boolean', 'ID', 'JSON', 'ISO8601DateTime'];
		if (scalarTypes.includes(fieldInfo.type)) {
			return false;
		}

		// Skip enum-like types (they usually end with specific patterns)
		const enumPatterns = [/Level$/, /Type$/, /Status$/, /Direction$/];
		if (enumPatterns.some(pattern => pattern.test(fieldInfo.type))) {
			return false;
		}

		return true;
	}

	private static extractRelatedType(typeString: string): string {
		// Remove any remaining brackets or exclamation marks
		return typeString.replace(/[[\]!]/g, '');
	}

	private static extractDescription(typeDefinition: string): string | undefined {
		const descMatch = typeDefinition.match(/"""([^"]+)"""/);
		return descMatch ? descMatch[1].trim() : undefined;
	}

	private static generateFieldRule(typeName: string, fieldName: string, fieldInfo: GraphQLFieldInfo): FieldChunkingRule | null {
		// Generate rules for likely large content fields
		if (this.isLikelyLargeField(fieldName, fieldInfo)) {
			if (fieldInfo.type === 'String') {
				// Text fields that are likely to be large
				const textFieldThresholds: Record<string, number> = {
					'description': 1024,
					'summary': 1024,
					'abstract': 2048,
					'statement': 2048,
					'citation': 1024,
					'authorString': 512,
					'fullName': 256,
					'title': 1024
				};

				const threshold = textFieldThresholds[fieldName] || 512;
				
				return {
					fieldName,
					typeName,
					chunkThreshold: threshold,
					priority: 'size-based',
					reason: `String field '${fieldName}' on type '${typeName}' likely contains large text content`
				};
			} else if (fieldInfo.type === 'JSON') {
				// JSON fields can be very large
				return {
					fieldName,
					typeName,
					chunkThreshold: 4096,
					priority: 'size-based',
					reason: `JSON field '${fieldName}' on type '${typeName}' can contain large structured data`
				};
			} else if (fieldInfo.isList) {
				// List fields can accumulate to large sizes
				return {
					fieldName,
					typeName,
					chunkThreshold: 8192,
					priority: 'size-based',
					reason: `List field '${fieldName}' on type '${typeName}' can contain many items`
				};
			}
		}

		return null;
	}

	private static isLikelyLargeField(fieldName: string, fieldInfo: GraphQLFieldInfo): boolean {
		const largeContentIndicators = [
			'description', 'summary', 'statement', 'content', 'text', 'body',
			'abstract', 'citation', 'authorString', 'fullName', 'title',
			'metadata', 'details', 'comments', 'notes', 'evidence'
		];
		
		// Check field name
		if (largeContentIndicators.some(indicator => 
			fieldName.toLowerCase().includes(indicator)
		)) {
			return true;
		}

		// Check if it's a JSON field (these can be large)
		if (fieldInfo.type === 'JSON') {
			return true;
		}

		// Check if it's a connection field (GraphQL pagination)
		if (fieldInfo.type.includes('Connection')) {
			return true;
		}

		// Check if it's a list that could accumulate size
		if (fieldInfo.isList && !fieldName.includes('Id')) {
			return true;
		}

		return false;
	}

	private static estimateTypeSize(typeInfo: GraphQLTypeInfo): 'small' | 'medium' | 'large' | 'very_large' {
		const fieldCount = Object.keys(typeInfo.fields).length;
		const largeFieldCount = Object.entries(typeInfo.fields).filter(([name, field]) => 
			this.isLikelyLargeField(name, field)
		).length;

		if (largeFieldCount >= 5 || fieldCount >= 50) {
			return 'very_large';
		} else if (largeFieldCount >= 3 || fieldCount >= 30) {
			return 'large';
		} else if (largeFieldCount >= 1 || fieldCount >= 15) {
			return 'medium';
		} else {
			return 'small';
		}
	}

	/**
	 * Parse the GraphQL schema file and extract structure information
	 */
	async parseSchemaFromFile(schemaPath: string): Promise<GraphQLSchemaInfo> {
		// For Cloudflare Workers environment, we'd need to pass content differently
		// This is a placeholder - in practice, schema content would be loaded at build time
		// or passed as a parameter
		throw new Error('File system access not available in Workers environment. Use parseSchemaContent() instead.');
	}

	/**
	 * Parse GraphQL schema content and extract type/relationship information
	 */
	parseSchemaContent(schemaContent: string): GraphQLSchemaInfo {
		const types: Record<string, GraphQLTypeInfo> = {};
		const relationships: Array<{fromType: string, toType: string, fieldName: string, cardinality: string}> = [];

		// Split schema into type definitions
		const typeBlocks = this.extractTypeBlocks(schemaContent);

		for (const block of typeBlocks) {
			const typeInfo = this.parseTypeBlock(block);
			if (typeInfo) {
				types[typeInfo.name] = typeInfo;
				
				// Extract relationships from this type
				const typeRelationships = this.extractRelationshipsFromType(typeInfo);
				relationships.push(...typeRelationships);
			}
		}

		this.schemaInfo = { types, relationships };
		this.generateExtractionRules();
		
		return this.schemaInfo;
	}

	/**
	 * Get extraction rules for intelligent entity processing
	 */
	getExtractionRules(): FieldExtractionRule[] {
		return this.extractionRules;
	}

	/**
	 * Get relationship information
	 */
	getRelationships(): EntityRelationshipInfo[] {
		return this.relationships;
	}

	/**
	 * Check if a field should have its entities extracted vs stored as JSON
	 */
	shouldExtractEntities(typeName: string, fieldName: string): {
		extract: boolean;
		targetType?: string;
		isListField: boolean;
	} {
		const rule = this.extractionRules.find(r => 
			(r.typeName === typeName || r.typeName === '*') && r.fieldName === fieldName
		);

		if (rule) {
			return {
				extract: rule.shouldExtractEntities,
				targetType: rule.targetEntityType,
				isListField: rule.isListField
			};
		}

		// Default: extract if field name suggests entities
		const entityFieldPatterns = [
			/.*therapies?$/i,
			/.*diseases?$/i,
			/.*genes?$/i,
			/.*variants?$/i,
			/.*evidences?$/i,
			/.*sources?$/i,
			/.*users?$/i,
			/.*organizations?$/i
		];

		const suggestsEntities = entityFieldPatterns.some(pattern => pattern.test(fieldName));
		
		return {
			extract: suggestsEntities,
			targetType: this.inferTargetType(fieldName),
			isListField: fieldName.endsWith('s') // Simple heuristic
		};
	}

	/**
	 * Extract type definition blocks from schema content
	 */
	private extractTypeBlocks(schemaContent: string): string[] {
		const typeBlocks: string[] = [];
		const lines = schemaContent.split('\n');
		
		let currentBlock = '';
		let inTypeDefinition = false;
		let braceCount = 0;

		for (const line of lines) {
			const trimmedLine = line.trim();
			
			// Skip comments and empty lines when not in a type
			if (!inTypeDefinition && (trimmedLine.startsWith('#') || trimmedLine === '')) {
				continue;
			}

			// Check for type definition start
			if (trimmedLine.match(/^(type|interface|enum|input)\s+\w+/)) {
				// Save previous block if exists
				if (currentBlock.trim()) {
					typeBlocks.push(currentBlock.trim());
				}
				currentBlock = line + '\n';
				inTypeDefinition = true;
				braceCount = 0;
			} else if (inTypeDefinition) {
				currentBlock += line + '\n';
				
				// Count braces to determine when type definition ends
				braceCount += (line.match(/\{/g) || []).length;
				braceCount -= (line.match(/\}/g) || []).length;
				
				if (braceCount === 0 && trimmedLine.includes('}')) {
					typeBlocks.push(currentBlock.trim());
					currentBlock = '';
					inTypeDefinition = false;
				}
			}
		}

		// Add final block if exists
		if (currentBlock.trim()) {
			typeBlocks.push(currentBlock.trim());
		}

		return typeBlocks;
	}

	/**
	 * Parse individual type block into TypeInfo
	 */
	private parseTypeBlock(block: string): GraphQLTypeInfo | null {
		const lines = block.split('\n');
		const firstLine = lines[0].trim();
		
		// Extract type name and kind
		const typeMatch = firstLine.match(/^(type|interface|enum|input)\s+(\w+)/);
		if (!typeMatch) return null;

		const [, kind, name] = typeMatch;
		const fields: Record<string, GraphQLFieldInfo> = {};

		// Parse fields (skip first and last lines which are type declaration and closing brace)
		for (let i = 1; i < lines.length - 1; i++) {
			const line = lines[i].trim();
			if (line && !line.startsWith('#') && !line.startsWith('"""')) {
				const fieldInfo = this.parseFieldLine(line);
				if (fieldInfo) {
					fields[fieldInfo.name] = fieldInfo;
				}
			}
		}

		return {
			name,
			kind: kind.toUpperCase() as 'OBJECT' | 'SCALAR' | 'ENUM' | 'INTERFACE',
			fields,
			description: this.extractDescription(block)
		};
	}

	/**
	 * Parse individual field line
	 */
	private parseFieldLine(line: string): GraphQLFieldInfo | null {
		// Match field patterns like: fieldName: Type, fieldName: [Type], fieldName(args): Type
		const fieldMatch = line.match(/^(\w+)(?:\([^)]*\))?:\s*(\[?)([^!\[\]]+)(!?)\]?(!?)/);
		if (!fieldMatch) return null;

		const [, name, listStart, type, typeRequired, listRequired] = fieldMatch;
		
		return {
			name,
			type: type.trim(),
			isList: !!listStart,
			isNullable: !typeRequired && !listRequired,
			description: undefined // Could be enhanced to extract field descriptions
		};
	}

	/**
	 * Extract relationships from a type definition
	 */
	private extractRelationshipsFromType(typeInfo: GraphQLTypeInfo): Array<{fromType: string, toType: string, fieldName: string, cardinality: string}> {
		const relationships = [];

		for (const [fieldName, fieldInfo] of Object.entries(typeInfo.fields)) {
			// Check if this field references another entity type
			if (this.isEntityType(fieldInfo.type)) {
				const cardinality = fieldInfo.isList ? 'one-to-many' : 'one-to-one';
				relationships.push({
					fromType: typeInfo.name,
					toType: fieldInfo.type,
					fieldName,
					cardinality
				});
			}
		}

		return relationships;
	}

	/**
	 * Check if a type name represents an entity (vs scalar)
	 */
	private isEntityType(typeName: string): boolean {
		const scalarTypes = ['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'ISO8601DateTime'];
		return !scalarTypes.includes(typeName) && typeName[0] === typeName[0].toUpperCase();
	}

	/**
	 * Generate field extraction rules based on schema analysis
	 */
	private generateExtractionRules(): void {
		if (!this.schemaInfo) return;

		this.extractionRules = [];

		for (const [typeName, typeInfo] of Object.entries(this.schemaInfo.types)) {
			for (const [fieldName, fieldInfo] of Object.entries(typeInfo.fields)) {
				// Rule: Extract entities from list fields that reference entity types
				if (fieldInfo.isList && this.isEntityType(fieldInfo.type)) {
					this.extractionRules.push({
						fieldName,
						typeName,
						shouldExtractEntities: true,
						targetEntityType: fieldInfo.type,
						isListField: true
					});
				}
				// Rule: Extract entities from single entity reference fields
				else if (!fieldInfo.isList && this.isEntityType(fieldInfo.type)) {
					this.extractionRules.push({
						fieldName,
						typeName,
						shouldExtractEntities: true,
						targetEntityType: fieldInfo.type,
						isListField: false
					});
				}
				// Rule: Don't extract from scalar fields
				else {
					this.extractionRules.push({
						fieldName,
						typeName,
						shouldExtractEntities: false,
						isListField: fieldInfo.isList
					});
				}
			}
		}

		// Add global rules for common patterns
		this.extractionRules.push(
			{ fieldName: 'id', typeName: '*', shouldExtractEntities: false, isListField: false },
			{ fieldName: 'name', typeName: '*', shouldExtractEntities: false, isListField: false },
			{ fieldName: 'description', typeName: '*', shouldExtractEntities: false, isListField: false }
		);
	}

	/**
	 * Infer target entity type from field name
	 */
	private inferTargetType(fieldName: string): string {
		// Remove plural 's' and capitalize
		const singular = fieldName.endsWith('s') ? fieldName.slice(0, -1) : fieldName;
		return singular.charAt(0).toUpperCase() + singular.slice(1);
	}

	/**
	 * Extract description from type block
	 */
	private extractDescription(block: string): string | undefined {
		const descMatch = block.match(/"""([\s\S]*?)"""/);
		return descMatch ? descMatch[1].trim() : undefined;
	}
} 