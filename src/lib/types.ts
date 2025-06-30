export interface TableSchema {
    columns: Record<string, string>;
    sample_data: any[];
    relationships?: Record<string, RelationshipInfo>;
}

export interface RelationshipInfo {
    type: 'foreign_key' | 'junction_table';
    target_table: string;
    foreign_key_column?: string;
    junction_table_name?: string;
}

export interface ProcessingResult {
    success: boolean;
    message?: string;
    schemas?: Record<string, SchemaInfo>;
    table_count?: number;
    total_rows?: number;
    pagination?: PaginationInfo;
    _meta?: {
        processing_time?: number;
        schema_inference_method?: string;
        chunking_applied?: boolean;
        [key: string]: any;
    };
}

export interface SchemaInfo {
    columns: Record<string, string>;
    row_count: number;
    sample_data: any[];
    relationships?: Record<string, RelationshipInfo>;
    _meta?: {
        inferred_from?: string;
        confidence_score?: number;
        chunked_fields?: string[];
        [key: string]: any;
    };
}

export interface PaginationInfo {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    currentCount: number;
    totalCount: number | null;
    endCursor: string | null;
    startCursor: string | null;
    suggestion?: string;
    _meta?: {
        detected_from?: string;
        cursor_type?: string;
        page_size?: number;
        [key: string]: any;
    };
}

export interface EntityContext {
    entityData?: any;
    parentTable?: string;
    parentKey?: string;
    relationshipType?: 'one_to_one' | 'one_to_many' | 'many_to_many';
}
