import { describe, expect, it } from "vitest";
import {
  authorYearCitationFormatter,
  authorYearDisplayLabel,
  authorYearCollisionKey,
  buildCitationFormatContext,
  buildAuthorYearSuffixes,
  citationFormatterFor,
  missingMetadataWarnings,
  numericCitationFormatter,
  type CitationInput,
  type ManuscriptCitationRecord,
} from "@/citation";

function record(
  paperId: string,
  overrides: Partial<CitationInput> & Pick<ManuscriptCitationRecord, "citationNumber">,
): ManuscriptCitationRecord {
  const { citationNumber, ...input } = overrides;
  return {
    citationNumber,
    input: {
      paperId,
      title: input.title ?? `Paper ${paperId}`,
      authors: input.authors ?? ["Alice Smith"],
      publicationYear: input.publicationYear === undefined ? 2024 : input.publicationYear,
      venue: input.venue === undefined ? "Journal" : input.venue,
      doi: input.doi === undefined ? null : input.doi,
    },
    firstOccurrence: {
      sectionId: "section-1",
      sectionItemId: "item-1",
      placementId: "placement-1",
      claimRevisionId: "revision-1",
    },
  };
}

describe("citation formatter", () => {
  it("uses canonical citationNumber values and never recomputes numeric numbers", () => {
    const records = [record("paper-2", { citationNumber: 7 }), record("paper-1", { citationNumber: 2 })];
    const context = buildCitationFormatContext(records, "numeric");

    expect(numericCitationFormatter.formatInline([records[0], records[1]], context)).toBe("[2, 7]");
    expect(numericCitationFormatter.orderBibliography(records, context).map((item) => item.input.paperId)).toEqual(["paper-1", "paper-2"]);
  });

  it("deduplicates inline numeric records without changing canonical numbers", () => {
    const paper = record("paper-1", { citationNumber: 1 });
    const context = buildCitationFormatContext([paper], "numeric");
    expect(numericCitationFormatter.formatInline([paper, paper], context)).toBe("[1]");
  });

  it("returns no visible marker for a claim with zero citation candidates", () => {
    const context = buildCitationFormatContext([], "numeric");
    expect(numericCitationFormatter.formatInline([], context)).toBe("");
    expect(authorYearCitationFormatter.formatInline([], { ...context, style: "author_year" })).toBe("");
  });

  it("treats stored author strings as opaque display names", () => {
    const paper = record("paper-1", { citationNumber: 1, authors: ["Alice Smith"], publicationYear: 2024 });
    const context = buildCitationFormatContext([paper], "author_year");

    expect(authorYearDisplayLabel(paper.input)).toBe("Alice Smith");
    expect(authorYearCitationFormatter.formatInline([paper], context)).toBe("(Alice Smith, 2024)");
    expect(authorYearCitationFormatter.formatBibliographyEntry(paper, context)).toBe("Alice Smith (2024). Paper paper-1. Journal");
  });

  it("formats one, two, and many opaque display-name authors without name parsing", () => {
    const one = record("one", { citationNumber: 1, authors: ["Alice Smith"] });
    const two = record("two", { citationNumber: 2, authors: ["Alice Smith", "Bob Jones"] });
    const many = record("many", { citationNumber: 3, authors: ["Alice Smith", "Bob Jones", "Cara Lee"] });
    const context = buildCitationFormatContext([one, two, many], "author_year");

    expect(authorYearCitationFormatter.formatInline([one], context)).toBe("(Alice Smith, 2024)");
    expect(authorYearCitationFormatter.formatInline([two], context)).toBe("(Alice Smith & Bob Jones, 2024)");
    expect(authorYearCitationFormatter.formatInline([many], context)).toBe("(Alice Smith et al., 2024)");
  });

  it("assigns collision suffixes from deterministic title and Paper-ID order", () => {
    const first = record("paper-b", { citationNumber: 2, title: "Zeta", authors: ["Alice Smith"], publicationYear: 2024 });
    const second = record("paper-a", { citationNumber: 1, title: "Alpha", authors: ["Alice Smith"], publicationYear: 2024 });
    const third = record("paper-c", { citationNumber: 3, title: "Omega", authors: ["Alice Smith"], publicationYear: 2024 });
    const context = buildCitationFormatContext([first, second, third], "author_year");

    const suffixes = buildAuthorYearSuffixes([first, second, third]);
    expect(suffixes.get("paper-a")).toBe("a");
    expect(suffixes.get("paper-c")).toBe("b");
    expect(suffixes.get("paper-b")).toBe("c");
    expect(authorYearCitationFormatter.formatInline([first, second, third], context)).toBe("(Alice Smith, 2024a; Alice Smith, 2024b; Alice Smith, 2024c)");
    expect(authorYearCitationFormatter.orderBibliography([first, second, third], context).map((item) => item.input.paperId)).toEqual(["paper-a", "paper-c", "paper-b"]);
  });

  it("uses the actual derived label and year token as the collision key", () => {
    const first = record("one", { citationNumber: 1, authors: ["Alice Smith"], publicationYear: 2024 });
    const second = record("two", { citationNumber: 2, authors: ["Smith"], publicationYear: 2024 });
    const third = record("three", { citationNumber: 3, authors: ["Alice Smith"], publicationYear: null });

    expect(authorYearCollisionKey(first.input)).not.toBe(authorYearCollisionKey(second.input));
    expect(authorYearCollisionKey(first.input)).not.toBe(authorYearCollisionKey(third.input));
    expect(buildAuthorYearSuffixes([first, second, third]).size).toBe(0);
  });

  it("supports deterministic suffixes beyond z", () => {
    const records = Array.from({ length: 28 }, (_, index) => record(`paper-${String(index).padStart(2, "0")}`, {
      citationNumber: index + 1,
      title: `Paper ${String(index).padStart(2, "0")}`,
      authors: ["Alice Smith"],
      publicationYear: 2024,
    }));
    const suffixes = buildAuthorYearSuffixes(records);
    expect(suffixes.get("paper-00")).toBe("a");
    expect(suffixes.get("paper-25")).toBe("z");
    expect(suffixes.get("paper-26")).toBe("aa");
    expect(suffixes.get("paper-27")).toBe("ab");
  });

  it("uses title as the missing-author label and n.d. for a missing year", () => {
    const paper = record("paper-1", { citationNumber: 1, title: "Untitled Authors Study", authors: [], publicationYear: null, venue: null, doi: null });
    const context = buildCitationFormatContext([paper], "author_year");

    expect(authorYearCitationFormatter.formatInline([paper], context)).toBe("(Untitled Authors Study, n.d.)");
    expect(authorYearCitationFormatter.formatBibliographyEntry(paper, context)).toBe("Untitled Authors Study (n.d.)");
    expect(numericCitationFormatter.formatBibliographyEntry(paper, buildCitationFormatContext([paper], "numeric"))).toBe("1. Untitled Authors Study. n.d.");
  });

  it("disambiguates colliding missing-year labels with an explicit n.d. suffix", () => {
    const first = record("paper-a", { citationNumber: 1, authors: ["Alice Smith"], title: "Alpha", publicationYear: null });
    const second = record("paper-b", { citationNumber: 2, authors: ["Alice Smith"], title: "Beta", publicationYear: null });
    const context = buildCitationFormatContext([first, second], "author_year");

    expect(authorYearCitationFormatter.formatInline([first, second], context)).toBe("(Alice Smith, n.d.-a; Alice Smith, n.d.-b)");
  });

  it("omits missing optional bibliography segments without fabricated values", () => {
    const paper = record("paper-1", { citationNumber: 1, authors: ["Alice Smith"], venue: null, doi: null });
    const context = buildCitationFormatContext([paper], "numeric");
    const rendered = numericCitationFormatter.formatBibliographyEntry(paper, context);

    expect(rendered).toBe("1. Alice Smith. Paper paper-1. 2024");
    expect(rendered).not.toContain("undefined");
    expect(rendered).not.toContain("null");
  });

  it("sorts author-year bibliography by opaque display label, year, title, and Paper ID", () => {
    const titleFallback = record("paper-3", { citationNumber: 3, authors: [], title: "Beta", publicationYear: null });
    const smith = record("paper-2", { citationNumber: 2, authors: ["Smith"], title: "Zeta", publicationYear: 2020 });
    const alice = record("paper-1", { citationNumber: 1, authors: ["Alice Smith"], title: "Alpha", publicationYear: 2024 });
    const context = buildCitationFormatContext([titleFallback, smith, alice], "author_year");

    expect(authorYearCitationFormatter.orderBibliography([titleFallback, smith, alice], context).map((item) => item.input.paperId)).toEqual(["paper-1", "paper-3", "paper-2"]);
  });

  it("reports missing metadata separately from successfully rendered output", () => {
    const paper = record("paper-1", { citationNumber: 1, authors: [], publicationYear: null, venue: null });
    expect(missingMetadataWarnings([paper])).toEqual([
      { paperId: "paper-1", field: "authors", message: "Paper has no authors; formatting uses its title as the author label." },
      { paperId: "paper-1", field: "publication_year", message: "Paper has no publication year; formatting uses n.d." },
      { paperId: "paper-1", field: "venue", message: "Paper has no venue; formatting omits the venue." },
    ]);
  });

  it("selects only the finite supported formatter styles", () => {
    expect(citationFormatterFor("numeric")).toBe(numericCitationFormatter);
    expect(citationFormatterFor("author_year")).toBe(authorYearCitationFormatter);
  });

  it("does not mutate input records while normalizing or sorting", () => {
    const paper = record("paper-1", { citationNumber: 4, authors: [" Alice Smith "], venue: " Journal " });
    const before = structuredClone(paper);
    const context = buildCitationFormatContext([paper], "author_year");
    authorYearCitationFormatter.orderBibliography([paper], context);
    authorYearCitationFormatter.formatInline([paper], context);
    expect(paper).toEqual(before);
  });
});
