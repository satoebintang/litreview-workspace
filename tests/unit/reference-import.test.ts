import { describe, expect, it } from "vitest";
import { deriveBibtexKey, escapeBibtexValue, serializeBibtex } from "@/domain/bibtex-export";
import { parseBibtexSource, parseRisSource } from "@/domain/reference-import";
import { bibliographicParser } from "@/infrastructure/bibliographic-parser";

describe("reference import adapters", () => {
  it("keeps BibTeX spans as UTF-8 byte offsets and authors in source order", () => {
    const source = "@article{caf,\n  title = {Café \\textbf{Study}},\n  author = {Doe, Jane and Álvarez, Juan},\n  year = {},\n}\n";
    const result = parseBibtexSource(source);
    expect(result.records).toHaveLength(1);
    const record = result.records[0];
    expect(Buffer.from(source).subarray(record.sourceSpan.startByte, record.sourceSpan.endByte).toString()).toBe(source.trimEnd());
    expect(record.title).toBe("Café Study");
    expect(record.title).not.toMatch(/<span|<b|<i/);
    expect(record.authors.map((author) => author.family)).toEqual(["Doe", "Álvarez"]);
    expect(record.fields.year.state).toBe("empty");
    expect(record.fields.title.span?.startByte).toBe(Buffer.from(source).indexOf(Buffer.from("title")));
  });

  it("frames RIS records through ER and preserves ordered AU values", () => {
    const source = "TY  - JOUR\r\nAU  - Doe, Jane\r\nAU  - Álvarez, Juan\r\nTI  - Café\r\nDO  - 10.1000/example\r\nER  -\r\n";
    const result = parseRisSource(source);
    expect(result.records).toHaveLength(1);
    const record = result.records[0];
    expect(Buffer.from(source).subarray(record.sourceSpan.startByte, record.sourceSpan.endByte).toString()).toBe(source.slice(0, source.indexOf("\r\n", source.indexOf("ER"))));
    expect(record.authors.map((author) => author.family)).toEqual(["Doe", "Álvarez"]);
    expect(record.doi).toBe("10.1000/example");
  });

  it("diagnoses unbounded records and source bounds", () => {
    const result = parseBibtexSource("@article{one, title={x}", { maxRecordBytes: 10 });
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "record_too_large" || diagnostic.code === "truncated_record")).toBe(true);
    expect(parseRisSource("TY  - JOUR\nTI  - x\n", { maxSourceBytes: 4 }).diagnostics.some((diagnostic) => diagnostic.code === "source_too_large")).toBe(true);
  });

  it("bridges into the parser-neutral Paper metadata contract", () => {
    const [record] = bibliographicParser.parse(new TextEncoder().encode("TY  - JOUR\nAU  - Doe, Jane\nAU  - Álvarez, Juan\nTI  - Café\nUR  - https://example.test/paper\nER  -\n"), "ris");
    expect(record.authors).toEqual(["Jane Doe", "Juan Álvarez"]);
    expect(record.startByte).toBe(0);
    expect(record.endByte).toBeGreaterThan(record.startByte);
    expect(record.fieldStates?.title).toBe("present");
    expect(record.url).toBe("https://example.test/paper");
  });

  it("maps BibTeX venue fallbacks and RIS T2 while preserving invalid field states", () => {
    const [bibtex] = bibliographicParser.parse(new TextEncoder().encode("@inproceedings{x, title={Talk}, booktitle={Proceedings}, year={20}}"), "bibtex");
    expect(bibtex.venue).toBe("Proceedings");
    expect(bibtex.fieldStates?.publicationYear).toBe("invalid");
    const [ris] = bibliographicParser.parse(new TextEncoder().encode("TY  - CONF\nTI  - Talk\nT2  - Proceedings\nER  -\n"), "ris");
    expect(ris.venue).toBe("Proceedings");
    expect(ris.fieldStates?.venue).toBe("present");
  });

  it("uses the maintained BibTeX parser for macros while persisting plain Unicode", () => {
    const source = String.raw`@string{venue = "Journal of Research"}
@article{rich,
  title = {A {NASA} study with \textit{markup} and Acc\'ent},
  author = {{National Aeronautics and Space Administration} and Müller, Jörg},
  journal = venue,
  year = {2024},
  note = {\unknown{bounded}}
}`;
    const [record] = parseBibtexSource(source).records;
    expect(record.title).toBe("A NASA study with markup and Accént");
    expect(record.journal).toBe("Journal of Research");
    expect(record.authors.map((author) => author.raw)).toEqual(["National Aeronautics and Space Administration", "Jörg Müller"]);
    expect(record.title).not.toMatch(/<[^>]+>|\u000e|\u000f/);
  });

  it("keeps every record span byte-exact across multibyte boundaries", () => {
    const source = Buffer.from("前置 🚀\n@article{a, title={研究}}\n間隔\n@article{b, title={終わり 🚀}}\n", "utf8");
    const result = parseBibtexSource(source);
    expect(result.records).toHaveLength(2);
    for (const record of result.records) {
      expect(source.subarray(record.sourceSpan.startByte, record.sourceSpan.endByte).toString("utf8")).toBe(record.raw);
    }
    expect(source.subarray(result.records[0].sourceSpan.endByte, result.records[1].sourceSpan.startByte).toString("utf8")).toContain("間隔");
  });

  it("keeps exact spans when an optional UTF-8 BOM precedes the first record", () => {
    const source = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("前置\n@article{bom, title={研究 🚀}}\n", "utf8")]);
    const [record] = parseBibtexSource(source).records;
    expect(record.sourceSpan.startByte).toBe(source.indexOf(Buffer.from("@article")));
    expect(source.subarray(record.sourceSpan.startByte, record.sourceSpan.endByte).toString("utf8")).toBe(record.raw);
  });

  it("accepts an optional UTF-8 BOM before an RIS TY record", () => {
    const source = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("TY  - JOUR\r\nTI  - BOM record\r\nER  -\r\n", "utf8")]);
    const [record] = parseRisSource(source).records;
    expect(record.title).toBe("BOM record");
    expect(record.sourceSpan.startByte).toBe(3);
    expect(source.subarray(record.sourceSpan.startByte, record.sourceSpan.endByte).toString("utf8")).toBe(record.raw);
  });

  it("warns on duplicate citation keys without treating them as identity", () => {
    const result = parseBibtexSource("@article{same, title={First}}\n@article{same, title={Second}}\n");
    expect(result.records).toHaveLength(2);
    expect(result.records[1].diagnostics.map((diagnostic) => diagnostic.code)).toContain("duplicate_key");
  });

  it("keeps literal HTML-looking metadata as text", () => {
    const [record] = parseBibtexSource("@article{x, title={<script>alert(1)</script>}}").records;
    expect(record.title).toBe("<script>alert(1)</script>");
  });

  it("retains partial records with a warning when title metadata is absent", () => {
    const [record] = bibliographicParser.parse(new TextEncoder().encode("@article{untitled, author={Doe, Jane}}"), "bibtex");
    expect(record.title).toBeNull();
    expect(record.outcome).toBe("parsed_with_warnings");
    expect(record.diagnostics?.some((diagnostic) => diagnostic.startsWith("missing_title:"))).toBe(true);
  });

  it("resynchronizes a truncated BibTeX record before a later valid record", () => {
    const source = "@article{bad, title={unterminated\n@article{good, title={Good}}";
    const result = parseBibtexSource(source);
    expect(result.records).toHaveLength(2);
    expect(result.records[0].diagnostics.map((diagnostic) => diagnostic.code)).toContain("truncated_record");
    expect(result.records[1].title).toBe("Good");
  });
});

describe("BibTeX export", () => {
  it("escapes values and adds an immutable deterministic ID suffix", () => {
    expect(escapeBibtexValue("A {study} 50%\\done $x_1^~\r\nnext")).toBe("A \\{study\\} 50\\%\\textbackslash{}done \\$x\\_1\\^{}\\~{}\nnext");
    expect(deriveBibtexKey({ id: "paper-1", title: "A study", authors: [{ family: "Doe", given: "Jane", suffix: null, literal: null, raw: "Doe, Jane" }], year: 2024 })).toMatch(/^Doe2024astudy-[0-9a-f]{8}$/);
    const bib = serializeBibtex([{ id: "paper-1", title: "A study", authors: [{ family: "Doe", given: "Jane", suffix: null, literal: null, raw: "Doe, Jane" }], year: 2024 }]);
    expect(bib).toContain("@misc{");
    expect(bib).toContain("author = {{Doe, Jane}}");
    expect(bib).toContain("title = {A study}");
  });

  it("round-trips supported canonical Paper metadata through deterministic BibTeX", () => {
    const bib = serializeBibtex([{
      id: "paper-round-trip",
      title: String.raw`Café {NASA} study \\ { } % & $ # _ ^ ~ "`,
      authors: ["Doe, Jane", "National Aeronautics and Space Administration"],
      year: 2024,
      journal: "Journal & Review",
      doi: "10.1000/ABC",
      abstract: "Line one\nLine two",
    }]);
    const [record] = parseBibtexSource(bib).records;
    expect(record.title).toBe(String.raw`Café {NASA} study \\ { } % & $ # _ ^ ~ "`);
    expect(record.authors.map((author) => author.raw)).toEqual(["Doe, Jane", "National Aeronautics and Space Administration"]);
    expect(record.year).toBe(2024);
    expect(record.journal).toBe("Journal & Review");
    expect(record.doi).toBe("10.1000/ABC");
    expect(record.abstract?.replace(/\s+/g, " ")).toBe("Line one Line two");
  });
});
