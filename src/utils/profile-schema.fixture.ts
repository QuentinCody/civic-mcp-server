import type { TrimmedField, TrimmedIntrospection } from "@bio-mcp/shared/codemode/graphql-introspection";

// Selected-field fixture independently transcribed from the provider documentation:
// https://griffithlab.github.io/civic-v2/ (2026-09-28). The repository's older
// civic-schema.graphql lacks RegionVariant. This is not live introspection or a
// complete schema; it checks field/argument names, not all GraphQL validation rules.
const field = (name: string, type: string, args: Record<string, string> = {}): TrimmedField => ({
  name, type, args: Object.entries(args).map(([name, type]) => ({ name, type })),
});
const fields = (definitions: string) => definitions.split(" ").map(pair => {
  const [name, type] = pair.split(":");
  return field(name, type);
});
const connectionArgs = { first: "Int", after: "String", status: "EvidenceStatusFilter", molecularProfileId: "Int", diseaseId: "Int", therapyId: "Int" };
const types: Record<string, TrimmedField[]> = {
  Query: [
    field("molecularProfile", "MolecularProfile", { id: "Int!" }),
    field("molecularProfiles", "MolecularProfileConnection!", { name: "String", featureId: "Int", variantId: "Int", alleleRegistryId: "String", first: "Int", after: "String" }),
    field("evidenceItems", "EvidenceItemConnection!", { ...connectionArgs, assertionId: "Int" }),
    field("assertions", "AssertionConnection!", connectionArgs),
    field("assertion", "Assertion", { id: "Int!" }),
  ],
  MolecularProfile: fields("id:Int! name:String! rawName:String! link:String! description:String isComplex:Boolean! isMultiVariant:Boolean! deprecated:Boolean! deprecationReason:MolecularProfileDeprecationReason flagged:Boolean! molecularProfileAliases:[String!]! molecularProfileScore:Float! parsedName:[MolecularProfileSegment!]! variants:[VariantInterface!]!"),
  MolecularProfileConnection: fields("totalCount:Int! nodes:[MolecularProfile!]! pageInfo:PageInfo!"),
  MolecularProfileSegment: [],
  MolecularProfileTextSegment: fields("text:String!"),
  VariantInterface: fields("id:Int! name:String! link:String! deprecated:Boolean! flagged:Boolean! feature:Feature!"),
  Variant: fields("id:Int! name:String!"),
  RegionVariant: fields("iscnName:String"),
  Feature: fields("id:Int! name:String! featureType:FeatureInstanceTypes! deprecated:Boolean! flagged:Boolean!"),
  PageInfo: fields("hasNextPage:Boolean! endCursor:String"),
  EvidenceItemConnection: fields("totalCount:Int! nodes:[EvidenceItem!]! pageInfo:PageInfo!"),
  AssertionConnection: fields("totalCount:Int! nodes:[Assertion!]! pageInfo:PageInfo!"),
  EvidenceItem: fields("id:Int! name:String! link:String! description:String! status:EvidenceStatus! flagged:Boolean! evidenceType:EvidenceType! evidenceLevel:EvidenceLevel! evidenceDirection:EvidenceDirection! evidenceRating:Int significance:EvidenceSignificance! variantOrigin:VariantOrigin! therapyInteractionType:TherapyInteraction disease:Disease therapies:[Therapy!]! phenotypes:[Phenotype!]! molecularProfile:MolecularProfile! source:Source!"),
  Assertion: fields("id:Int! name:String! link:String! summary:String! description:String! status:EvidenceStatus! flagged:Boolean! assertionType:AssertionType! assertionDirection:AssertionDirection! significance:AssertionSignificance! variantOrigin:VariantOrigin! therapyInteractionType:TherapyInteraction ampLevel:AmpLevel evidenceItemsCount:Int! disease:Disease therapies:[Therapy!]! phenotypes:[Phenotype!]! molecularProfile:MolecularProfile!"),
  Disease: fields("id:Int! name:String!"),
  Therapy: fields("id:Int! name:String!"),
  Phenotype: fields("id:Int! name:String!"),
  Source: fields("id:Int! sourceType:SourceSource! citationId:String! citation:String sourceUrl:String publicationDate:String retracted:Boolean!"),
};
export const profileSchema: TrimmedIntrospection = {
  queryType: { name: "Query" },
  // __typename is implicit on every composite type in GraphQL.
  types: Object.entries(types).map(([name, fields]) => ({ name, kind: name === "MolecularProfileSegment" ? "UNION" : name === "VariantInterface" ? "INTERFACE" : "OBJECT", fields: [...fields, field("__typename", "String!")] })),
};
