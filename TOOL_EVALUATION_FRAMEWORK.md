# CIViC MCP Server Tool Evaluation Framework

## Overview

This framework provides comprehensive instructions and evaluation tests for two critical tools in the civic-mcp-server:

1. **`civic_graphql_query`** - Data Ingestion & Staging Tool
2. **`civic_query_sql`** - Data Querying Tool

## Tool Requirements Specification

### Tool #1: `civic_graphql_query`

**Purpose**: Execute GraphQL queries against the CIViC API, convert JSON responses into properly structured SQLite tables, and return metadata for subsequent SQL operations.

**Critical Requirements**:

1. **GraphQL Execution**: Must execute valid GraphQL queries against `https://civicdb.org/api/graphql`
2. **Response Processing**: Must handle CIViC API responses correctly
3. **Schema Inference**: Must infer proper relational schemas from GraphQL JSON responses
4. **Entity Extraction**: Must correctly identify and extract entities from GraphQL `edges/nodes` patterns
5. **Table Creation**: Must create SQLite tables with proper column types and constraints
6. **Data Insertion**: Must insert individual records as separate rows (NOT as JSON blobs)
7. **Metadata Generation**: Must return comprehensive metadata about created tables and schema
8. **Error Handling**: Must provide detailed error messages for failures
9. **Pagination Awareness**: Must detect and report pagination information

**Input Format**:
```json
{
  "query": "GraphQL query string",
  "variables": {} // Optional GraphQL variables
}
```

**Expected Output Format**:
```json
{
  "success": true,
  "message": "descriptive message",
  "data_access_id": "unique-identifier-for-this-dataset",
  "processing_details": {
    "tables_created": ["table1", "table2"],
    "total_rows_inserted": 123,
    "schema_summary": {...}
  },
  "schemas": {
    "table_name": {
      "columns": {"col1": "INTEGER", "col2": "TEXT"},
      "row_count": 10,
      "sample_data": [...]
    }
  },
  "table_count": 2,
  "total_rows": 123,
  "pagination": { // If applicable
    "hasNextPage": true,
    "endCursor": "cursor_value",
    "suggestion": "pagination instructions"
  }
}
```

### Tool #2: `civic_query_sql`

**Purpose**: Execute SQL queries against SQLite data staged by Tool #1.

**Critical Requirements**:

1. **SQL Execution**: Must execute valid SQL SELECT statements
2. **Data Access**: Must access data using the `data_access_id` from Tool #1
3. **Result Formatting**: Must return results in structured JSON format
4. **Security**: Must reject non-SELECT queries
5. **Error Handling**: Must provide detailed error messages for SQL errors
6. **Performance**: Must handle queries efficiently

**Input Format**:
```json
{
  "data_access_id": "identifier-from-tool-1",
  "sql": "SELECT statement",
  "params": [] // Optional parameterized query values
}
```

**Expected Output Format**:
```json
{
  "success": true,
  "results": [
    {"col1": "value1", "col2": "value2"},
    {"col1": "value3", "col2": "value4"}
  ],
  "row_count": 2,
  "column_names": ["col1", "col2"]
}
```

## Comprehensive Test Suite

### Test Category 1: Basic Functionality Tests

#### Test 1.1: Simple Entity Query
**Purpose**: Verify basic GraphQL query execution and single entity handling.

**Query**:
```graphql
{
  gene(id: 12) {
    id
    name
    description
  }
}
```

**Required Validations**:
1. Tool returns `success: true`
2. Creates exactly 1 table named `main_entity` or `gene`
3. Table has columns: `id` (INTEGER), `name` (TEXT), `description` (TEXT)
4. Inserts exactly 1 row with actual gene data
5. Sample data contains the actual gene information
6. SQL query `SELECT * FROM [table_name]` returns 1 row with gene ID 12

**Failure Conditions**:
- Returns JSON blob instead of individual columns
- Creates 0 tables or wrong table structure
- Inserts 0 rows or multiple rows
- Column types are incorrect

#### Test 1.2: GraphQL Edges/Nodes Pattern
**Purpose**: Verify proper handling of GraphQL pagination patterns.

**Query**:
```graphql
{
  variants(first: 5) {
    edges {
      node {
        id
        name
      }
    }
  }
}
```

**Required Validations**:
1. Creates exactly 1 table named `variants`
2. Table has columns: `id` (INTEGER PRIMARY KEY), `name` (TEXT)
3. Inserts exactly 5 rows (one per variant)
4. Each row contains different variant data
5. SQL query `SELECT COUNT(*) FROM variants` returns 5
6. SQL query `SELECT DISTINCT id FROM variants` returns 5 different IDs

**Failure Conditions**:
- Treats `edges` as a single JSON blob
- Creates table with `edges` column containing array
- Inserts fewer than 5 rows
- All rows have same data

### Test Category 2: Complex Relational Data Tests

#### Test 2.1: Nested Object Handling
**Purpose**: Verify proper decomposition of nested objects into relational structures.

**Query**:
```graphql
{
  evidenceItems(first: 3) {
    edges {
      node {
        id
        name
        disease {
          id
          name
          displayName
        }
        source {
          id
          sourceType
          citation
        }
      }
    }
  }
}
```

**Required Validations**:
1. Creates separate tables for main entities and nested objects
2. Main table (`evidence_items`) has foreign key references to nested entities
3. Nested objects are NOT stored as JSON blobs
4. Can perform JOIN queries between tables
5. SQL query joining evidence items with diseases works correctly
6. No TEXT columns contain stringified JSON objects

**Advanced Validation**:
```sql
-- This query must work and return meaningful results
SELECT e.name as evidence_name, d.name as disease_name 
FROM evidence_items e 
JOIN diseases d ON e.disease_id = d.id
```

**Failure Conditions**:
- Stores `disease` as JSON string in TEXT column
- Cannot perform relational queries
- Missing foreign key relationships

#### Test 2.2: Array Relationship Handling
**Purpose**: Verify proper handling of one-to-many and many-to-many relationships.

**Query**:
```graphql
{
  genes(first: 2) {
    edges {
      node {
        id
        name
        variants {
          id
          name
        }
        aliases {
          name
        }
      }
    }
  }
}
```

**Required Validations**:
1. Creates separate tables for genes, variants, and aliases
2. Establishes proper foreign key relationships
3. Many-to-many relationships use junction tables when appropriate
4. Can query related data using JOINs
5. No arrays stored as JSON strings

**Advanced Validation**:
```sql
-- This query must return multiple variants per gene
SELECT g.name as gene_name, v.name as variant_name
FROM genes g
JOIN gene_variants gv ON g.id = gv.gene_id  
JOIN variants v ON gv.variant_id = v.id
```

### Test Category 3: Data Volume and Pagination Tests

#### Test 3.1: Large Dataset Handling
**Purpose**: Verify system can handle large datasets without silent truncation.

**Query**:
```graphql
{
  variants(first: 100) {
    edges {
      node {
        id
        name
        variantTypes {
          id
          name
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
    totalCount
  }
}
```

**Required Validations**:
1. Returns exactly 100 variants (not truncated to smaller number)
2. Detects pagination information correctly
3. Reports `hasNextPage: true` in pagination metadata
4. Provides `endCursor` for next page
5. SQL query `SELECT COUNT(*) FROM variants` returns exactly 100
6. All 100 records have unique IDs

**Failure Conditions**:
- Returns fewer than 100 records without explanation
- Pagination information missing or incorrect
- Silent truncation without warning

#### Test 3.2: Pagination Continuation
**Purpose**: Verify system can handle paginated queries correctly.

**Setup**: First execute Test 3.1, then use returned `endCursor`.

**Query**:
```graphql
{
  variants(first: 50, after: "[endCursor from previous query]") {
    edges {
      node {
        id
        name
      }
    }
    pageInfo {
      hasNextPage
      endCursor
      hasPreviousPage
    }
  }
}
```

**Required Validations**:
1. Returns 50 different variants (not same as first page)
2. Variant IDs don't overlap with previous query
3. Pagination information updated correctly
4. `hasPreviousPage: true`

### Test Category 4: Error Handling and Edge Cases

#### Test 4.1: Invalid GraphQL Query
**Purpose**: Verify proper error handling for malformed queries.

**Query**:
```graphql
{
  invalidField {
    nonExistentProperty
  }
}
```

**Required Validations**:
1. Returns `success: false`
2. Provides descriptive error message
3. Does not create any tables
4. Error message indicates GraphQL validation failure

#### Test 4.2: Empty Result Set
**Purpose**: Verify handling of valid queries that return no data.

**Query**:
```graphql
{
  genes(last: 0) {
    edges {
      node {
        id
        name
      }
    }
  }
}
```

**Required Validations**:
1. Returns `success: true`
2. Creates table schema but with 0 rows
3. Metadata correctly reports 0 rows
4. Table structure is still correct

#### Test 4.3: SQL Injection Prevention
**Purpose**: Verify Tool #2 prevents SQL injection attacks.

**Input**:
```json
{
  "data_access_id": "valid-id",
  "sql": "SELECT * FROM variants; DROP TABLE variants; --"
}
```

**Required Validations**:
1. Returns `success: false`
2. Rejects multi-statement queries
3. Database remains intact
4. Provides security-related error message

#### Test 4.4: Non-SELECT Query Rejection
**Purpose**: Verify Tool #2 only allows SELECT statements.

**Input**:
```json
{
  "data_access_id": "valid-id", 
  "sql": "DELETE FROM variants WHERE id = 1"
}
```

**Required Validations**:
1. Returns `success: false`
2. Error message indicates only SELECT allowed
3. No data is modified

### Test Category 5: Data Integrity and Quality Tests

#### Test 5.1: Data Type Consistency
**Purpose**: Verify proper SQLite type inference and consistency.

**Query**:
```graphql
{
  variants(first: 10) {
    edges {
      node {
        id
        name
        coordinatesPrimary {
          start
          stop
          chromosome
        }
      }
    }
  }
}
```

**Required Validations**:
1. `id` column is INTEGER type
2. `name` column is TEXT type
3. Coordinate `start` and `stop` are INTEGER or REAL
4. `chromosome` is TEXT type
5. NULL values handled correctly
6. No type conversion errors

**SQL Validation**:
```sql
-- This query must work without type errors
SELECT AVG(start), MIN(stop), MAX(start) 
FROM variant_coordinates 
WHERE start IS NOT NULL
```

#### Test 5.2: Foreign Key Integrity
**Purpose**: Verify referential integrity in relational decomposition.

**Query**: Use complex query from Test 2.1

**Required Validations**:
1. All foreign key values exist in referenced tables
2. No orphaned records
3. No NULL foreign keys where relationships exist

**SQL Validation**:
```sql
-- This query must return 0 rows (no orphans)
SELECT e.id FROM evidence_items e 
LEFT JOIN diseases d ON e.disease_id = d.id 
WHERE e.disease_id IS NOT NULL AND d.id IS NULL
```

#### Test 5.3: Data Completeness
**Purpose**: Verify no data loss during transformation.

**Query**:
```graphql
{
  genes(first: 5) {
    edges {
      node {
        id
        name
        description
        flagged
        variants {
          id
          name
        }
      }
    }
  }
}
```

**Required Validations**:
1. All scalar fields from GraphQL response are preserved
2. Nested object data is accessible via relations
3. Array data is properly decomposed
4. No silent data truncation

### Test Category 6: Performance and Scalability Tests

#### Test 6.1: Large Query Performance
**Purpose**: Verify system can handle complex queries efficiently.

**Query**:
```graphql
{
  evidenceItems(first: 50) {
    edges {
      node {
        id
        name
        description
        disease {
          id
          name
          doid
        }
        molecularProfile {
          id
          name
          variants {
            id
            name
          }
        }
        therapies {
          id
          name
        }
        source {
          id
          citation
          sourceType
        }
      }
    }
  }
}
```

**Required Validations**:
1. Completes within reasonable time (< 30 seconds)
2. Creates multiple related tables
3. Maintains data relationships correctly
4. Memory usage remains reasonable

#### Test 6.2: Complex SQL Query Performance
**Purpose**: Verify staged data supports complex analytical queries.

**Setup**: Use data from Test 6.1

**SQL Query**:
```sql
SELECT 
  d.name as disease_name,
  COUNT(DISTINCT e.id) as evidence_count,
  COUNT(DISTINCT v.id) as variant_count,
  COUNT(DISTINCT t.id) as therapy_count
FROM evidence_items e
JOIN diseases d ON e.disease_id = d.id
JOIN molecular_profiles mp ON e.molecular_profile_id = mp.id
JOIN molecular_profile_variants mpv ON mp.id = mpv.molecular_profile_id
JOIN variants v ON mpv.variant_id = v.id
LEFT JOIN evidence_therapies et ON e.id = et.evidence_item_id
LEFT JOIN therapies t ON et.therapy_id = t.id
GROUP BY d.id, d.name
ORDER BY evidence_count DESC
LIMIT 10
```

**Required Validations**:
1. Query executes successfully
2. Returns meaningful aggregated results
3. Demonstrates proper table relationships
4. Performance is acceptable

## Evaluation Protocol

### Automated Testing Procedure

1. **Environment Setup**
   - Deploy civic-mcp-server tools
   - Verify CIViC API connectivity
   - Initialize clean test environment

2. **Test Execution Order**
   - Run Basic Functionality Tests first
   - Proceed to Complex Relational Data Tests
   - Execute Data Volume and Pagination Tests
   - Run Error Handling tests
   - Complete with Performance tests

3. **Validation Methodology**
   - Execute each test query using `civic_graphql_query`
   - Verify output format matches specification exactly
   - Execute validation SQL queries using `civic_query_sql`
   - Compare results against expected outcomes
   - Log all failures with detailed diagnostics

4. **Pass/Fail Criteria**
   - ALL tests must pass for tools to be considered functional
   - NO partial credit or workarounds allowed
   - Any data integrity violation is automatic failure
   - Performance requirements must be met

### Anti-Cheating Measures

1. **Data Verification**
   - Query live CIViC API to verify expected data exists
   - Cross-reference results with independent API calls
   - Validate data freshness and accuracy

2. **Schema Validation**
   - Inspect actual SQLite table schemas using PRAGMA commands
   - Verify column types match inferred types exactly
   - Check for proper indexes and constraints

3. **Behavioral Testing**
   - Test edge cases with unusual GraphQL responses
   - Verify error handling with malformed inputs
   - Test with various data sizes and structures

4. **Integration Testing**
   - Ensure Tool #1 and Tool #2 work together seamlessly
   - Verify data_access_id mechanism works correctly
   - Test multiple concurrent queries

## Common Failure Patterns to Detect

### Anti-Pattern 1: JSON Blob Storage
**Detection**: 
```sql
-- If this returns any rows, the tool is storing objects as JSON strings
SELECT column_name FROM pragma_table_info('table_name') 
WHERE column_name LIKE '%_json' OR column_name = 'data'
```

### Anti-Pattern 2: Single Row Storage
**Detection**:
```sql
-- For edges/nodes queries, this should return > 1
SELECT COUNT(*) FROM table_name
```

### Anti-Pattern 3: Missing Relationships
**Detection**:
```sql
-- Should be able to JOIN related tables
SELECT COUNT(*) FROM table1 t1 
JOIN table2 t2 ON t1.foreign_key = t2.id
```

### Anti-Pattern 4: Type Inconsistency
**Detection**:
```sql
-- Numeric fields should support arithmetic
SELECT AVG(numeric_column) FROM table_name WHERE numeric_column IS NOT NULL
```

## Success Criteria Summary

The tools PASS evaluation if and only if:

1. ✅ All 18 test cases pass completely
2. ✅ No anti-patterns detected
3. ✅ Performance requirements met
4. ✅ Security validations pass
5. ✅ Data integrity maintained
6. ✅ Full relational capabilities demonstrated

Any single failure in any category results in overall FAILURE status.

## Debugging and Iteration Process

When tests fail:

1. **Identify Root Cause**
   - Review specific test failure details
   - Examine generated SQL schemas
   - Analyze data insertion patterns

2. **Implement Targeted Fixes**
   - Address specific failing functionality
   - Maintain compatibility with passing tests
   - Re-run full test suite after each change

3. **Verify Comprehensive Fix**
   - Ensure fix doesn't break other functionality
   - Test edge cases around the fix
   - Validate performance impact

This framework ensures robust, reliable, and properly architected tools that handle real-world CIViC data correctly. 