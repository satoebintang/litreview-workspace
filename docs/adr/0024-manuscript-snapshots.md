# ADR 0024: Immutable Manuscript Snapshots

## Status

Accepted for Slice 25.

## Decision

Add explicit whole-Manuscript snapshots as immutable historical milestones.
Capture runs in one PostgreSQL `REPEATABLE READ` transaction. The first
authoritative Manuscript read supplies the `statement_timestamp()` persisted as
`captured_at`; every descendant read uses the same transaction executor.

The writer inserts a parent containing frozen metadata, expected child counts,
renderer/schema versions, canonical Markdown, and
`SHA-256(UTF-8(rendered_markdown))`. It then inserts typed Section, item, Prose,
Claim, bibliography, membership, and warning rows with dense historical
positions and finalizes the parent by changing only `finalized_at` from `NULL`.
Deferred validation re-queries the persisted relation set, verifies visible
active Section/SectionItem completeness (including empty active Sections;
archived Sections and removed SectionItems are outside the visible manuscript
and are omitted), exact copied
revision text, canonical assembly, and hash equality. Finalized parents and all
children reject update, delete, and insert mutation.

The persisted Markdown is the historical export contract. Application citation
formatters run before persistence; the database function only assembles already
formatted frozen values. Snapshot bibliography rows and capture annotations are
presentation facts and never participate in Claim support, provenance traversal,
Research Question coverage, Answers, or editorial review.

## Consequences

Live Manuscript reads and exports retain their existing meaning. Snapshot reads
use copied presentation values and never resolve current Paper metadata or a
later Prose/Claim revision. Sequence is a global PostgreSQL bigint exposed as a
decimal string at the JSON/UI boundary; it orders finalized snapshots for an
exact Manuscript but does not mean the working copy is at that milestone.

Slice 25 creates no backfill rows and no quality gate. Empty or warning-bearing
manuscripts, unsupported or superseded placements, withdrawn historical parents,
and open editorial concerns can all be captured as they existed. Snapshot
creation is not branching, rollback, approval, release, or publication
management.

## Concurrency and integrity

MVCC visibility at the boundary defines the captured state: a committed change
visible before the boundary is included, while a change committed after it is
absent. Source identity FKs anchor stable ownership only; mutable Placement
revision, Section order/title, citation style, and Paper metadata are copied and
therefore cannot block later working-copy mutation. Automatic retry is limited
to PostgreSQL `40001` serialization failures and `40P01` deadlocks, with a new
transaction establishing a new boundary.
