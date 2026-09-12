# Literature Review Domain Glossary

## Paper

The canonical downstream research identity used by screening, retrieval, full-text eligibility, extraction, synthesis, and manuscript work.

## Full-text retrieval attempt

An immutable historical event recording an effort to obtain sufficient full-text material for a Paper. Its outcome is `pending`, `unavailable`, or `retrieved`.

## Current retrieval state

The operational state derived from the latest retrieval attempt by append sequence: `not_sought`, `pending`, `unavailable`, or `retrieved`.

## Ever retrieved

A historical audit fact that is true when any retrieval attempt for the Paper has outcome `retrieved`. It remains true if a later attempt is unavailable.

## Full-text screening decision

An immutable eligibility decision recorded only when the Paper is currently title/abstract included and its current retrieval state is `retrieved`. Historical decisions remain readable when those prerequisites later change.

## Final inclusion

A Paper is finally included only when its current title/abstract decision is `include` and its current full-text decision is `include`. Retrieval state does not alter this formula after a full-text decision exists.

## Synthesis preparation

A persistent, researcher-controlled workspace session scoped to one pinned Evidence Set composition revision and one ExtractionField. It derives reachable candidate ExtractionRevisions and stores mutable working selections without altering analytical support provenance.

## Preparation context

Workflow metadata recording that an exact SynthesisRevision was finalized from a SynthesisPreparation session, linking the source Evidence Set and pinned composition sequence while remaining structurally separate from formal supports.

## Synthesis interpretation

A structured, immutable qualitative snapshot authored on an exact finalized SynthesisRevision. It records a convergence state, overall summary, optional researcher note, and ordered relational children for limitations, open questions, and contradiction pairs between exact supporting extracted observations.

## Convergence state

An explicit researcher-authored classification describing the agreement of supporting evidence for an exact SynthesisRevision: `convergent` (zero contradiction pairs), `mixed` (0 to 500 contradiction pairs), `contradictory` (at least 1 contradiction pair), or `inconclusive` (0 to 500 contradiction pairs).

## Contradiction pair

A canonical, unordered pair of distinct ExtractionRevisions that both serve as exact supports of the interpreted SynthesisRevision, accompanied by an optional researcher explanation note.

## Research question traceability

A structured planning layer recording the append-only history of linking and unlinking review artifacts (Extraction Fields, Evidence Sets, Synthesis Statements, and Claims) to project Research Questions. Traceability is descriptive planning history, not analytical provenance, and does not alter the formal support graph, citations, or manuscript placement semantics.

## Current link

The operational state derived from the greatest-sequence traceability event for a given `(project, question, target)` tuple; a target is currently linked if and only if its latest event action is `linked`.

## Research Question Answer

An immutable, researcher-authored snapshot answering one exact Research Question. It records the answer text and optional researcher note together with the exact ClaimRevision and/or SynthesisRevision rows consulted at finalization. An Answer is historical drafting context, not formal support, citation provenance, manuscript content, or a ReviewFlow/PRISMA input.

## Answer context reference

A typed exact reference from a finalized Research Question Answer to one ClaimRevision or SynthesisRevision. New references must identify the greatest finalized active revision of a currently linked stable target and pass that revision's existing formal support eligibility. References never float to a later revision.

## Answer drift flag

A read-derived annotation describing how current traceability, lifecycle, or revision state differs from an Answer's immutable context. Approved flags are `referenced_claim_revision_superseded`, `referenced_claim_now_withdrawn`, `referenced_claim_no_longer_linked_to_rq`, `referenced_synthesis_revision_superseded`, `referenced_synthesis_now_withdrawn`, and `referenced_synthesis_no_longer_linked_to_rq`. Drift is never persisted and is not a global Answer quality or completion judgment.

## Project-wide protocol context

Search strategies and search runs defined within the review protocol. These records are independently Project-scoped, represent review-wide search methods, and are never attributed to individual Research Questions.
