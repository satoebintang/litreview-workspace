# ADR 0026: Bibliographic Intake and Metadata Interchange

## Status

Accepted for Slice 27. Baseline: `v0.26.0-slice26` (`6b5a9270002fe70f49b04580111e19a107d3a640`).

## Decision

BibTeX and RIS uploads are durable intake artifacts, not direct Paper inserts
and not SearchRuns. Each upload stores one immutable original UTF-8 byte array
and parser provenance in `bibliographic_imports`; parsed records are immutable
`bibliographic_import_records`; and researcher decisions are append-only
`bibliographic_import_resolutions`. The source artifact is limited to 2 MiB
and repeated uploads are idempotent within a project, format, and SHA-256.

Record spans use `[start_byte, end_byte)` over the original uploaded bytes.
JavaScript UTF-16 indexes are never persisted as source offsets. Catastrophic
decode/parser failures produce a finalized failed import without misleading
records; record-level malformed input remains durable with a failed or warning
outcome when a bounded source span exists. The parser and adapter enforce
bounded source, record, author, field, macro, diagnostic, and nesting limits
without truncating accepted metadata.

The parser boundary is `BibTeX/RIS syntax -> maintained parser/framer ->
Tracework adapter -> plain Unicode metadata -> validation`. BibTeX uses the
exact pinned dependency `@retorquere/bibtex-parser@10.0.1`; parser presentation
markup such as generated `<span>` elements is stripped before metadata is
stored. RIS tags are mapped through the same parser-neutral Paper metadata
contract. Unsupported source fields remain bounded audit input and do not
become arbitrary canonical JSON.

An imported record becomes a canonical Paper only through an explicit
`created_paper`, `matched_paper`, or `cleared` resolution event. Imported source
metadata never overwrites a matched Paper. Manual and bibliographic intake use
candidate review for reviewed creation races. `writePaper(tx, ...)` is the
policy-neutral canonical validation/persistence seam; acquisition and
deduplication call it only to share validation and insertion, while retaining
their released RetrievedRecord/pair resolution semantics and lock order.

Canonical Papers export as deterministic neutral `@misc` BibTeX entries. Keys
derive from first-author/year/title tokens with a stable Paper-ID suffix and
deterministic collision handling. Supported fields are escaped as plain
BibTeX; no citation-style engine or publication-type inference is introduced.

## Consequences

Bibliographic records do not enter screening, extraction, Evidence, or formal
support graphs until a canonical Paper exists. ReviewFlow continues to count
canonical Papers, while records without historical Search acquisition links are
classified outside recorded-search identification totals. No network metadata
lookup, PDF-first staging, AI inference, automatic merge, or canonical metadata
overwrite is part of this slice.

The immutable source record provides the future boundary for Crossref-like
proposals or PDF-derived metadata without granting those sources automatic
write authority. A later PDF-first workflow remains a separate architecture
because it needs a document owner before a canonical Paper exists.
