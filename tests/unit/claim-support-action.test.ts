import { describe, expect, it } from "vitest";
import { searchClaimSupportOptionsAction } from "@/app/actions/claim-support-search";

describe("Claim support search action boundary", () => {
  it("validates untrusted payloads and returns a serializable error result", async () => {
    const malformed = await searchClaimSupportOptionsAction(null);
    expect(malformed).toEqual({ ok: false, error: "Claim support search input is invalid" });
    expect(JSON.parse(JSON.stringify(malformed))).toEqual(malformed);

    const invalidKind = await searchClaimSupportOptionsAction({
      projectId: "123e4567-e89b-42d3-a456-426614174000",
      kind: "unsupported",
    });
    expect(invalidKind).toEqual({ ok: false, error: "Claim support kind is invalid" });
    expect(JSON.parse(JSON.stringify(invalidKind))).toEqual(invalidKind);
  });
});
