# ADR 0027: PDF-First Intake and Metadata Proposals

## Status

Implemented for Slice 28. Baseline: `v0.27.0-slice27` (`fc9607491341a283b10feb699d964aadc7297113`).

## Decision

A PDF uploaded at a project boundary is an immutable, project-owned `PdfIntake`
source artifact. It is neither a canonical Paper nor a FullTextDocument. The
original streamed bytes remain in a dedicated `projects/{project}/pdf-intakes/`
storage namespace with project-plus-SHA idempotency. The four additive tables
`pdf_intakes`, `pdf_intake_metadata_results`, `pdf_intake_metadata_fields`, and
`pdf_intake_resolutions` preserve source identity, terminal local inspection
history, field-level provenance, and the final one-way researcher resolution.

Initial metadata inspection is local and deterministic with the pinned public
PDF.js API. It reads only the retained bounded bytes, PDF Info/XMP fields with
explicit semantics, and the first five physical pages under 100,000 code points
per page and 250,000 total. DOI extraction is limited to XMP `dc:identifier`,
`prism:doi`, `pdfx:doi`, and the bounded page-text scanner. Parser failures are
terminal `failed` metadata results; they do not remove a valid staged artifact.
An intake with no result can be completed exactly once by the explicit
`Inspect metadata` action. No GET performs inspection, and no OCR, network,
AI, fuzzy matching, or visual inference is involved.

Only explicit resolution creates a Paper through `writePaper` or selects a
project Paper. Matching never changes canonical metadata. Resolution stages a
fresh canonical copy outside the database transaction, then performs candidate
recomputation, Paper/document locking, canonical attachment or same-Paper
active-SHA reuse, and immutable resolution insertion in a SERIALIZABLE
transaction. A whole-operation retry always re-stages from the retained intake
and compensates any promoted canonical key. The first document is not made
preferred automatically, and resolution cannot later be cleared or retargeted.

## Consequences

After resolution the exact bytes are an ordinary Paper-owned FullTextDocument,
so existing document text extraction, Evidence, and downstream workflows apply
unchanged. Intake metadata provenance is audit history, not Evidence provenance.
Unresolved intakes are absent from Paper counts, screening/ReviewFlow
populations, SearchRun/RetrievedRecord totals, and PRISMA accounting. Future
Crossref/OpenAlex or AI producers may create additional proposal records but
cannot bypass the researcher-controlled canonical writer.
