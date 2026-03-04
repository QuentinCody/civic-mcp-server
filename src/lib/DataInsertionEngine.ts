import { TableSchema } from "./types.js";
import { ChunkingEngine } from "./ChunkingEngine.js";
import { SchemaParser, FieldExtractionRule } from "./SchemaParser.js";

export class DataInsertionEngine {
	private chunkingEngine = new ChunkingEngine();
	private schemaParser = new SchemaParser();
	private processedEntities: Map<string, Map<any, number>> = new Map();
	private relationshipData: Map<string, Set<string>> = new Map(); // Track actual relationships found in data
	private extractionRules: FieldExtractionRule[] = [];
	
	/**
	 * Configure schema-aware entity extraction
	 */
	configureSchemaAwareExtraction(schemaContent: string): void {
		const schemaInfo = this.schemaParser.parseSchemaContent(schemaContent);
		this.extractionRules = this.schemaParser.getExtractionRules();
		this.chunkingEngine.configureSchemaAwareness(schemaInfo);
	}

	/**
	 * Check if entities should be extracted from a field based on schema rules
	 */
	private shouldExtractEntitiesFromField(typeName: string, fieldName: string): {
		extract: boolean;
		targetType?: string;
		isListField: boolean;
	} {
		return this.schemaParser.shouldExtractEntities(typeName, fieldName);
	}

	async insertData(data: any, schemas: Record<string, TableSchema>, sql: any): Promise<void> {
		// Reset state for new insertion
		this.processedEntities.clear();
		this.relationshipData.clear();

		const schemaNames = Object.keys(schemas);

		// Check if this is one of the simple fallback schemas
		if (schemaNames.length === 1 && (schemaNames[0] === 'scalar_data' || schemaNames[0] === 'array_data' || schemaNames[0] === 'root_object')) {
			const tableName = schemaNames[0];
			const schema = schemas[tableName];
			if (tableName === 'scalar_data' || tableName === 'root_object') {
				await this.insertSimpleRow(data, tableName, schema, sql);
			} else { // array_data
				if (Array.isArray(data)) {
					for (const item of data) {
						await this.insertSimpleRow(item, tableName, schema, sql);
					}
				} else {
					await this.insertSimpleRow(data, tableName, schema, sql); 
				}
			}
			return;
		}

		// Phase 1: Insert all entities first (to establish primary keys)
		await this.insertAllEntities(data, schemas, sql);
		
		// Phase 2: Handle relationships via junction tables (only for tables with data)
		await this.insertJunctionTableRecords(data, schemas, sql);
	}

	private async insertAllEntities(obj: any, schemas: Record<string, TableSchema>, sql: any, path: string[] = []): Promise<void> {
		if (!obj || typeof obj !== 'object') return;

		if (Array.isArray(obj)) {
			for (const item of obj) {
				await this.insertAllEntities(item, schemas, sql, path);
			}
			return;
		}

		// Handle GraphQL edges pattern
		if (obj.edges && Array.isArray(obj.edges)) {
			const nodes = obj.edges.map((edge: any) => edge.node).filter(Boolean);
			for (const node of nodes) {
				await this.insertAllEntities(node, schemas, sql, path);
			}
			return;
		}

		// CHILDREN FIRST: Recursively process all nested values before this entity
		for (const [key, value] of Object.entries(obj)) {
			if (value && typeof value === 'object') {
				await this.insertAllEntities(value, schemas, sql, [...path, key]);
			}
		}

		// THEN insert this entity (all nested entities are now available for FK resolution)
		if (this.isEntity(obj)) {
			const entityType = this.inferEntityType(obj, path);
			if (schemas[entityType]) {
				const entityId = await this.insertEntityRecord(obj, entityType, schemas[entityType], sql);
				if (entityId !== null) {
					this.trackEntityRelationships(obj, entityType, entityId, schemas);
				}
			}
		}
	}

	private trackEntityRelationships(entity: any, entityType: string, entityId: number | string, schemas: Record<string, TableSchema>): void {
		for (const [key, value] of Object.entries(entity)) {
			// Unwrap {nodes: [...]} or {edges: [{node: ...}]} wrappers, or use array directly
			let items: any[] | null = null;
			if (Array.isArray(value) && value.length > 0) {
				items = value;
			} else if (value && typeof value === 'object' && !Array.isArray(value)) {
				const wrapper = value as Record<string, any>;
				if (wrapper.nodes && Array.isArray(wrapper.nodes)) {
					items = wrapper.nodes;
				} else if (wrapper.edges && Array.isArray(wrapper.edges)) {
					items = wrapper.edges.map((e: any) => e.node).filter(Boolean);
				}
			}
			if (!items || items.length === 0) continue;

			const firstItem = items.find(item => this.isEntity(item));
			if (!firstItem) continue;

			const relatedEntityType = this.inferEntityType(firstItem, [key]);
			const junctionName = [entityType, relatedEntityType].sort().join('_');
			if (!schemas[junctionName]) continue;

			const relationships = this.relationshipData.get(junctionName) || new Set<string>();
			for (const item of items) {
				if (!this.isEntity(item)) continue;
				const relatedId = this.getEntityId(item, relatedEntityType);
				if (relatedId !== null) {
					const [first] = [entityType, relatedEntityType].sort();
					const id1 = first === entityType ? entityId : relatedId;
					const id2 = first === entityType ? relatedId : entityId;
					relationships.add(`${id1}::${id2}`);
				}
			}
			this.relationshipData.set(junctionName, relationships);
		}
	}
	
	private async insertEntityRecord(entity: any, tableName: string, schema: TableSchema, sql: any): Promise<number | string | null> {
		// Check if this entity was already processed
		const entityMap = this.processedEntities.get(tableName) || new Map();
		if (entityMap.has(entity)) {
			return entityMap.get(entity)!;
		}

		const rowData = await this.mapEntityToSchema(entity, schema, sql);
		if (Object.keys(rowData).length === 0) return null;

		const columns = Object.keys(rowData);
		const placeholders = columns.map(() => '?').join(', ');
		const values = Object.values(rowData);

		let insertedId: number | string | null = null;

		if (entity.id && (typeof entity.id === 'string' || typeof entity.id === 'number')) {
			insertedId = entity.id;
			const insertSQL = `INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
			sql.exec(insertSQL, ...values);
		} else {
			const insertSQL = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
			sql.exec(insertSQL, ...values);
			try {
				insertedId = sql.exec(`SELECT last_insert_rowid() as lid`).toArray()[0]?.lid ?? null;
			} catch { insertedId = null; }
		}

		if (insertedId !== null) {
			entityMap.set(entity, insertedId);
			this.processedEntities.set(tableName, entityMap);
		}

		return insertedId;
	}
	
	private async insertJunctionTableRecords(data: any, schemas: Record<string, TableSchema>, sql: any): Promise<void> {
		for (const [junctionName, pairs] of this.relationshipData.entries()) {
			if (!schemas[junctionName]) continue;
			const columns = Object.keys(schemas[junctionName].columns).filter(c => c.endsWith('_id'));
			if (columns.length < 2) continue;

			for (const pairKey of pairs) {
				const [id1Str, id2Str] = pairKey.split('::');
				const id1 = isNaN(Number(id1Str)) ? id1Str : Number(id1Str);
				const id2 = isNaN(Number(id2Str)) ? id2Str : Number(id2Str);
				const insertSQL = `INSERT OR IGNORE INTO ${junctionName} (${columns[0]}, ${columns[1]}) VALUES (?, ?)`;
				sql.exec(insertSQL, id1, id2);
			}
		}
	}
	
	private getEntityId(entity: any, entityType: string): number | string | null {
		const entityMap = this.processedEntities.get(entityType);
		return entityMap?.get(entity) ?? null;
	}
	
	private async mapEntityToSchema(obj: any, schema: TableSchema, sql: any): Promise<any> {
		const rowData: any = {};
		
		if (!obj || typeof obj !== 'object') {
			if (schema.columns.value) rowData.value = obj;
			return rowData;
		}
		
		for (const columnName of Object.keys(schema.columns)) {
			if (columnName === 'id' && schema.columns[columnName].includes('AUTOINCREMENT')) {
				continue;
			}
			
			let value = null;
			
			// Handle foreign key columns — prefer entity's own id for natural JOINs
			if (columnName.endsWith('_id') && !columnName.includes('_json')) {
				const baseKey = columnName.slice(0, -3);
				const originalKey = this.findOriginalKey(obj, baseKey);
				if (originalKey && obj[originalKey] && typeof obj[originalKey] === 'object') {
					const nestedEntity = obj[originalKey];
					if (nestedEntity.id !== undefined) {
						value = nestedEntity.id;
					} else {
						// Fallback: look up processedEntities for DB-assigned rowid
						for (const [, entityMap] of this.processedEntities.entries()) {
							if (entityMap.has(nestedEntity)) {
								value = entityMap.get(nestedEntity)!;
								break;
							}
						}
					}
				}
			}
			// Handle prefixed columns (from nested scalar fields)
			else if (columnName.includes('_') && !columnName.endsWith('_json')) {
				// First: try direct flat-key match (e.g., evidence_level → evidenceLevel)
				const directKey = this.findOriginalKey(obj, columnName);
				if (directKey && obj[directKey] !== undefined && (typeof obj[directKey] !== 'object' || obj[directKey] === null)) {
					value = obj[directKey];
					if (typeof value === 'boolean') value = value ? 1 : 0;
				} else {
					// Fallback: prefix decomposition for genuinely nested fields
					const parts = columnName.split('_');
					if (parts.length >= 2) {
						const baseKey = parts[0];
						const subKey = parts.slice(1).join('_');
						const originalKey = this.findOriginalKey(obj, baseKey);
						if (originalKey && obj[originalKey] && typeof obj[originalKey] === 'object') {
							const nestedObj = obj[originalKey];
							const originalSubKey = this.findOriginalKey(nestedObj, subKey);
							if (originalSubKey && nestedObj[originalSubKey] !== undefined) {
								value = nestedObj[originalSubKey];
								if (typeof value === 'boolean') value = value ? 1 : 0;
							}
						}
					}
				}
			}
			// Handle JSON columns with chunking
			else if (columnName.endsWith('_json')) {
				const baseKey = columnName.slice(0, -5);
				const originalKey = this.findOriginalKey(obj, baseKey);
				if (originalKey && obj[originalKey] && typeof obj[originalKey] === 'object') {
					value = await this.chunkingEngine.smartJsonStringify(obj[originalKey], sql);
				}
			}
			// Handle regular columns
			else {
				const originalKey = this.findOriginalKey(obj, columnName);
				if (originalKey && obj[originalKey] !== undefined) {
					value = obj[originalKey];
					if (typeof value === 'boolean') value = value ? 1 : 0;
					
					// Skip arrays of entities (they're handled via junction tables)
					if (Array.isArray(value) && value.length > 0 && this.isEntity(value[0])) {
						continue;
					}
				}
			}
			
			if (value !== null && value !== undefined) {
				rowData[columnName] = value;
			}
		}
		
		return rowData;
	}
	
	// Entity detection and type inference (reuse logic from SchemaInferenceEngine)
	private isEntity(obj: any): boolean {
		if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
		
		const hasId = obj.id !== undefined || obj._id !== undefined;
		const fieldCount = Object.keys(obj).length;
		const hasMultipleFields = fieldCount >= 2;
		
		const hasEntityFields = obj.name !== undefined || obj.title !== undefined || 
			obj.description !== undefined || obj.type !== undefined;
		
		return hasId || (hasMultipleFields && hasEntityFields);
	}
	
	private inferEntityType(obj: any, path: string[]): string {
		if (obj.__typename) return this.sanitizeTableName(obj.__typename);
		if (obj.type && typeof obj.type === 'string' && !['edges', 'node'].includes(obj.type.toLowerCase())) {
			return this.sanitizeTableName(obj.type);
		}

		if (path.length > 0) {
			let lastName = path[path.length - 1];

			// Handle GraphQL patterns (edges/node/nodes/rows are wrappers, not entity names)
			if ((lastName === 'node' || lastName === 'nodes') && path.length > 1) {
				lastName = path[path.length - 2];
				if (lastName === 'edges' && path.length > 2) {
					lastName = path[path.length - 3];
				}
			} else if (lastName === 'edges' && path.length > 1) {
				lastName = path[path.length - 2];
			} else if (lastName === 'rows' && path.length > 1) {
				lastName = path[path.length - 2];
			}

			// Singularize to match SchemaInferenceEngine
			const sanitized = this.sanitizeTableName(lastName);
			if (sanitized.endsWith('ies')) {
				return sanitized.slice(0, -3) + 'y';
			} else if (sanitized.endsWith('s') && !sanitized.endsWith('ss') && sanitized.length > 1) {
				const singular = sanitized.slice(0, -1);
				if (singular.length > 1) return singular;
			}
			return sanitized;
		}

		return 'entity_' + Math.random().toString(36).substr(2, 9);
	}
	
	private sanitizeTableName(name: string): string {
		if (!name || typeof name !== 'string') {
			return 'table_' + Math.random().toString(36).substr(2, 9);
		}
		
		let sanitized = name
			.replace(/[^a-zA-Z0-9_]/g, '_')
			.replace(/_{2,}/g, '_')  // Replace multiple underscores with single
			.replace(/^_|_$/g, '')  // Remove leading/trailing underscores
			.toLowerCase();
		
		// Ensure it doesn't start with a number
		if (/^[0-9]/.test(sanitized)) {
			sanitized = 'table_' + sanitized;
		}
		
		// Ensure it's not empty and not a SQL keyword
		if (!sanitized || sanitized.length === 0) {
			sanitized = 'table_' + Math.random().toString(36).substr(2, 9);
		}
		
		// Handle SQL reserved words
		const reservedWords = ['table', 'index', 'view', 'column', 'primary', 'key', 'foreign', 'constraint'];
		if (reservedWords.includes(sanitized)) {
			sanitized = sanitized + '_table';
		}
		
		return sanitized;
	}
	
	private findOriginalKey(obj: any, sanitizedKey: string): string | null {
		const keys = Object.keys(obj);
		
		// Direct match
		if (keys.includes(sanitizedKey)) return sanitizedKey;
		
		// Find key that sanitizes to the same value
		return keys.find(key => 
			this.sanitizeColumnName(key) === sanitizedKey
		) || null;
	}
	
	private sanitizeColumnName(name: string): string {
		if (!name || typeof name !== 'string') {
			return 'column_' + Math.random().toString(36).substr(2, 9);
		}
		
		// Convert camelCase to snake_case
		let snakeCase = name
			.replace(/([A-Z])/g, '_$1')
			.toLowerCase()
			.replace(/[^a-zA-Z0-9_]/g, '_')
			.replace(/_{2,}/g, '_')  // Replace multiple underscores with single
			.replace(/^_|_$/g, ''); // Remove leading/trailing underscores
		
		// Ensure it doesn't start with a number
		if (/^[0-9]/.test(snakeCase)) {
			snakeCase = 'col_' + snakeCase;
		}
		
		// Ensure it's not empty
		if (!snakeCase || snakeCase.length === 0) {
			snakeCase = 'column_' + Math.random().toString(36).substr(2, 9);
		}
		
		// Handle common genomics abbreviations properly
		const genomicsTerms: Record<string, string> = {
			'entrezid': 'entrez_id',
			'displayname': 'display_name',
			'varianttype': 'variant_type',
			'evidencelevel': 'evidence_level',
			'evidencetype': 'evidence_type',
			'evidencedirection': 'evidence_direction',
			'sourcetype': 'source_type',
			'molecularprofile': 'molecular_profile',
			'genomicchange': 'genomic_change'
		};
		
		const result = genomicsTerms[snakeCase] || snakeCase;
		
		// Handle SQL reserved words
		const reservedWords = ['table', 'index', 'view', 'column', 'primary', 'key', 'foreign', 'constraint', 'order', 'group', 'select', 'from', 'where'];
		if (reservedWords.includes(result)) {
			return result + '_col';
		}
		
		return result;
	}

	private async insertSimpleRow(obj: any, tableName: string, schema: TableSchema, sql: any): Promise<void> {
		const rowData = await this.mapObjectToSimpleSchema(obj, schema, sql);
		if (Object.keys(rowData).length === 0 && !(tableName === 'scalar_data' && obj === null)) return; // Allow inserting null for scalar_data

		const columns = Object.keys(rowData);
		const placeholders = columns.map(() => '?').join(', ');
		const values = Object.values(rowData);

		const insertSQL = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
		sql.exec(insertSQL, ...values);
	}

	private async mapObjectToSimpleSchema(obj: any, schema: TableSchema, sql: any): Promise<any> {
		const rowData: any = {};

		if (obj === null || typeof obj !== 'object') {
			if (schema.columns.value) { // For scalar_data or array_data of primitives
				rowData.value = obj;
			} else if (Object.keys(schema.columns).length > 0) {
				// This case should ideally not be hit if schema generation is right for primitives
				// but as a fallback, if there's a column, try to put it there.
				const firstCol = Object.keys(schema.columns)[0];
				rowData[firstCol] = obj;
			}
			return rowData;
		}

		if (Array.isArray(obj)) { // For root_object schemas where a field might be an array
			// This function (mapObjectToSimpleSchema) is for a single row. If an array needs to be a column, it should be JSON.
			// This case likely means the schema is `root_object` and `obj` is one of its fields being mapped.
			// The schema definition for `root_object` via `extractSimpleFields` handles JSON stringification.
			// So, this specific path in mapObjectToSimpleSchema might be redundant if schema is well-defined.
			// For safety, if a column expects `_json` for this array, it will be handled by the loop below.
		}

		for (const columnName of Object.keys(schema.columns)) {
			let valueToInsert = undefined;
			let originalKeyFound = false;

			if (columnName.endsWith('_json')) {
				const baseKey = columnName.slice(0, -5);
				const originalKey = this.findOriginalKey(obj, baseKey);
				if (originalKey && obj[originalKey] !== undefined) {
					valueToInsert = await this.chunkingEngine.smartJsonStringify(obj[originalKey], sql);
					originalKeyFound = true;
				}
			} else {
				const originalKey = this.findOriginalKey(obj, columnName);
				if (originalKey && obj[originalKey] !== undefined) {
					const val = obj[originalKey];
					if (typeof val === 'boolean') {
						valueToInsert = val ? 1 : 0;
									} else if (typeof val === 'object' && val !== null) {
					// This should not happen if schema is from extractSimpleFields, which JSONifies nested objects.
					// If it does, it implies a mismatch. For safety, try to JSON stringify.
					valueToInsert = await this.chunkingEngine.smartJsonStringify(val, sql);
				} else {
						valueToInsert = val;
					}
					originalKeyFound = true;
				}
			}

			if (originalKeyFound && valueToInsert !== undefined) {
				rowData[columnName] = valueToInsert;
			} else if (obj.hasOwnProperty(columnName) && obj[columnName] !== undefined){ // Direct match as last resort
				// This handles cases where sanitized names might not be used or `findOriginalKey` fails but direct prop exists
				const val = obj[columnName];
				if (typeof val === 'boolean') valueToInsert = val ? 1:0;
				else if (typeof val === 'object' && val !== null) valueToInsert = await this.chunkingEngine.smartJsonStringify(val, sql);
				else valueToInsert = val;
				rowData[columnName] = valueToInsert;
			}
		}
		return rowData;
	}
}
