import { describe, expect, it, vi } from "vitest";
import { CIVIC_PROFILE_PREAMBLE } from "./profile-preamble";
import { CIVIC_PROFILE_QUERIES } from "./profile-queries";

function run(code: string, response: unknown = { molecularProfile: null }) {
  const query = vi.fn(async (_query: string, _variables: unknown) => response);
  const stage = vi.fn(async (_data: unknown) => ({ data_access_id: "fixture", _staging: { fixture: true } }));
  const result = new Function("gql", "db", `${CIVIC_PROFILE_PREAMBLE}\nreturn (async () => {${code}})();`)({ query }, { stage });
  return { query, stage, result };
}

describe("profile workflow requests", () => {
  it.each([
    ['civic.profiles({name:"BRAF",variantId:12,featureId:4,alleleRegistryId:"CA123",first:2,after:"opaque+/="})', "profiles", { name: "BRAF", variantId: 12, featureId: 4, alleleRegistryId: "CA123", first: 2, after: "opaque+/=" }],
    ["civic.profile(33)", "profile", { id: 33 }],
    ["civic.evidence(33)", "evidence", { id: 33, first: 10, after: null, status: "ACCEPTED" }],
    ['civic.assertions(33,{diseaseId:2,therapyId:4,first:1,after:"cursor",status:"SUBMITTED"})', "assertions", { id: 33, diseaseId: 2, therapyId: 4, first: 1, after: "cursor", status: "SUBMITTED" }],
    ["civic.assertionEvidence(44)", "assertionEvidence", { id: 44, first: 10, after: null, status: "ALL" }],
    ['civic.assertionEvidence(44,{status:"NON_REJECTED"})', "assertionEvidence", { id: 44, first: 10, after: null, status: "NON_REJECTED" }],
  ])("makes one request without broadening filters: %s", async (code, name, variables) => {
    const { query, result } = run(`return ${code};`);
    expect((await result)._workflow).toMatchObject({ name, variables, source_url: "https://civicdb.org/api/graphql", retrieved_at: expect.any(String) });
    expect(query).toHaveBeenCalledExactlyOnceWith(CIVIC_PROFILE_QUERIES[name as keyof typeof CIVIC_PROFILE_QUERIES], variables);
  });

  it("never turns a name match into the first exact profile", async () => {
    const candidates = { molecularProfiles: { totalCount: 2, nodes: [{ id: 1, name: "BRAF V600E" }, { id: 2, name: "BRAF V600E AND NOT KRAS Mutation" }] } };
    const { result, query } = run('return civic.profiles({name:"BRAF"});', candidates);
    expect((await result).molecularProfiles).toEqual(candidates.molecularProfiles);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("keeps user text in variables rather than GraphQL syntax", async () => {
    const input = 'BRAF ") { badField }';
    const { query, result } = run(`return civic.profiles({name:${JSON.stringify(input)}});`);
    await result;
    expect(query.mock.calls[0][1]).toMatchObject({ name: input });
    expect(query.mock.calls[0][0]).not.toContain(input);
  });

  it.each([
    "civic.profile(0)", "civic.profile(-1)", "civic.profile(1.5)", "civic.profile(2147483648)", 'civic.profile("33")',
    "civic.profiles(null)", "civic.profiles([])", 'civic.profiles({name:""})', 'civic.profiles({name:"x".repeat(501)})',
    "civic.profiles({variantId:0})", "civic.profiles({geneId:3})", "civic.profiles({first:0})", "civic.profiles({first:51})", "civic.profiles({first:1.5})",
    'civic.evidence(33,{status:"UNKNOWN"})', "civic.evidence(33,{diseaseId:-1})", "civic.evidence(33,{therapyId:null})",
    'civic.assertions(33,{after:""})', 'civic.assertions(33,{after:"a".repeat(8193)})', "civic.assertions(33,{offset:10})",
    "civic.assertionEvidence(44,{diseaseId:3})", "civic.assertionEvidence(44,{profileId:33})",
  ])("rejects invalid or unsupported input before fetch: %s", async code => {
    const { query, result } = run(`return ${code};`);
    await expect(result).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});

it("preserves ordered Boolean segments, all feature types and curation flags", async () => {
  const profile = { id: 1, name: "(A OR B) AND NOT C", rawName: "(1 OR 2) AND NOT 3", isComplex: true, isMultiVariant: true, deprecated: true, flagged: true,
    parsedName: [{ __typename: "MolecularProfileTextSegment", text: "(" }, { __typename: "Variant", id: 1 }, { __typename: "MolecularProfileTextSegment", text: " OR " }, { __typename: "Variant", id: 2 }, { __typename: "MolecularProfileTextSegment", text: ") AND NOT " }, { __typename: "Variant", id: 3 }],
    variants: ["GENE", "FACTOR", "FUSION", "REGION"].map((featureType, id) => ({ id, feature: { featureType }, ...(featureType === "REGION" ? { iscnName: "del(17p)" } : {}) })),
  };
  expect((await run("return civic.profile(1);", { molecularProfile: profile }).result).molecularProfile).toEqual(profile);
});

it.each([{ molecularProfile: null }, { evidenceItems: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }, { molecularProfile: null, __errors: [{ message: "partial" }] }])("preserves empty, absent and partial results %#", async response => {
  expect(await run("return civic.evidence(1);", response).result).toMatchObject(response);
});

it("preserves an existing staged handle and adds the exact request context", async () => {
  const handle = { __staged: true, data_access_id: "civic_fixture", _staging: { completeness: { complete: false } }, __errors: [{ message: "partial" }] };
  const { result, stage } = run("return civic.assertions(4);", handle);
  expect(await result).toMatchObject({ ...handle, _workflow: { name: "assertions", variables: { id: 4 } } });
  expect(stage).not.toHaveBeenCalled();
});

it("stages multibyte data with all profile context, source retraction and pagination intact", async () => {
  const response = { molecularProfile: { id: 33 }, evidenceItems: { totalCount: 100, pageInfo: { hasNextPage: true, endCursor: "next+/=" }, nodes: [{ description: "α".repeat(16_000), source: { retracted: true } }] }, __errors: [{ message: "partial" }] };
  const { result, stage } = run("return civic.evidence(33);", response);
  expect(await result).toMatchObject({ __staged: true, data_access_id: "fixture" });
  expect(stage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(response));
});
