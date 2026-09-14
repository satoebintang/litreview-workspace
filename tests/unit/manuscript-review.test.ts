import { describe, expect, it } from "vitest";
import {
  applyManuscriptReviewEvent,
  reduceManuscriptReviewEvents,
  validateManuscriptReviewEventStream,
} from "@/domain/manuscript-review";
import {
  appendManuscriptReviewEventSchema,
  createManuscriptReviewThreadSchema,
} from "@/domain/validation";
import type { ManuscriptReviewEvent } from "@/domain/types";

const id = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;
const event = (sequence: number, eventType: ManuscriptReviewEvent["eventType"]): ManuscriptReviewEvent => ({
  id: id(String(sequence).padStart(2, "0")),
  sequence,
  projectId: id("01"),
  threadId: id("02"),
  eventType,
  body: eventType === "commented" ? "A note" : null,
  occurredAt: new Date(0),
});

describe("Slice 23 manuscript editorial review domain", () => {
  it("reduces comments and enforces resolve/reopen transitions", () => {
    expect(reduceManuscriptReviewEvents([
      event(3, "reopened"),
      event(1, "opened"),
      event(2, "resolved"),
      event(4, "commented"),
    ])).toEqual({ lifecycle: "open", opened: true });
    expect(() => applyManuscriptReviewEvent({ lifecycle: "open", opened: false }, "commented")).toThrow(/opened/);
    expect(() => applyManuscriptReviewEvent({ lifecycle: "resolved", opened: true }, "resolved")).toThrow(/open/);
  });

  it("requires one opened event first in the persisted sequence", () => {
    expect(validateManuscriptReviewEventStream([event(1, "opened"), event(2, "commented")])).toEqual({ lifecycle: "open", opened: true });
    expect(() => validateManuscriptReviewEventStream([])).toThrow(/opened/);
    expect(() => validateManuscriptReviewEventStream([event(2, "opened"), event(1, "commented")])).toThrow(/lowest|first/);
    expect(() => validateManuscriptReviewEventStream([event(1, "opened"), event(2, "opened")])).toThrow(/exactly|once/);
  });

  it("preserves exact Prose snapshot whitespace while normalizing title input", () => {
    const parsed = createManuscriptReviewThreadSchema.parse({
      projectId: id("01"),
      manuscriptId: id("02"),
      sectionId: id("03"),
      sectionItemId: id("04"),
      targetItemType: "prose",
      title: "  Fix wording  ",
      openingProseText: "  exact text\n",
    });
    expect(parsed.title).toBe("Fix wording");
    expect(parsed.openingProseText).toBe("  exact text\n");
    expect(appendManuscriptReviewEventSchema.safeParse({ threadId: id("02"), eventType: "commented", body: "   " }).success).toBe(false);
    expect(appendManuscriptReviewEventSchema.safeParse({ threadId: id("02"), eventType: "resolved", body: "Resolution note" }).success).toBe(true);
  });
});
