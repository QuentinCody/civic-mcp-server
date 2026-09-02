import { z } from "zod";
import type { GraphQLClient, GraphQLResponse } from "../utils/graphql-client.js";

/**
 * civic_revisions — expose CIViC's revision history and moderation events.
 *
 * Revisions are expert corrections to curated content: the highest-signal
 * record of what curators actually fix (wrong specificity, wrong direction,
 * wrong therapy). Two modes:
 *   - evidence_id: revisions + events for one evidence item
 *   - status listing: recently submitted evidence items (canary/triage input)
 */

export const REVISIONS_QUERY = `
query EvidenceRevisions($id: Int!, $first: Int) {
  evidenceItem(id: $id) {
    id
    name
    status
    description
    evidenceDirection
    significance
    revisions(first: $first) {
      totalCount
      nodes {
        id
        fieldName
        currentValue
        suggestedValue
        status
        revisionSetId
        updatedAt
        creationActivity {
          createdAt
          note
          user { displayName role }
        }
      }
    }
    events(first: $first) {
      nodes {
        action
        createdAt
        originatingUser { displayName role }
      }
    }
  }
}`;

export const SUBMITTED_EVIDENCE_QUERY = `
query SubmittedEvidence($status: EvidenceStatusFilter!, $first: Int) {
  evidenceItems(status: $status, first: $first) {
    totalCount
    nodes {
      id
      name
      status
      evidenceType
      evidenceDirection
      significance
      description
      molecularProfile { id name }
      disease { id name doid }
      therapies { id name ncitId }
      source { id sourceType citationId }
    }
  }
}`;

export const revisionsInputSchema = {
  evidence_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("CIViC evidence item ID — returns its revision history and moderation events"),
  status: z
    .enum(["SUBMITTED", "ACCEPTED", "REJECTED"])
    .optional()
    .describe("List evidence items with this status instead (default mode when evidence_id is absent: SUBMITTED)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .default(10)
    .describe("Maximum revisions/events or listed items (max 25, default 10)"),
};

export interface RevisionsParams {
  evidence_id?: number;
  status?: "SUBMITTED" | "ACCEPTED" | "REJECTED";
  limit?: number;
}

export function buildRevisionsRequest(params: RevisionsParams): {
  query: string;
  variables: Record<string, unknown>;
  mode: "revisions" | "listing";
} {
  const limit = params.limit ?? 10;
  if (params.evidence_id !== undefined) {
    return {
      query: REVISIONS_QUERY,
      variables: { id: params.evidence_id, first: limit },
      mode: "revisions",
    };
  }
  return {
    query: SUBMITTED_EVIDENCE_QUERY,
    variables: { status: params.status ?? "SUBMITTED", first: limit },
    mode: "listing",
  };
}

interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

export function shapeRevisionsResult(
  mode: "revisions" | "listing",
  response: GraphQLResponse,
): ToolResult {
  if (response.errors?.length) {
    const message = response.errors.map((e: { message: string }) => e.message).join("; ");
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      structuredContent: {
        success: false,
        error: { code: "CIVIC_GRAPHQL_ERROR", message },
      },
      isError: true,
    };
  }
  const data = response.data as Record<string, unknown> | undefined;
  if (mode === "revisions") {
    const item = data?.evidenceItem as Record<string, unknown> | null | undefined;
    if (!item) {
      return {
        content: [{ type: "text", text: "Error: evidence item not found" }],
        structuredContent: {
          success: false,
          error: { code: "NOT_FOUND", message: "evidence item not found" },
        },
        isError: true,
      };
    }
    const revisions = (item.revisions as { totalCount?: number; nodes?: unknown[] }) ?? {};
    const events = (item.events as { nodes?: unknown[] }) ?? {};
    const summary =
      `Evidence ${item.id} (${item.status}): ${revisions.totalCount ?? 0} revisions, ` +
      `${events.nodes?.length ?? 0} recent events.`;
    return {
      content: [{ type: "text", text: summary }],
      structuredContent: { success: true, data: item, _meta: {} },
    };
  }
  const items = data?.evidenceItems as { totalCount?: number; nodes?: unknown[] } | undefined;
  const summary = `${items?.nodes?.length ?? 0} of ${items?.totalCount ?? 0} evidence items returned.`;
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: { success: true, data: items ?? { nodes: [] }, _meta: {} },
  };
}

export class RevisionsTool {
  constructor(private readonly graphqlClient: GraphQLClient) {}

  async execute(params: RevisionsParams): Promise<ToolResult> {
    const { query, variables, mode } = buildRevisionsRequest(params);
    try {
      const response = await this.graphqlClient.executeQuery(query, variables);
      return shapeRevisionsResult(mode, response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        structuredContent: {
          success: false,
          error: { code: "CIVIC_REQUEST_FAILED", message },
        },
        isError: true,
      };
    }
  }
}
