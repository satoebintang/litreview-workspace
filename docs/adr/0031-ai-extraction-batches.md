# ADR 0031: AI extraction batch orchestration

Status: Accepted for Slice 31 implementation

Slice 31 adds bounded, researcher-confirmed orchestration over the released
Slice 26 AI extraction suggestion workflow. It does not create another
extraction authority.

## Decision

The database contains exactly two new domain tables:

- `ai_extraction_batches` stores the immutable researcher-confirmed batch
  manifest, canonical counts, disclosure versions, and one-way cancellation.
- `ai_extraction_batch_items` stores the immutable Paper × ExtractionField
  manifest, pinned source identity and page metadata, ordinal, intent hash, and
  the one-way relationship to an existing Slice 26 request.

Batch and item lifecycle state is derived from cancellation, item terminal
facts, and Slice 26 request/dispatch/result/decision rows. No provider result,
Evidence, ExtractionRevision, quality assessment, worker, or OpenAI Batch API
is introduced by this slice.

## Concurrency and stale-state policy

Preview confirmation, batch creation, and each item claim run in PostgreSQL
`SERIALIZABLE` transactions with at most three retries, only for `40001`
(`serialization_failure`) and `40P01` (`deadlock_detected`). Every retry
recomputes the complete eligibility and manifest checks. Locks follow the
documented order Batch, Paper, ExtractionField, full-text preference,
FullTextDocument, DocumentTextExtraction, then Slice 26 request/dispatch rows;
same-class UUID locks are ordered.

The eligible extraction is the exact latest non-failed extraction for the
current preferred document. A newer failed extraction does not displace an
older succeeded extraction; a newer pending or running extraction does. Page
manifests are read once per Paper/extraction during preview and reused across
selected fields.

## Canonical manifests and reuse

One PostgreSQL preview query assigns dense `item_ordinal` values. That ordinal
is persisted and is authoritative for all later ordering and aggregate hashes.
Manifest hashes use typed, UTF-8, byte-length-prefixed canonical scalars with
explicit nulls, lowercase UUID text, canonical booleans, and decimal integer
text. The item hash covers the raw Paper, field, option, source-identity, and
eligibility snapshots as well as the ordered page manifest. The persisted page
manifest is metadata-only (`pageId`, `pageNumber`, `pageOrdinal`,
`textSha256`, `characterCount`, and `byteSize`); PostgreSQL recomputes its hash
from those raw fields, and an empty source uses one canonical empty-manifest
sentinel. The persisted option snapshot is likewise the raw active option
metadata (`id`, `label`, and `sortOrder`), with its hash recomputed from that
array. PostgreSQL deferred checks reconstruct page, item, and aggregate hashes
from the persisted values. TypeScript and PostgreSQL cross-runtime vectors and
direct raw-manifest tamper failures are tested.

Preview validates the complete serialized provider input, including field
description, option vocabulary, page text, source coverage, and UTF-8 byte
limits, before any provider dispatch. Batch creation repeats the preview under
the same serializable boundary.

An existing successful candidate is reusable only when the exact request
intent and current source/field/baseline context match and no decision exists.
The final reuse check occurs inside the same serializable item transaction as
the relationship write, so a concurrent accept or reject causes a retry and a
fresh stale-state evaluation. Reuse performs no provider call.

Provider execution occurs only after the claim transaction commits. Acceptance
or edit-and-accept remains the ordinary researcher-controlled Slice 26 path.
