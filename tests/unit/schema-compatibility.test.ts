import * as schemaApi from "@/db/schema";
import manifest from "../fixtures/schema-api-v0.34.json";
import { expect, it } from "vitest";

function slice45SchemaShape(names: string[]) {
  const current = [...names];
  const snapshotIndex = current.indexOf("evidenceSetCompositionMembers");
  if (snapshotIndex >= 0) {
    current.splice(snapshotIndex, 1, "evidenceSetMembershipOrderVersions", "evidenceSetPaperMemberCounts");
  }
  return current;
}

it("preserves the released ordered schema API", () => {
  expect(Object.keys(schemaApi)).toEqual(slice45SchemaShape(manifest.exports));
  expect(Object.keys(schemaApi.schema)).toEqual(slice45SchemaShape(manifest.schemaKeys));
});
