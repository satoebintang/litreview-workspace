# ADR 0033: Critical appraisal foundation

Status: Accepted for Slice 33 implementation

## Context

Researchers need a structured way to record critical appraisal judgments for a
Paper without turning an appraisal into screening, extraction, Evidence,
synthesis, Claim, Research Question Answer, manuscript, or PRISMA state. The
workspace must support custom, design-appropriate frameworks while preserving
the exact definition and provenance used for every saved appraisal revision.
Official result-level risk-of-bias or outcome-level instruments are not
truthful without a real result or effect-estimate identity in the domain.

## Decision

Critical appraisal is a Paper-level custom-framework workflow. A Framework has
mutable draft FrameworkVersions and immutable finalized FrameworkVersions. A
stable Paper × Framework Appraisal owns immutable AppraisalRevisions. Each
revision contains one complete response snapshot, optional rationale and
researcher overall judgment, same-Paper Evidence links, and the exact current
title/abstract and full-text inclusion decision identities.

The implementation uses the ten Slice 33 tables in migration
`0031_critical_appraisal.sql`:

- custom frameworks and immutable version definitions;
- sections, items, response options, and overall-judgment options;
- stable appraisals, immutable revisions, response snapshots, and Evidence
  links with review-state snapshots.

At revision finalization, both stored eligibility decisions must be the latest
decisions for the same Paper and both must currently be `include`. Each linked
Evidence row is locked in UUID order and its latest review decision is read
after the lock. An accepted, needs-review, or rejected link stores that exact
decision identity and state; an unreviewed link stores no decision identity.
Rejected links may continue only when the exact `(framework item, Evidence)`
pair existed in the immediately preceding finalized revision of the same
Appraisal and FrameworkVersion. A new FrameworkVersion has fresh item
identities and therefore has no rejected-link carry-forward.

Framework-version movement is monotonic. The first appraisal uses the latest
finalized version, ordinary edits remain on the current version, and an
explicit reassessment may select only a newer latest finalized version. Once a
newer version is current, an older version cannot become current again. The
service and database trigger enforce this boundary.

Revision construction may insert temporary child rows inside one transaction,
but a deferred constraint trigger rejects any transaction that commits an
unfinalized revision. The same finalization validation requires exactly one
response for every framework item, no foreign or extra items, exact
item/version option ownership, and an overall option from the exact version
when overall judgment is required.

The canonical appraisal-write lock order is:

```text
Paper → Framework → FrameworkVersion → Appraisal
      → Evidence rows in UUID order → revision and children
```

Framework-definition-only commands do not acquire Paper or Evidence locks.
Archiving freezes existing drafts as permanently read-only and preserves their
history; it does not delete draft state.

The UI exposes only custom frameworks, exact version warnings, immutable
history, and researcher-authored descriptive judgments. It does not ship
official RoB/JBI/CASP/GRADE content, calculate scores, call AI, migrate
responses automatically, or gate downstream workflow. Overview and dashboard
counts are derived read models; appraisal writes produce zero mutations in
screening, extraction, synthesis, Claims, Research Question Answers,
manuscripts, and PRISMA accounting.

This is not an official RoB 2, ROBINS-I, JBI, CASP, or GRADE implementation.
Those instruments and any result-level integration require separate methodology
and licensing review; result-level appraisal additionally requires a real
result/effect-estimate identity before it can be modeled honestly.

## Consequences

- Appraisal provenance remains immutable and auditable without becoming a new
  canonical research-support graph.
- Framework authors can revise custom definitions through explicit immutable
  versions while prior appraisal history remains readable.
- Current Evidence review drift can be shown as a warning without rewriting a
  saved appraisal snapshot.
- Stale eligibility, stale Evidence review metadata, lower-version movement,
  partial revisions, and exact ownership violations fail deterministically at
  the database boundary as well as in the service.
- The initial worksheet uses bounded set-wise reads; Evidence search/loading is
  separately paginated so the worksheet does not perform an Evidence N+1 loop.

## Verification expectations

Slice 33 must verify fresh migration application, direct SQL trigger behavior,
exact rejected-Evidence carry-forward, monotonic version movement, optimistic
revision conflicts, concurrent first saves, framework-definition editor
behavior, the full custom-framework browser journey, and the complete project
test/build/Playwright gate. The repository must stop uncommitted at the Slice
32 baseline commit with no branch, tag, push, PR, publication, or Slice 34
work.
