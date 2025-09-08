// src/prompts/civic-tool-prompts.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Prompts that guide the LLM to use the civic_graphql_query tool 
 * with correct GraphQL queries for evidence and assertions.
 * Updated to match civic-v2 patterns and testing validation.
 * 
 * Key features:
 * - Complete, validated GraphQL queries with proper CIViC v2 schema
 * - Name-based filtering using molecularProfileName, diseaseName, variantName
 * - Status filtering (defaults to ACCEPTED for cleaner results) 
 * - Rich field selection including therapies, assertionDirection, evidenceLevel
 * - Proper enum values (e.g., SENSITIVITYRESPONSE not SENSITIVITY_RESPONSE)
 */
export function registerCivicPrompts(server: McpServer) {
  
  // ---- get-variant-evidence (PROMPT) ----
  server.registerPrompt(
    "get-variant-evidence",
    {
      title: "Get CIViC Evidence Items",
      description:
        "Fetch CIViC Evidence Items by molecular profile name (+ optional disease/therapy/type/significance/status). Always call the MCP tool civic_graphql_query.",
      argsSchema: {
        molecularProfileName: z.string().min(1).describe("e.g., 'TP53 Mutation'"),
        diseaseName: z.string().optional().describe("e.g., 'Lung Adenocarcinoma'"),
        therapyName: z.string().optional().describe("e.g., 'Imatinib', 'Bevacizumab'"),
        evidenceType: z.string().optional().describe("DIAGNOSTIC | PREDICTIVE | PROGNOSTIC | PREDISPOSING | ONCOGENIC | FUNCTIONAL"),
        significance: z.string().optional().describe("e.g., SENSITIVITYRESPONSE | RESISTANCE | POOR_OUTCOME | BETTER_OUTCOME | POSITIVE | NEGATIVE | PATHOGENIC | LIKELY_PATHOGENIC | BENIGN | LIKELY_BENIGN | UNCERTAIN_SIGNIFICANCE | REDUCED_SENSITIVITY | GAIN_OF_FUNCTION | LOSS_OF_FUNCTION | UNALTERED_FUNCTION | NEOMORPHIC | UNKNOWN | DOMINANT_NEGATIVE | PREDISPOSITION | PROTECTIVENESS | ONCOGENICITY | LIKELY_ONCOGENIC | ADVERSE_RESPONSE | NA"),
        status: z.string().optional().describe("ALL | ACCEPTED | SUBMITTED | REJECTED (default: ALL)"),
        first: z.string().optional().describe("Max rows to return (default 200)"),
      },
    },
    ({ molecularProfileName, diseaseName, therapyName, evidenceType, significance, status, first }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
`IMPORTANT: Use ONLY the MCP tool named "civic_graphql_query".
Do NOT write raw GraphQL yourself. Do NOT run shell/node commands.

Call civic_graphql_query with:

query:
"""
query EvidenceByProfileDisease(
  $first: Int!,
  $molecularProfileName: String,
  $diseaseName: String,
  $therapyName: String,
  $status: EvidenceStatusFilter,
  $evidenceType: EvidenceType,
  $significance: EvidenceSignificance
) {
  evidenceItems(
    first: $first,
    molecularProfileName: $molecularProfileName,
    diseaseName: $diseaseName,
    therapyName: $therapyName,
    status: $status,
    evidenceType: $evidenceType,
    significance: $significance
  ) {
    totalCount
    nodes {
      id
      link
      status
      evidenceType
      evidenceLevel
      evidenceDirection
      significance
      variantOrigin
      description
      disease { name displayName }
      molecularProfile {
        name
        variants {
          name
          feature { name }
        }
      }
      therapies { name }
      source { id citationId sourceUrl }
    }
  }
}
"""

variables:
${JSON.stringify(Object.fromEntries(Object.entries({
  first: parseInt(first || "200", 10),
  molecularProfileName,
  diseaseName,
  therapyName,
  status: status || "ALL", 
  evidenceType,
  significance
}).filter(([_, value]) => value !== null && value !== undefined)), null, 2)}

Notes:
- Evidence queries MUST NOT include 'variantName'; it is not a valid filter for evidenceItems in CIViC v2.
- Always include item 'id' and 'link' in the returned fields.
- The 'link' field provides the canonical URL path (e.g., "/evidence/6031")
- Full URLs: https://civicdb.org{link} (e.g., https://civicdb.org/evidence/6031)
- Use proper enum values: SENSITIVITYRESPONSE not SENSITIVITY_RESPONSE
- IMPORTANT: Null/undefined parameters are automatically excluded from the query to avoid over-filtering
- Return the JSON result exactly; summarize only if the user asks.
`
          }
        }
      ]
    })
  );

  // ---- get-variant-assertions (PROMPT) ----
  server.registerPrompt(
    "get-variant-assertions", 
    {
      title: "Get CIViC Assertions",
      description:
        "Fetch CIViC Assertions by molecular profile and/or variant (+ optional disease/therapy/type/significance/status). Always call the MCP tool civic_graphql_query.",
      argsSchema: {
        molecularProfileName: z.string().optional().describe("e.g., 'TP53 Mutation'"),
        variantName: z.string().optional().describe("e.g., 'TP53 R175H' or 'TPM3-NTRK1 Fusion'"), 
        diseaseName: z.string().optional().describe("e.g., 'Lung Adenocarcinoma'"),
        therapyName: z.string().optional().describe("e.g., 'Larotrectinib'"),
        assertionType: z.string().optional().describe("DIAGNOSTIC | PREDICTIVE | PROGNOSTIC | PREDISPOSING | ONCOGENIC | FUNCTIONAL"),
        significance: z.string().optional().describe("e.g., SENSITIVITYRESPONSE | RESISTANCE | POOR_OUTCOME | BETTER_OUTCOME | POSITIVE | NEGATIVE | PATHOGENIC | LIKELY_PATHOGENIC | BENIGN | LIKELY_BENIGN | UNCERTAIN_SIGNIFICANCE | REDUCED_SENSITIVITY | GAIN_OF_FUNCTION | LOSS_OF_FUNCTION | UNALTERED_FUNCTION | NEOMORPHIC | UNKNOWN | DOMINANT_NEGATIVE | PREDISPOSITION | PROTECTIVENESS | ONCOGENICITY | LIKELY_ONCOGENIC | ADVERSE_RESPONSE | NA"),
        status: z.string().optional().describe("ALL | ACCEPTED | SUBMITTED | REJECTED (default: ALL)"),
        first: z.string().optional().describe("Max rows to return (default 200)"),
      },
    },
    ({ molecularProfileName, variantName, diseaseName, therapyName, assertionType, significance, status, first }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
`IMPORTANT: Use ONLY the MCP tool named "civic_graphql_query".
Do NOT write raw GraphQL yourself. Do NOT run shell/node commands.

Call civic_graphql_query with:

query:
"""
query AssertionsByProfileDisease(
  $first: Int!,
  $molecularProfileName: String,
  $variantName: String,
  $diseaseName: String,
  $therapyName: String,
  $status: EvidenceStatusFilter,
  $assertionType: EvidenceType,
  $significance: EvidenceSignificance
) {
  assertions(
    first: $first,
    molecularProfileName: $molecularProfileName,
    variantName: $variantName,
    diseaseName: $diseaseName,
    therapyName: $therapyName,
    status: $status,
    assertionType: $assertionType,
    significance: $significance
  ) {
    totalCount
    nodes {
      id
      name
      status
      assertionType
      significance
      assertionDirection
      summary
      disease { name displayName }
      molecularProfile {
        name
        variants {
          name
          feature { name }
        }
      }
      therapies { name }
    }
  }
}
"""

variables:
${JSON.stringify(Object.fromEntries(Object.entries({
  first: parseInt(first || "200", 10),
  molecularProfileName,
  variantName,
  diseaseName, 
  therapyName,
  status: status || "ALL",
  assertionType,
  significance
}).filter(([_, value]) => value !== null && value !== undefined)), null, 2)}

SEARCH STRATEGY - Apply these searches systematically:

PRIORITY 1: Molecular profile + therapy (most successful pattern)
Use same query but variables: {first, molecularProfileName, therapyName, status}

PRIORITY 2: If totalCount is 0, try therapy only:
Use same query but variables: {first, therapyName, status}

PRIORITY 3: Try name variations if needed:
- For "TPM3-NTRK1" also try "TPM3::NTRK1" and "TPM3::NTRK1 Fusion"
- For "ETV6-NTRK3" also try "ETV6::NTRK3" and "ETV6::NTRK3 Fusion"

PRIORITY 4: If still no results, search for evidence items

CRITICAL SUCCESS FACTORS:
- Remove disease filter first (assertions often use broad categories like "Solid Tumor")
- Molecular profile names are more reliable than variant names for assertions
- Both "TPM3-NTRK1" and "TPM3::NTRK1" formats usually work in CIViC

IMPORTANT NOTES:
- CIViC assertions often use broader disease categories (e.g., "Solid Tumor" instead of "Lung Carcinoma")
- Molecular profile naming varies (TPM3-NTRK1 vs TPM3::NTRK1)
- Always try multiple search strategies before concluding no data exists
- Canonical URLs: https://civicdb.org/assertions/{id}
- Use proper enum values: SENSITIVITYRESPONSE not SENSITIVITY_RESPONSE
- Parameters are automatically filtered to avoid over-restricting results
`
          }
        }
      ]
    })
  );

  // ---- get-variant-data (PROMPT) - Combined Evidence + Assertions ----
  server.registerPrompt(
    "get-variant-data",
    {
      title: "Get CIViC Evidence Items AND Assertions",
      description:
        "Fetch both CIViC Evidence Items and Assertions for comprehensive variant data. Always call the MCP tool civic_graphql_query multiple times.",
      argsSchema: {
        molecularProfileName: z.string().optional().describe("e.g., 'TP53 Mutation'"),
        variantName: z.string().optional().describe("e.g., 'TP53 R175H' or 'TPM3-NTRK1 Fusion'"), 
        diseaseName: z.string().optional().describe("e.g., 'Lung Adenocarcinoma'"),
        therapyName: z.string().optional().describe("e.g., 'Imatinib', 'Bevacizumab'"),
        evidenceType: z.string().optional().describe("DIAGNOSTIC | PREDICTIVE | PROGNOSTIC | PREDISPOSING | ONCOGENIC | FUNCTIONAL"),
        significance: z.string().optional().describe("e.g., SENSITIVITYRESPONSE | RESISTANCE | POOR_OUTCOME | BETTER_OUTCOME | POSITIVE | NEGATIVE | PATHOGENIC | LIKELY_PATHOGENIC | BENIGN | LIKELY_BENIGN | UNCERTAIN_SIGNIFICANCE | REDUCED_SENSITIVITY | GAIN_OF_FUNCTION | LOSS_OF_FUNCTION | UNALTERED_FUNCTION | NEOMORPHIC | UNKNOWN | DOMINANT_NEGATIVE | PREDISPOSITION | PROTECTIVENESS | ONCOGENICITY | LIKELY_ONCOGENIC | ADVERSE_RESPONSE | NA"),
        status: z.string().optional().describe("ALL | ACCEPTED | SUBMITTED | REJECTED (default: ALL)"),
        first: z.string().optional().describe("Max rows to return per query (default 200)"),
      },
    },
    ({ molecularProfileName, variantName, diseaseName, therapyName, evidenceType, significance, status, first }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
`COMPREHENSIVE VARIANT DATA SEARCH - Execute both Evidence Items AND Assertions queries.

STEP 1: SEARCH FOR EVIDENCE ITEMS
Use the civic_graphql_query tool with:

query:
"""
query EvidenceByProfileDisease(
  $first: Int!,
  $molecularProfileName: String,
  $diseaseName: String,
  $therapyName: String,
  $status: EvidenceStatusFilter,
  $evidenceType: EvidenceType,
  $significance: EvidenceSignificance
) {
  evidenceItems(
    first: $first,
    molecularProfileName: $molecularProfileName,
    diseaseName: $diseaseName,
    therapyName: $therapyName,
    status: $status,
    evidenceType: $evidenceType,
    significance: $significance
  ) {
    totalCount
    nodes {
      id
      link
      status
      evidenceType
      evidenceLevel
      evidenceDirection
      significance
      variantOrigin
      description
      disease { name displayName }
      molecularProfile {
        name
        variants {
          name
          feature { name }
        }
      }
      therapies { name }
      source { id citationId sourceUrl }
    }
  }
}
"""

variables:
${JSON.stringify(Object.fromEntries(Object.entries({
  first: parseInt(first || "200", 10),
  molecularProfileName,
  diseaseName,
  therapyName,
  status: status || "ALL", 
  evidenceType,
  significance
}).filter(([_, value]) => value !== null && value !== undefined)), null, 2)}

STEP 2: SEARCH FOR ASSERTIONS
Use the civic_graphql_query tool with:

query:
"""
query AssertionsByProfileDisease(
  $first: Int!,
  $molecularProfileName: String,
  $variantName: String,
  $diseaseName: String,
  $therapyName: String,
  $status: EvidenceStatusFilter,
  $assertionType: EvidenceType,
  $significance: EvidenceSignificance
) {
  assertions(
    first: $first,
    molecularProfileName: $molecularProfileName,
    variantName: $variantName,
    diseaseName: $diseaseName,
    therapyName: $therapyName,
    status: $status,
    assertionType: $assertionType,
    significance: $significance
  ) {
    totalCount
    nodes {
      id
      name
      status
      assertionType
      significance
      assertionDirection
      summary
      disease { name displayName }
      molecularProfile {
        name
        variants {
          name
          feature { name }
        }
      }
      therapies { name }
    }
  }
}
"""

variables:
${JSON.stringify(Object.fromEntries(Object.entries({
  first: parseInt(first || "200", 10),
  molecularProfileName,
  variantName,
  diseaseName, 
  therapyName,
  status: status || "ALL",
  assertionType: evidenceType, // Use evidenceType as assertionType
  significance
}).filter(([_, value]) => value !== null && value !== undefined)), null, 2)}

ASSERTION FALLBACK STRATEGY - If assertions totalCount is 0:
1. Try molecular profile + therapy only: {first, molecularProfileName, therapyName, status}
2. Try therapy only: {first, therapyName, status}

FINAL OUTPUT: 
Provide a comprehensive summary combining both evidence items and assertions:
- Evidence Items Found: [count] items
- Assertions Found: [count] assertions  
- Key Clinical Findings: [summarize significant results]
- URLs: Include https://civicdb.org/evidence/{id} and https://civicdb.org/assertions/{id} links

IMPORTANT NOTES:
- Execute BOTH queries regardless of individual results
- Evidence URLs: https://civicdb.org{link} (link field from evidence)
- Assertion URLs: https://civicdb.org/assertions/{id} (construct from id)
- Use proper enum values: SENSITIVITYRESPONSE not SENSITIVITY_RESPONSE
- Parameters are automatically filtered to avoid over-restricting results`
          }
        }
      ]
    })
  );
}