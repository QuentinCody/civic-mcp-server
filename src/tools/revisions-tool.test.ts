import { describe, expect, it } from "vitest";
import type { GraphQLClient, GraphQLResponse } from "../utils/graphql-client.js";
import {
  REVISIONS_QUERY,
  RevisionsTool,
  SUBMITTED_EVIDENCE_QUERY,
  buildRevisionsRequest,
  shapeRevisionsResult,
} from "./revisions-tool.js";

describe("buildRevisionsRequest", () => {
  it("selects the revisions query when evidence_id is given", () => {
    const req = buildRevisionsRequest({ evidence_id: 1398, limit: 5 });
    expect(req.mode).toBe("revisions");
    expect(req.query).toBe(REVISIONS_QUERY);
    expect(req.variables).toEqual({ id: 1398, first: 5 });
  });

  it("selects the listing query otherwise, defaulting to SUBMITTED and limit 10", () => {
    const req = buildRevisionsRequest({});
    expect(req.mode).toBe("listing");
    expect(req.query).toBe(SUBMITTED_EVIDENCE_QUERY);
    expect(req.variables).toEqual({ status: "SUBMITTED", first: 10 });
  });
});

describe("shapeRevisionsResult", () => {
  it("returns success with the evidence item and a summary", () => {
    const result = shapeRevisionsResult("revisions", {
      data: {
        evidenceItem: {
          id: 1398,
          status: "ACCEPTED",
          revisions: { totalCount: 3, nodes: [{ id: 1 }] },
          events: { nodes: [{ action: "SUBMITTED" }] },
        },
      },
    } as unknown as GraphQLResponse);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.success).toBe(true);
    expect(result.content[0].text).toContain("3 revisions");
  });

  it("errors with content + structuredContent when the item is missing", () => {
    const result = shapeRevisionsResult("revisions", {
      data: { evidenceItem: null },
    } as unknown as GraphQLResponse);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      success: false,
      error: { code: "NOT_FOUND" },
    });
    expect(result.content[0].text).toMatch(/^Error:/);
  });

  it("propagates GraphQL errors", () => {
    const result = shapeRevisionsResult("revisions", {
      errors: [{ message: "boom" }],
    } as unknown as GraphQLResponse);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("boom");
  });

  it("summarizes listings", () => {
    const result = shapeRevisionsResult("listing", {
      data: { evidenceItems: { totalCount: 42, nodes: [{ id: 1 }, { id: 2 }] } },
    } as unknown as GraphQLResponse);
    expect(result.content[0].text).toBe("2 of 42 evidence items returned.");
    expect(result.structuredContent.success).toBe(true);
  });
});

describe("RevisionsTool.execute", () => {
  it("runs the built query against the client and shapes the result", async () => {
    const calls: { query: string; variables?: Record<string, unknown> }[] = [];
    const client = {
      executeQuery: async (query: string, variables?: Record<string, unknown>) => {
        calls.push({ query, variables });
        return { data: { evidenceItems: { totalCount: 1, nodes: [{ id: 9 }] } } };
      },
    } as unknown as GraphQLClient;
    const tool = new RevisionsTool(client);
    const result = await tool.execute({ status: "SUBMITTED", limit: 3 });
    expect(calls[0].query).toBe(SUBMITTED_EVIDENCE_QUERY);
    expect(calls[0].variables).toEqual({ status: "SUBMITTED", first: 3 });
    expect(result.structuredContent.success).toBe(true);
  });

  it("catches transport failures as structured errors", async () => {
    const client = {
      executeQuery: async () => {
        throw new Error("fetch failed");
      },
    } as unknown as GraphQLClient;
    const result = await new RevisionsTool(client).execute({ evidence_id: 1 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      success: false,
      error: { code: "CIVIC_REQUEST_FAILED", message: "fetch failed" },
    });
  });
});
