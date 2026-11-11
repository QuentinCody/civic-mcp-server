/** Selected fields/arguments checked against https://griffithlab.github.io/civic-v2/ (2026-09-28). */
const profile = `
  id name rawName link description isComplex isMultiVariant deprecated deprecationReason flagged
  molecularProfileAliases molecularProfileScore
  parsedName {
    __typename
    ... on MolecularProfileTextSegment { text }
    ... on Feature { id name featureType }
    ... on Variant { id name }
  }
  variants {
    __typename id name link deprecated flagged
    feature { id name featureType deprecated flagged }
    ... on RegionVariant { iscnName }
  }
`;
const page = "totalCount pageInfo { hasNextPage endCursor }";
const evidence = `
  id name link description status flagged evidenceType evidenceLevel evidenceDirection
  evidenceRating significance variantOrigin therapyInteractionType
  disease { id name } therapies { id name } phenotypes { id name }
  molecularProfile { ${profile} }
  source { id sourceType citationId citation sourceUrl publicationDate retracted }
`;
const assertion = `
  id name link summary description status flagged assertionType assertionDirection
  significance variantOrigin therapyInteractionType ampLevel evidenceItemsCount
  disease { id name } therapies { id name } phenotypes { id name }
  molecularProfile { ${profile} }
`;

export const CIVIC_PROFILE_QUERIES = {
  profiles: `query ProfileDiscovery($name: String, $featureId: Int, $variantId: Int, $alleleRegistryId: String, $first: Int!, $after: String) {
    molecularProfiles(name: $name, featureId: $featureId, variantId: $variantId, alleleRegistryId: $alleleRegistryId, first: $first, after: $after) {
      ${page} nodes { ${profile} }
    }
  }`,
  profile: `query ProfileContext($id: Int!) { molecularProfile(id: $id) { ${profile} } }`,
  evidence: `query ProfileEvidence($id: Int!, $first: Int!, $after: String, $status: EvidenceStatusFilter!, $diseaseId: Int, $therapyId: Int) {
    molecularProfile(id: $id) { ${profile} }
    evidenceItems(molecularProfileId: $id, first: $first, after: $after, status: $status, diseaseId: $diseaseId, therapyId: $therapyId) {
      ${page} nodes { ${evidence} }
    }
  }`,
  assertions: `query ProfileAssertions($id: Int!, $first: Int!, $after: String, $status: EvidenceStatusFilter!, $diseaseId: Int, $therapyId: Int) {
    molecularProfile(id: $id) { ${profile} }
    assertions(molecularProfileId: $id, first: $first, after: $after, status: $status, diseaseId: $diseaseId, therapyId: $therapyId) {
      ${page} nodes { ${assertion} }
    }
  }`,
  assertionEvidence: `query AssertionEvidence($id: Int!, $first: Int!, $after: String, $status: EvidenceStatusFilter!) {
    assertion(id: $id) { ${assertion} }
    evidenceItems(assertionId: $id, first: $first, after: $after, status: $status) {
      ${page} nodes { ${evidence} }
    }
  }`,
};
