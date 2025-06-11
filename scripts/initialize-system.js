#!/usr/bin/env node

/**
 * System Initialization Script
 * 
 * This script:
 * 1. Reads the CIViC GraphQL schema
 * 2. Initializes schema-aware chunking and entity extraction
 * 3. Tests the configuration
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DURABLE_OBJECT_URL = process.env.DURABLE_OBJECT_URL || 'http://localhost:8787';
const SCHEMA_PATH = join(__dirname, '..', 'civic-schema.graphql');

async function initializeSystem() {
	console.log('🚀 Initializing CIViC MCP Server with Schema-Aware Processing...\n');

	try {
		// 1. Read the GraphQL schema
		console.log('📖 Reading GraphQL schema...');
		const schemaContent = readFileSync(SCHEMA_PATH, 'utf-8');
		console.log(`✅ Schema loaded: ${schemaContent.split('\n').length} lines\n`);

		// 2. Initialize schema-aware processing
		console.log('🧠 Configuring schema-aware processing...');
		const initResponse = await fetch(`${DURABLE_OBJECT_URL}/initialize-schema`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				schemaContent,
				enableChunking: true,
				enableEntityExtraction: true
			})
		});

		if (!initResponse.ok) {
			throw new Error(`Schema initialization failed: ${initResponse.status} ${initResponse.statusText}`);
		}

		const initResult = await initResponse.json();
		console.log('✅ Schema-aware processing configured:');
		console.log(`   - Types discovered: ${initResult.typesCount || 'N/A'}`);
		console.log(`   - Relationships found: ${initResult.relationshipsCount || 'N/A'}`);
		console.log(`   - Chunking rules: ${initResult.chunkingRulesCount || 'N/A'}`);
		console.log(`   - Extraction rules: ${initResult.extractionRulesCount || 'N/A'}\n`);

		// 3. Test chunking configuration
		console.log('🧪 Testing chunking configuration...');
		const chunkingStatsResponse = await fetch(`${DURABLE_OBJECT_URL}/chunking-stats`);
		
		if (chunkingStatsResponse.ok) {
			const chunkingStats = await chunkingStatsResponse.json();
			console.log('✅ Chunking system status:');
			console.log(`   - Schema awareness: ${chunkingStats.schema_awareness ? 'Enabled' : 'Disabled'}`);
			console.log(`   - Rules configured: ${chunkingStats.rules_count || 0}`);
			console.log(`   - Ready for large content: ${chunkingStats.schema_awareness ? 'Yes' : 'No'}\n`);
		}

		// 4. Provide usage examples
		console.log('📋 System Ready! Usage Examples:');
		console.log('');
		console.log('1. Query with automatic chunking (if content > 32KB):');
		console.log('   POST /graphql-query');
		console.log('   { "query": "{ evidenceItems(first: 100) { ... } }" }');
		console.log('');
		console.log('2. Enhanced SQL queries with chunk resolution:');
		console.log('   POST /query-enhanced');
		console.log('   { "data_access_id": "...", "sql": "SELECT * FROM evidenceitem" }');
		console.log('');
		console.log('3. Chunking analysis:');
		console.log('   GET /chunking-analysis');
		console.log('');

		// 5. Schema analysis summary
		console.log('🔍 Schema Analysis Summary:');
		console.log('');
		
		// Parse schema to show key information
		const typeMatches = schemaContent.match(/^type\s+(\w+)/gm) || [];
		const interfaceMatches = schemaContent.match(/^interface\s+(\w+)/gm) || [];
		const enumMatches = schemaContent.match(/^enum\s+(\w+)/gm) || [];
		
		console.log(`   - Object Types: ${typeMatches.length}`);
		console.log(`   - Interfaces: ${interfaceMatches.length}`);
		console.log(`   - Enums: ${enumMatches.length}`);
		console.log('');
		
		// Show key entity types for CIViC
		const keyTypes = ['EvidenceItem', 'Gene', 'Variant', 'Source', 'Therapy', 'Disease'];
		const foundKeyTypes = keyTypes.filter(type => 
			schemaContent.includes(`type ${type}`)
		);
		
		console.log(`   - Key CIViC entities detected: ${foundKeyTypes.join(', ')}`);
		console.log('');
		
		console.log('🎉 Initialization Complete! The system is now optimized for CIViC data.');
		console.log('   Large responses will be automatically chunked and efficiently stored.');
		console.log('   Entity relationships will be properly extracted and queryable.');

	} catch (error) {
		console.error('❌ Initialization failed:', error.message);
		
		// Provide debugging information
		console.log('\n🔧 Debugging Information:');
		console.log(`   - Schema path: ${SCHEMA_PATH}`);
		console.log(`   - Durable Object URL: ${DURABLE_OBJECT_URL}`);
		console.log(`   - Schema exists: ${existsSync(SCHEMA_PATH)}`);
		
		if (error.message.includes('ECONNREFUSED') || error.message.includes('fetch')) {
			console.log('\n💡 Make sure the development server is running:');
			console.log('   npm run dev');
		}
		
		process.exit(1);
	}
}

// Support both direct execution and module import
if (import.meta.url === `file://${process.argv[1]}`) {
	initializeSystem();
}

export { initializeSystem }; 