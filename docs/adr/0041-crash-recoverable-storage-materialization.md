# ADR 0041: Crash-recoverable storage materialization

Status: Accepted for Slice 41 implementation

## Context

PostgreSQL cannot atomically commit with the local filesystem. Before Slice 41,
an upload could make a canonical FullTextDocument or PDF intake durable in
PostgreSQL while a process crash left the corresponding bytes incomplete or
missing. PDF resolution also coupled the researcher decision to document
materialization, making a retry capable of recomputing the Paper decision.

## Decisions

### Explicit storage state

`full_text_documents` and `pdf_intakes` carry `storage_state` (`pending` or
`ready`) and nullable `staged_storage_key`. Migration `0033` temporarily gives
existing rows a `ready` default to backfill them, enforces non-null and state
shape checks, and then drops the default. Every future writer must name its
state. `ready` rows have no recorded stage; `pending` rows have one exact,
namespace-checked recovery key.

The database permits only these mutations:

- FullTextDocument pending stage A to pending stage B.
- FullTextDocument pending with stage to ready with no stage.
- FullTextDocument ready and unarchived to ready and archived.
- PDF intake pending stage A to pending stage B.
- PDF intake pending with stage to ready with no stage.

Byte identity, storage key, ownership, and timestamps stay immutable. A
pending FullTextDocument cannot be archived, and ready state cannot be reversed.

### Materialization order

The writer durably stages and hashes the stream, commits the canonical
`pending` identity and exact recovery key, then installs the final path with an
atomic no-overwrite hard link. It verifies final byte size and SHA-256, syncs
the regular file and parent directory where the filesystem supports directory
sync, and conditionally changes the row to `ready`. A filesystem that cannot
provide exclusive installation leaves the row pending and returns an
operational storage error. A destination found during a concurrent install is
inspected and is never replaced.

Recovery verifies both the recorded stage and any existing final path. A
missing stage can be replaced only by bytes with the same immutable size and
SHA-256. For a committed `created_document` PDF resolution, the retained,
ready intake bytes are the replacement source. Mismatched or unsafe files stay
in place and are reported for operator review.

### PDF resolution boundary

The SERIALIZABLE research transaction commits the exact Paper decision,
FullTextDocument ID, and immutable PDF resolution together. Storage completion
runs after that transaction. A retry with the same request fingerprint
finishes the stored resolution before loading or recalculating candidates; it
does not rerun the research decision. A referenced intake must be ready. A
`created_document` resolution may reference a pending or ready FullTextDocument
while completing; a `reused_document` resolution must reference a ready one.

### Ready-only use

Public FullTextDocument reads, downloads, preferred-document selection, new
Evidence, and new text extraction require a ready file. Existing historical
Evidence continues to point to its exact immutable document and extraction
identity. Existing archive and extraction-provenance guards remain in force.

### Audit and reconciliation

`npm run storage:audit` reports pending operations, missing or mismatched
ready files, orphan final files, unowned or unexpected staged artifacts, and
integrity conflicts. It uses a read-only REPEATABLE READ database snapshot.
`npm run storage:reconcile` retries only known pending owners in bounded pages,
then runs the same audit. Neither command deletes unknown files, mismatched
files, orphan finals, or unowned stages. Both default to all projects and accept
an optional `--project <uuid>` filter. JSON output is bounded per finding kind.

One benign crash window is accepted: after PostgreSQL changes a document to
ready and clears its stage key, the process may stop before removing the stage
file. Audit reports that file as an unowned staged artifact. Reconciliation
does not delete it. Canonical provenance is already correct; the leftover is
operational garbage. A ready row with a missing or mismatched final is an
integrity failure, and an unknown final file is reported without guessing at
its ownership.

An upload can also stop after staging but before a pending owner is committed,
or receive an error while the commit outcome is uncertain. Audit reports that
stage as unowned, and reconciliation does not guess at deleting it. Writers
keep the stage on outcome-uncertain errors instead of treating an immediate
missing-owner query as proof that a commit cannot still complete. A confirmed
application-validation or PostgreSQL constraint rollback may remove its stage.

### Migration and compatibility

Migration `0033_storage_materialization_recovery.sql` backfills existing
documents and intakes to ready without changing their IDs, immutable byte
metadata, Evidence, or resolution history. Existing upload and resolution
response shapes remain stable. A pending operation is visible as a storage
pending/unavailable result instead of being exposed as a usable artifact.

## Consequences

PostgreSQL contains a durable recovery intent before a canonical file becomes
usable. The filesystem and database still do not share one atomic transaction,
so a crash can require retry or explicit reconciliation. Final installation is
exclusive and immutable, and successful recovery preserves the original
research decision and provenance identities.
