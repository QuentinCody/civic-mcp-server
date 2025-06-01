import { DurableObject } from "cloudflare:workers";

// Types for better extensibility
interface TableSchema {
	columns: Record<string, string>;
	sample_data: any[];
}

interface ProcessingResult {
	success: boolean;
	message?: string;
	schemas?: Record<string, SchemaInfo>;
	table_count?: number;
	total_rows?: number;
	pagination?: PaginationInfo;
}

interface SchemaInfo {
	columns: Record<string, string>;
	row_count: number;
	sample_data: any[];
}

interface PaginationInfo {
	hasNextPage: boolean;
	hasPreviousPage: boolean;
	currentCount: number;
	totalCount: number | null;
	endCursor: string | null;
	startCursor: string | null;
	suggestion?: string;
}

// Schema inference engine - modular and extensible
class SchemaInferenceEngine {
	
	static inferFromJSON(data: any): Record<string, TableSchema> {
		const schemas: Record<string, TableSchema> = {};
		
		// Find arrays and GraphQL edges patterns
		this.findCollections(data, [], schemas);
		
		// Handle single entity responses if no collections found
		if (Object.keys(schemas).length === 0) {
			this.handleSingleEntity(data, schemas);
		}
		
		return schemas;
	}
	
	private static findCollections(obj: any, path: string[], schemas: Record<string, TableSchema>): void {
		if (!obj || typeof obj !== 'object') return;
		
		// Handle direct arrays
		if (Array.isArray(obj) && obj.length > 0) {
			const tableName = this.getTableName(path);
			schemas[tableName] = this.createSchemaFromArray(obj, tableName);
			return;
		}
		
		// Handle GraphQL edges pattern
		if (obj.edges && Array.isArray(obj.edges) && obj.edges.length > 0) {
			const tableName = this.getTableName(path);
			const nodes = obj.edges.map((edge: any) => edge.node).filter(Boolean);
			if (nodes.length > 0) {
				schemas[tableName] = this.createSchemaFromArray(nodes, tableName);
			}
			return;
		}
		
		// Recursive search
		for (const [key, value] of Object.entries(obj)) {
			this.findCollections(value, [...path, key], schemas);
		}
	}
	
	private static handleSingleEntity(data: any, schemas: Record<string, TableSchema>): void {
		if (!data || typeof data !== 'object') return;
		
		const keys = Object.keys(data);
		
		// Check for single entity pattern: { entityName: { fields... } }
		if (keys.length === 1 && data[keys[0]] && typeof data[keys[0]] === 'object' && !Array.isArray(data[keys[0]])) {
			const entityKey = keys[0];
			const tableName = this.sanitizeTableName(entityKey);
			schemas[tableName] = this.createSchemaFromObject(data[entityKey], tableName);
		} else {
			// Generic entity
			schemas.main_entity = this.createSchemaFromObject(data, 'main_entity');
		}
	}
	
	private static createSchemaFromArray(array: any[], tableName: string): TableSchema {
		const columnTypes: Record<string, Set<string>> = {};
		const sampleData: any[] = [];
		
		array.forEach((item, index) => {
			if (index < 3) sampleData.push(this.extractFields(item, columnTypes));
			else this.extractFields(item, columnTypes);
		});
		
		const columns = this.resolveColumnTypes(columnTypes);
		this.ensureIdColumn(columns);
		
		return { columns, sample_data: sampleData };
	}
	
	private static createSchemaFromObject(obj: any, tableName: string): TableSchema {
		const columnTypes: Record<string, Set<string>> = {};
		const rowData = this.extractFields(obj, columnTypes);
		const columns = this.resolveColumnTypes(columnTypes);
		
		this.ensureIdColumn(columns);
		
		return { columns, sample_data: [rowData] };
	}
	
	private static extractFields(obj: any, columnTypes: Record<string, Set<string>>): any {
		const rowData: any = {};
		
		if (!obj || typeof obj !== 'object') {
			this.addColumnType(columnTypes, 'value', this.getSQLiteType(obj));
			return { value: obj };
		}
		
		for (const [key, value] of Object.entries(obj)) {
			const columnName = this.sanitizeColumnName(key);
			
			if (Array.isArray(value)) {
				// Skip arrays - handle as separate tables
				continue;
			} else if (value && typeof value === 'object') {
				// Store complex objects as JSON
				const jsonColumn = columnName + '_json';
				this.addColumnType(columnTypes, jsonColumn, 'TEXT');
				rowData[jsonColumn] = JSON.stringify(value);
			} else {
				// Scalar values
				this.addColumnType(columnTypes, columnName, this.getSQLiteType(value));
				rowData[columnName] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
			}
		}
		
		return rowData;
	}
	
	private static addColumnType(columnTypes: Record<string, Set<string>>, column: string, type: string): void {
		if (!columnTypes[column]) columnTypes[column] = new Set();
		columnTypes[column].add(type);
	}
	
	private static resolveColumnTypes(columnTypes: Record<string, Set<string>>): Record<string, string> {
		const columns: Record<string, string> = {};
		
		for (const [columnName, types] of Object.entries(columnTypes)) {
			if (types.size === 1) {
				columns[columnName] = Array.from(types)[0];
			} else {
				// Mixed types - prefer TEXT > REAL > INTEGER
				columns[columnName] = types.has('TEXT') ? 'TEXT' : types.has('REAL') ? 'REAL' : 'INTEGER';
			}
		}
		
		return columns;
	}
	
	private static ensureIdColumn(columns: Record<string, string>): void {
		if (!columns.id) {
			columns.id = "INTEGER PRIMARY KEY AUTOINCREMENT";
		} else if (columns.id === "INTEGER") {
			columns.id = "INTEGER PRIMARY KEY";
		}
	}
	
	private static getSQLiteType(value: any): string {
		if (value === null || value === undefined) return "TEXT";
		switch (typeof value) {
			case 'number': return Number.isInteger(value) ? "INTEGER" : "REAL";
			case 'boolean': return "INTEGER";
			case 'string': return "TEXT";
			default: return "TEXT";
		}
	}
	
	private static getTableName(path: string[]): string {
		if (path.length === 0) return 'main_table';
		const lastComponent = path[path.length - 1];
		return lastComponent === 'edges' && path.length > 1 
			? this.sanitizeTableName(path[path.length - 2])
			: this.sanitizeTableName(lastComponent);
	}
	
	private static sanitizeTableName(name: string): string {
		return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&').toLowerCase();
	}
	
	private static sanitizeColumnName(name: string): string {
		return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&').toLowerCase();
	}
}

// Data insertion engine - clean and focused
class DataInsertionEngine {
	
	static async insertData(data: any, schemas: Record<string, TableSchema>, sql: any): Promise<void> {
		let foundCollections = false;
		
		// Insert collections first
		await this.findAndInsertCollections(data, [], schemas, sql, (found) => {
			foundCollections = foundCollections || found;
		});
		
		// Handle single entities if no collections found
		if (!foundCollections) {
			await this.insertSingleEntity(data, schemas, sql);
		}
	}
	
	private static async findAndInsertCollections(
		obj: any, 
		path: string[], 
		schemas: Record<string, TableSchema>, 
		sql: any, 
		foundCallback: (found: boolean) => void
	): Promise<void> {
		if (!obj || typeof obj !== 'object') return;
		
		// Handle arrays
		if (Array.isArray(obj) && obj.length > 0) {
			const tableName = SchemaInferenceEngine['getTableName'](path);
			if (schemas[tableName]) {
				foundCallback(true);
				await this.insertArray(obj, tableName, schemas[tableName], sql);
			}
			return;
		}
		
		// Handle GraphQL edges
		if (obj.edges && Array.isArray(obj.edges) && obj.edges.length > 0) {
			const tableName = SchemaInferenceEngine['getTableName'](path);
			if (schemas[tableName]) {
				foundCallback(true);
				const nodes = obj.edges.map((edge: any) => edge.node).filter(Boolean);
				await this.insertArray(nodes, tableName, schemas[tableName], sql);
			}
			return;
		}
		
		// Recursive search
		for (const [key, value] of Object.entries(obj)) {
			await this.findAndInsertCollections(value, [...path, key], schemas, sql, foundCallback);
		}
	}
	
	private static async insertSingleEntity(data: any, schemas: Record<string, TableSchema>, sql: any): Promise<void> {
		const schemaNames = Object.keys(schemas);
		if (schemaNames.length === 0) return;
		
		const tableName = schemaNames[0];
		
		// Handle named entity pattern
		if (tableName !== 'main_entity') {
			const keys = Object.keys(data);
			if (keys.length === 1 && data[keys[0]] && typeof data[keys[0]] === 'object') {
				await this.insertSingleRow(data[keys[0]], tableName, schemas[tableName], sql);
				return;
			}
		}
		
		// Generic insertion
		await this.insertSingleRow(data, tableName, schemas[tableName], sql);
	}
	
	private static async insertArray(array: any[], tableName: string, schema: TableSchema, sql: any): Promise<void> {
		for (const item of array) {
			await this.insertSingleRow(item, tableName, schema, sql);
		}
	}
	
	private static async insertSingleRow(obj: any, tableName: string, schema: TableSchema, sql: any): Promise<void> {
		const rowData = this.mapObjectToSchema(obj, schema);
		if (Object.keys(rowData).length === 0) return;
		
		const columns = Object.keys(rowData);
		const placeholders = columns.map(() => '?').join(', ');
		const values = Object.values(rowData);
		
		const insertSQL = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
		sql.exec(insertSQL, ...values);
	}
	
	private static mapObjectToSchema(obj: any, schema: TableSchema): any {
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
			
			if (columnName.endsWith('_json')) {
				const baseKey = columnName.slice(0, -5);
				const originalKey = this.findOriginalKey(obj, baseKey);
				if (originalKey && obj[originalKey] && typeof obj[originalKey] === 'object') {
					value = JSON.stringify(obj[originalKey]);
				}
			} else {
				const originalKey = this.findOriginalKey(obj, columnName);
				if (originalKey && obj[originalKey] !== undefined) {
					value = obj[originalKey];
					if (typeof value === 'boolean') value = value ? 1 : 0;
				}
			}
			
			if (value !== null && value !== undefined) {
				rowData[columnName] = value;
			}
		}
		
		return rowData;
	}
	
	private static findOriginalKey(obj: any, sanitizedKey: string): string | null {
		const keys = Object.keys(obj);
		
		// Direct match
		if (keys.includes(sanitizedKey)) return sanitizedKey;
		
		// Find key that sanitizes to the same value
		return keys.find(key => 
			SchemaInferenceEngine['sanitizeColumnName'](key) === sanitizedKey
		) || null;
	}
}

// Pagination analyzer - clean utility
class PaginationAnalyzer {
	
	static extractInfo(data: any): PaginationInfo {
		const result: PaginationInfo = {
			hasNextPage: false,
			hasPreviousPage: false,
			currentCount: 0,
			totalCount: null,
			endCursor: null,
			startCursor: null
		};
		
		const pageInfo = this.findPageInfo(data);
		if (pageInfo) {
			Object.assign(result, {
				hasNextPage: pageInfo.hasNextPage || false,
				hasPreviousPage: pageInfo.hasPreviousPage || false,
				endCursor: pageInfo.endCursor,
				startCursor: pageInfo.startCursor
			});
		}
		
		result.totalCount = this.findTotalCount(data);
		result.currentCount = this.countCurrentItems(data);
		
		if (result.hasNextPage) {
			result.suggestion = `Use pagination to get more than ${result.currentCount} records. Add "pageInfo { hasNextPage endCursor }" to your query and use "after: \\"${result.endCursor}\\"" for next page.`;
		}
		
		return result;
	}
	
	private static findPageInfo(obj: any): any {
		if (!obj || typeof obj !== 'object') return null;
		if (obj.pageInfo && typeof obj.pageInfo === 'object') return obj.pageInfo;
		
		for (const value of Object.values(obj)) {
			const found = this.findPageInfo(value);
			if (found) return found;
		}
		return null;
	}
	
	private static findTotalCount(obj: any): number | null {
		if (!obj || typeof obj !== 'object') return null;
		if (typeof obj.totalCount === 'number') return obj.totalCount;
		
		for (const value of Object.values(obj)) {
			const found = this.findTotalCount(value);
			if (found !== null) return found;
		}
		return null;
	}
	
	private static countCurrentItems(obj: any): number {
		// Count edges arrays first
		const edgesArrays: any[][] = [];
		this.findEdgesArrays(obj, edgesArrays);
		
		if (edgesArrays.length > 0) {
			return edgesArrays.reduce((sum, edges) => sum + edges.length, 0);
		}
		
		// Fallback to general array counting
		return this.countArrayItems(obj);
	}
	
	private static findEdgesArrays(obj: any, result: any[][]): void {
		if (!obj || typeof obj !== 'object') return;
		if (Array.isArray(obj.edges)) result.push(obj.edges);
		
		for (const value of Object.values(obj)) {
			this.findEdgesArrays(value, result);
		}
	}
	
	private static countArrayItems(obj: any): number {
		if (!obj || typeof obj !== 'object') return 0;
		
		let count = 0;
		for (const value of Object.values(obj)) {
			if (Array.isArray(value)) {
				count += value.length;
			} else if (typeof value === 'object') {
				count += this.countArrayItems(value);
			}
		}
		return count;
	}
}

// Main Durable Object class - clean and focused
export class JsonToSqlDO extends DurableObject {
	constructor(ctx: DurableObjectState, env: any) {
		super(ctx, env);
	}

	async processAndStoreJson(jsonData: any): Promise<ProcessingResult> {
		try {
			// Extract GraphQL data if present
			const dataToProcess = jsonData?.data ? jsonData.data : jsonData;
			
			// Analyze pagination
			const paginationInfo = PaginationAnalyzer.extractInfo(dataToProcess);
			
			// Infer schema
			const schemas = SchemaInferenceEngine.inferFromJSON(dataToProcess);
			
			// Create tables
			await this.createTables(schemas);
			
			// Insert data
			await DataInsertionEngine.insertData(dataToProcess, schemas, this.ctx.storage.sql);
			
			// Generate metadata
			const metadata = await this.generateMetadata(schemas);
			
			// Add pagination if available
			if (paginationInfo.hasNextPage) {
				metadata.pagination = paginationInfo;
			}
			
			return {
				success: true,
				message: "Data processed successfully",
				...metadata
			};
			
		} catch (error) {
			return {
				success: false,
				message: error instanceof Error ? error.message : "Processing failed"
			};
		}
	}

	async executeSql(sqlQuery: string): Promise<any> {
		try {
			// Validate read-only query
			if (!sqlQuery.trim().toLowerCase().startsWith('select')) {
				throw new Error("Only SELECT queries are allowed");
			}

			const result = this.ctx.storage.sql.exec(sqlQuery);
			const results = result.toArray();

			return {
				success: true,
				results,
				row_count: results.length,
				column_names: result.columnNames || []
			};

		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "SQL execution failed",
				query: sqlQuery
			};
		}
	}

	private async createTables(schemas: Record<string, TableSchema>): Promise<void> {
		for (const [tableName, schema] of Object.entries(schemas)) {
			const columnDefs = Object.entries(schema.columns)
				.map(([name, type]) => `${name} ${type}`)
				.join(', ');

			const createTableSQL = `CREATE TABLE IF NOT EXISTS ${tableName} (${columnDefs})`;
			this.ctx.storage.sql.exec(createTableSQL);
		}
	}
	
	private async generateMetadata(schemas: Record<string, TableSchema>): Promise<Partial<ProcessingResult>> {
		const metadata: Partial<ProcessingResult> = {
			schemas: {},
			table_count: Object.keys(schemas).length,
			total_rows: 0
		};

		for (const [tableName, schema] of Object.entries(schemas)) {
			try {
				const countResult = this.ctx.storage.sql.exec(`SELECT COUNT(*) as count FROM ${tableName}`);
				const countRow = countResult.one();
				const rowCount = typeof countRow?.count === 'number' ? countRow.count : 0;

				const sampleResult = this.ctx.storage.sql.exec(`SELECT * FROM ${tableName} LIMIT 3`);
				const sampleData = sampleResult.toArray();

				metadata.schemas![tableName] = {
					columns: schema.columns,
					row_count: rowCount,
					sample_data: sampleData
				};

				metadata.total_rows! += rowCount;

			} catch (error) {
				// Continue with other tables on error
				continue;
			}
		}

		return metadata;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		try {
			if (url.pathname === '/process' && request.method === 'POST') {
				const jsonData = await request.json();
				const result = await this.processAndStoreJson(jsonData);
				return new Response(JSON.stringify(result), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else if (url.pathname === '/query' && request.method === 'POST') {
				const { sql } = await request.json() as { sql: string };
				const result = await this.executeSql(sql);
				return new Response(JSON.stringify(result), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else {
				return new Response('Not Found', { status: 404 });
			}
		} catch (error) {
			return new Response(JSON.stringify({
				error: error instanceof Error ? error.message : 'Unknown error'
			}), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}
}