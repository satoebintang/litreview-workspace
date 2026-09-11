# ADR 0018: Synthesis preparation from Evidence Sets as workflow context

- Status: Accepted
- Date: 2026-09-11

## Context

Researchers synthesising evidence across extracted findings need a structured workspace to compare candidate extractions and prepare formal synthesis statements. Slice 17 introduced persistent, versioned Evidence Sets, and Slice 4 established immutable SynthesisRevisions with exact ExtractionRevision support links. 

We must define the boundary between the flexible, researcher-controlled workspace used to assemble candidates and the immutable analytical provenance recorded in formal synthesis.

## Decision

Introduce a persistent `synthesis_preparations` workspace session that pins one exact Evidence Set composition revision and one ExtractionField.

Preparation is workflow context, never analytical provenance:

`EvidenceSet composition → SynthesisPreparation → selected ExtractionRevision IDs → existing Synthesis command → immutable SynthesisRevision supports`

Formal support remains exclusively:

`SynthesisRevision → synthesis_revision_supports → exact ExtractionRevision`

Key architecture choices:
1. **Persistent sessions with pinned composition:** A preparation session pins the latest EvidenceSet composition revision at creation. Subsequent edits or archival of the source Evidence Set never alter the preparation's candidate population.
2. **Field-scoped comparison:** Each preparation is scoped to exactly one ExtractionField. Reachable candidates derive strictly from the pinned composition members through stable memberships to Evidence and `extraction_revision_evidence`. Direct SQL cannot link a candidate from a different field.
3. **Mutable working selections:** Selections are stored in a mutable join table (`synthesis_preparation_selections`) without recording interim selection-event history. Selections may be added or removed freely while active.
4. **Isolated selection-replacement validation:** Replacing selections evaluates current reachability and selectability only for newly added candidates. Previously selected candidates whose eligibility drifted (e.g. Paper exclusion) may remain selected and visible without blocking selection saving.
5. **One-way workflow context link:** Upon finalization, the preparation transitions to `finalized` and records a one-way pointer to `finalized_synthesis_revision_id`. No EvidenceSet or Preparation ID is added to `synthesis_revisions` or `synthesis_revision_supports`.
6. **Shared atomic synthesis writer:** Finalization delegates to the transaction-scoped synthesis writer (`writeActiveSynthesisRevision`), which remains the single authority for supporting Paper locking and Slice 4 support eligibility. Global lock ordering is strictly preserved (`Preparation → Papers → SynthesisStatement`).
7. **PostgreSQL enforcement:** Database triggers reject preparation deletion and reopening, enforce field equality and reachability on selection insert, freeze terminal sessions, and deferentially assert `set(preparation selections) = set(finalized synthesis supports)` at finalization.

## Consequences

- Analytical provenance remains pure: citations, claims, manuscripts, and reporting continue to rely exclusively on exact ExtractionRevisions.
- Preparation state is preserved for retrospective audit without polluting analytical graphs.
- Withdrawn target statements can be reactivated seamlessly by appending a new active revision through the shared writer.
- Migrations 0000–0017 remain untouched; Slice 18 is strictly additive.
