#!/usr/bin/env node

import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Initialize schema-aware chunking by reading the GraphQL schema file
 * and configuring the chunking system with intelligent rules.
 * 
 * Usage: node scripts/initialize-schema.js [DO_URL]
 */

const SCHEMA_FILE = 'civic-schema.graphql';
const DEFAULT_DO_URL = 'http://localhost:8787'; // For local development

async function initializeSchema() {
    try {
        // Read the schema file
        const schemaPath = join(process.cwd(), SCHEMA_FILE);
        console.log(`Reading schema from: ${schemaPath}`);
        
        const schemaContent = readFileSync(schemaPath, 'utf-8');
        console.log(`Schema file loaded: ${schemaContent.length} characters`);
        
        // Get Durable Object URL
        const doUrl = process.argv[2] || DEFAULT_DO_URL;
        const initUrl = `${doUrl}/initialize-schema`;
        
        console.log(`Initializing schema-aware chunking at: ${initUrl}`);
        
        // Send schema to Durable Object
        const response = await fetch(initUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ schemaContent })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const result = await response.json();
        
        if (result.success) {
            console.log('✅ Schema-aware chunking initialized successfully!');
            console.log(`📊 Analysis:`);
            console.log(`   - Total types parsed: ${result.schema_analysis.total_types}`);
            console.log(`   - Relationships found: ${result.schema_analysis.relationships_count}`);
            console.log(`   - Chunking rules generated: ${result.schema_analysis.chunking_rules_generated}`);
            console.log(`   - High-value types identified: ${result.schema_analysis.high_value_types.length}`);
            
            console.log('\n📝 High-value types for chunking optimization:');
            result.schema_analysis.high_value_types.forEach(type => {
                console.log(`   - ${type.typeName} (${type.estimatedSize}): ${type.largeFields.length} large fields`);
                console.log(`     ${type.reason}`);
            });
            
            console.log('\n💡 Recommendations:');
            result.recommendations.forEach(rec => {
                console.log(`   - ${rec}`);
            });
            
        } else {
            console.error('❌ Schema initialization failed:', result.error);
            if (result.suggestion) {
                console.error('💡 Suggestion:', result.suggestion);
            }
            process.exit(1);
        }
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error('\n💡 Usage: node scripts/initialize-schema.js [DO_URL]');
        console.error('   Example: node scripts/initialize-schema.js http://localhost:8787');
        process.exit(1);
    }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    initializeSchema();
} 