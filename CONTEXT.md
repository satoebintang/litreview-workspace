# Literature Review Domain Glossary

## Paper

The canonical downstream research identity used by screening, retrieval, full-text eligibility, extraction, synthesis, and manuscript work.

## PDF intake

An immutable project-owned staged PDF source artifact. It is not a Paper or a
FullTextDocument until explicit researcher resolution. Local metadata proposals
and their field-level provenance remain intake audit history; resolution creates
or selects the canonical Paper and materializes the exact bytes through the
ordinary FullTextDocument workflow.

## Bibliographic import

An immutable project intake artifact containing the original uploaded BibTeX or
RIS UTF-8 bytes, source hash, parser provenance, and durable parsed records. It
is separate from SearchRun/RetrievedRecord acquisition and does not create a
canonical Paper until an explicit resolution event.

## Bibliographic import record

An immutable parsed metadata snapshot with source key/ordinal, exact
`[start_byte, end_byte)` offsets into the original upload, field states, and
parse diagnostics. It remains historical after resolution and never rewrites
the canonical Paper.

## Bibliographic import resolution

An append-only researcher decision that creates a new canonical Paper, matches
an existing project Paper, or leaves a record unresolved. Matching establishes
identity only; it does not merge or overwrite canonical metadata.

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

## Answer-to-Manuscript drafting

An explicit researcher action that uses an Answer's submitted text and exact
ClaimRevision identities as drafting context for existing Manuscript prose and
Claim placement primitives. It does not generate prose, copy researcher notes,
or create a support edge.

## Manuscript editorial review

An append-only ReviewThread and ReviewEvent history attached to a stable
SectionItem. The opening context is immutable, while review lifecycle and
comments remain separate from research provenance, ProseRevision history, and
snapshot presentation.

## ProseBlock

A stable Manuscript content identity attached to one Prose SectionItem. Its
content is represented by an immutable, ordered ProseRevision stream; revisions
never rewrite earlier text.

## ProseRevision

One immutable researcher-authored text revision for an exact ProseBlock. A live
Manuscript resolves the greatest revision for that block; a historical snapshot
copies the exact revision identity and text it captured.

## Manuscript Snapshot

An immutable, explicit researcher capture of one coherent whole-Manuscript
state. It freezes title, citation style, visible Section and SectionItem
composition/order, exact ProseRevision and ClaimRevision identities and text,
historical citation presentation, warnings, and canonical Markdown plus its
SHA-256. Snapshot bibliography membership is presentation history, not formal
Claim support or citation provenance.

## Manuscript history boundaries

Research provenance runs from Evidence through ExtractionRevision,
SynthesisRevision, and ClaimRevision to support and placement. Manuscript
content history is the ProseBlock/ProseRevision stream. Editorial history is the
ReviewThread/ReviewEvent stream. Snapshot history is the frozen composition and
presentation artifact. None of these histories silently mutates another, and a
snapshot is not a release, approval, rollback, or publication record.

## Workspace navigation boundaries

Project navigation, Overview recommendations, and Overview metrics are derived
presentation. They do not represent a workflow stage, mutate provenance, or
create canonical research state. The project shell reads only project identity;
the Overview reads bounded current facts; primary landing GETs remain
read-only. Manuscript creation requires an explicit researcher POST, and Paper,
PDF, and bibliographic intake boundaries remain distinct from canonical Paper
identity.

## Custom Appraisal Framework

A project-local researcher-authored definition for descriptive appraisal of a
finally included Paper. Critical appraisal is separate from screening,
Evidence, Extraction, Synthesis, Claims, Research Question Answers, manuscript
content, GRADE, and PRISMA accounting. It has no numeric score, no AI-generated
canonical state, and no downstream synthesis gate.

## Appraisal

The stable identity for one Project × Paper × Custom Appraisal Framework pair.
Opening a worksheet does not create it; the first explicit save creates the
identity, and later corrections or reassessments append immutable revisions.

## FrameworkVersion

An immutable finalized definition of one custom critical-appraisal framework.
Its sections, items, response options, and optional overall-judgment options
are captured exactly by later AppraisalRevisions. A mutable draft may be
edited until explicit finalization; finalized definitions cannot be changed.

## AppraisalRevision

An immutable complete response snapshot for one stable Paper × Framework
Appraisal. It records the exact latest title/abstract and full-text inclusion
decision identities at save time, exact same-Paper Evidence links and their
review-state snapshots, response rationales, and an optional researcher overall
judgment. A revision is valid only when the Paper is currently finally included
and every response and option belongs to the exact pinned FrameworkVersion.

## Appraisal completion

A derived state, never stored as canonical data. An AppraisalRevision is
`complete` when every required framework item has a selected option and an
overall option is selected when that exact FrameworkVersion requires one;
otherwise it is `in_progress`. Completion has no score and never changes
screening, synthesis eligibility, or any downstream provenance.

## Appraisal version drift

The derived condition in which a newer finalized FrameworkVersion exists than
the version currently used by an Appraisal. The researcher may continue editing
the current version until explicitly beginning a newer-version reassessment.
Version movement is monotonic: once a newer version becomes current, an older
version cannot become current again. Response migration is never automatic.

## Appraisal Evidence snapshot

The exact Evidence identity, saved review-decision identity/state, and
appraisal-item relationship captured in an AppraisalRevision. Accepted,
needs-review, and rejected links must match the latest review decision at save;
unreviewed links have no decision identity. A rejected link can survive only
when the same FrameworkVersion item × Evidence pair existed in the immediately
preceding finalized revision of the same Appraisal. Current review drift is a
read-only warning and never rewrites the immutable snapshot.
