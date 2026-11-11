import { CIVIC_PROFILE_QUERIES } from "./profile-queries.js";

/** Executed inside the existing Code Mode isolate; comments become discovery text. */
export const CIVIC_PROFILE_PREAMBLE = `
// --- Molecular profile workflows ---
// civic.profiles({name:"BRAF",first:10,after:null}) discovers candidate profiles. Optional featureId, variantId or alleleRegistryId filters use CIViC feature/variant IDs or a ClinGen allele ID. Name is a PREFIX/alias search, not an exact match. Inspect all candidates; never silently choose nodes[0].
// civic.profile(profileId) retrieves the entire profile's name/rawName/parsedName and variant membership, including Gene/Factor/Fusion/Region feature types and RegionVariant.iscnName. Preserve AND/OR/NOT and parentheses in order; membership alone does not encode the profile logic. Do not infer complex status from variant count.
// civic.evidence(profileId,{first:10,after:null,status:"ACCEPTED",diseaseId:123,therapyId:456}) and civic.assertions(profileId,options) independently page exact-profile evidence/assertions. Disease/therapy IDs are optional; filters are never broadened automatically. Each row retains its own profile, disease, therapies, interaction type, origin, moderation status, significance and direction.
// civic.assertionEvidence(assertionId,{first:10,after:null,status:"ALL"}) retrieves evidence actually linked to an assertion. This helper defaults to ALL; profile evidence/assertions default to ACCEPTED. The evidence's profile can differ from the assertion's profile: do not rewrite or equate them.
// Page sizes are 1-50. Follow each connection's pageInfo.endCursor while hasNextPage is true, keeping its filters unchanged. Totals are filtered provider counts, not returned row counts. No automatic whole-database or nested evidence download.
// Results may be staged at the server's existing 1KB threshold. If __staged, return the handle or inspect it with api.query before reading entity fields. __errors signals partial GraphQL data; null/empty records do not prove biological absence. Retain flagged/deprecated/retracted fields and source citations. CIViC is a changing knowledgebase, not a fixed release; archive retrieved_at and the returned context.
var __civicQueries = ${JSON.stringify(CIVIC_PROFILE_QUERIES)};
function __civicId(value) {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) throw new Error("CIViC IDs must be positive GraphQL Int values");
  return value;
}
function __civicOptions(value, keys) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(function(key) { return keys.indexOf(key) < 0; })) throw new Error("Unsupported CIViC workflow options");
  return value;
}
function __civicText(value, limit) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error("CIViC text/cursor must be a nonempty bounded string");
  return value;
}
function __civicPage(options) {
  var first = options.first === undefined ? 10 : options.first;
  if (!Number.isInteger(first) || first < 1 || first > 50) throw new Error("CIViC page size must be 1-50");
  return {first:first,after:options.after === undefined || options.after === null ? null : __civicText(options.after,8192)};
}
function __civicEvidenceOptions(options, defaultStatus, allowFilters) {
  var o = __civicOptions(options, allowFilters ? ["first","after","status","diseaseId","therapyId"] : ["first","after","status"]);
  var result = __civicPage(o);
  result.status = o.status === undefined ? defaultStatus : o.status;
  if (["ACCEPTED","SUBMITTED","REJECTED","NON_REJECTED","ALL"].indexOf(result.status) < 0) throw new Error("Unsupported CIViC evidence status");
  ["diseaseId","therapyId"].forEach(function(key) { if (o[key] !== undefined) result[key] = __civicId(o[key]); });
  return result;
}
async function __civicRun(name, variables) {
  var result = await gql.query(__civicQueries[name], variables);
  var output = Object.assign({}, result, {_workflow:{name:name,variables:variables,source_url:"https://civicdb.org/api/graphql",retrieved_at:new Date().toISOString()}});
  if (result && result.__staged) return output;
  if (new TextEncoder().encode(JSON.stringify(output)).byteLength > 30 * 1024) return Object.assign({__staged:true},await db.stage(output));
  return output;
}
var civic = {
  profiles: function(options) {
    var o = __civicOptions(options,["name","featureId","variantId","alleleRegistryId","first","after"]);
    var variables = __civicPage(o);
    ["featureId","variantId"].forEach(function(key) { if (o[key] !== undefined) variables[key] = __civicId(o[key]); });
    ["name","alleleRegistryId"].forEach(function(key) { if (o[key] !== undefined) variables[key] = __civicText(o[key],500); });
    return __civicRun("profiles",variables);
  },
  profile: function(id) { return __civicRun("profile",{id:__civicId(id)}); },
  evidence: function(id,options) { return __civicRun("evidence",Object.assign({id:__civicId(id)},__civicEvidenceOptions(options,"ACCEPTED",true))); },
  assertions: function(id,options) { return __civicRun("assertions",Object.assign({id:__civicId(id)},__civicEvidenceOptions(options,"ACCEPTED",true))); },
  assertionEvidence: function(id,options) { return __civicRun("assertionEvidence",Object.assign({id:__civicId(id)},__civicEvidenceOptions(options,"ALL",false))); }
};
`;
