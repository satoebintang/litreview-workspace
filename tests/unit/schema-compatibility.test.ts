import * as schemaApi from "@/db/schema";
import manifest from "../fixtures/schema-api-v0.34.json";
import { expect, it } from "vitest";

it("preserves the released ordered schema API", () => {
  expect(Object.keys(schemaApi)).toEqual(manifest.exports);
  expect(Object.keys(schemaApi.schema)).toEqual(manifest.schemaKeys);
});
