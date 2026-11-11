import { validateGraphqlQuery } from "@bio-mcp/shared/codemode/graphql-validate";
import { expect, it } from "vitest";
import { CIVIC_PROFILE_QUERIES } from "./profile-queries";
import { profileSchema } from "./profile-schema.fixture";

// The shared conservative validator deliberately declines queries with fragments.
// Validate these leaf-only fragment selections separately under their explicit
// type, then validate the surrounding query. This is selected-field/argument
// coverage, not a replacement for full provider validation or live acceptance.
function validateSelections(query: string) {
  const results: ReturnType<typeof validateGraphqlQuery>[] = [];
  const outer = query.replace(/\.\.\. on (\w+) \{([^{}]*)\}/g, (_match, type, selection) => {
    results.push(validateGraphqlQuery(`{ fixtureRoot { ${selection} } }`, {
      ...profileSchema, queryType: { name: "FixtureRoot" }, types: [
        ...profileSchema.types,
        { name: "FixtureRoot", kind: "OBJECT", fields: [{ name: "fixtureRoot", type, args: [] }] },
      ],
    }));
    return "";
  });
  results.push(validateGraphqlQuery(outer, profileSchema));
  return results;
}

it.each(Object.entries(CIVIC_PROFILE_QUERIES))("checks %s selections and arguments against provider documentation", (_name, query) => {
  for (const result of validateSelections(query)) expect(result).toEqual({ checked: true, errors: [] });
});

it.each([
  CIVIC_PROFILE_QUERIES.profile.replaceAll("iscnName", "iscn"),
  CIVIC_PROFILE_QUERIES.evidence.replace("evidenceDirection", "direction"),
  CIVIC_PROFILE_QUERIES.assertions.replace("assertionDirection", "direction"),
  CIVIC_PROFILE_QUERIES.assertionEvidence.replace("assertionId: $id", "molecularProfileName: $id"),
  CIVIC_PROFILE_QUERIES.profiles.replace("after: $after", "offset: $after"),
])("detects field and argument drift %#", query => {
  expect(validateSelections(query).some(result => result.errors.length > 0)).toBe(true);
});
