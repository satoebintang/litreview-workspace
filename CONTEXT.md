# Literature Review Domain Glossary

## Paper

The canonical downstream research identity used by screening, retrieval, full-text eligibility, extraction, synthesis, and manuscript work.

## Acquisition browsing

Protocol SearchRuns and RetrievedRecords use bounded cursor pages. SearchRun cursors pin the Project sequence high-water; RetrievedRecord cursors pin a database `created_at` epoch, the exact Run, page size, and normalized search state. Match-history cursors pin the record's event sequence. Duplicate-candidate cursors pin both a Paper insertion epoch and a Project-wide match-event sequence so sibling current matches are resolved at that same event boundary. These epochs are not cross-request MVCC snapshots; late commits at or before an epoch may appear on a later page. See `docs/adr/0046-scalable-acquisition-search-runs-and-retrieved-records.md`.

The exact RetrievedRecord detail owns complete source metadata, bounded history and candidate pages, and one PaperPicker workflow. Legacy acquisition projections and writers remain available. The normal Review Report uses compact acquisition aggregates; the explicit Markdown export retains all SearchRun snapshots and historical source labels. `0035_retrieved_record_run_order` is supported by the paired final-query plans in `docs/benchmarks/slice46-acquisition-read-paths.json`.

## Extraction canonical-write lock order

Within an Extraction canonical-write transaction, when multiple Extraction-
domain rows need locks, acquire Project, Paper, ExtractionField,
ExtractionOption, then Evidence rows in UUID ascending order. Field eligibility
and Option activity are checked from their locked rows. AI request/result/
dispatch/document locks belong to separate pre-existing workflow domains and
must be reviewed separately for cycles with this Extraction order; this is not
a universal database lock order.

## Extraction workspace reads

Progress pages preserve released Paper membership and review facts while
reading one bounded page with a fixed count/page query pair. A Paper worksheet
uses a read-only REPEATABLE READ snapshot and a fixed number of set-based reads
for active Fields, archived and active Options, current revisions, finalized
history, revision Evidence, and Paper-scoped Evidence with its current review
state. Worksheet values include active Fields only; archived Options remain
available for historical labels. Evidence scoping is applied in SQL by both
Project and Paper.

## PDF intake

An immutable project-owned staged PDF source artifact. It is not a Paper or a
FullTextDocument until explicit researcher resolution. Local metadata proposals
and their field-level provenance remain intake audit history; resolution creates
or selects the canonical Paper and records the exact FullTextDocument identity
and resolution in one SERIALIZABLE transaction. Byte materialization completes
afterward from the retained intake source; retry finishes that committed
resolution without recalculating the Paper decision. Both the intake source and
canonical document must be ready before they are usable.

## Crash-recoverable storage materialization

FullTextDocument and PDF intake writes commit a pending row and exact staged
recovery key before exclusive final-file installation. Final bytes are checked
against immutable size and SHA-256 before the row becomes ready. Reconciliation
retries known pending rows; audit reports missing or mismatched ready files,
orphan finals, and unowned staged files. Audit and reconciliation do not delete
unknown or mismatched artifacts. A stage file left after the ready commit is a
reported, benign orphan. See `docs/adr/0041-crash-recoverable-storage-materialization.md`.

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

The interactive workspace uses a cursor-paged preparation ledger and candidate
ledger, exact candidate provenance routes, and separate connecting-versus-direct
Evidence pages. Candidate membership means a finalized revision for the pinned
Field linked to at least one Evidence item in the exact pinned composition;
current screening, cleared-value, and curation facts annotate selectability and
warnings without removing reachable candidates or silently dropping drifted
selections. Candidate cursors pin the candidate-finalization time and the exact
preparation, composition, Field, order, and filter. Selection forms add or
remove one exact revision per request. The database validates the pinned
temporal composition chain; normal candidate and selection paths do not return
the full member set to application memory. Finalization remains proportional to
selected supports. See `docs/adr/0047-scalable-synthesis-preparation-workspace.md`.

AI request history is cursor-paged, with exact request audit detail on a nested
preparation route. Requests retain their frozen support and Evidence manifests
after later selection changes. The target-statement picker loads bounded
options only after explicit Browse/Search and can resolve the current target by
exact ID. Released full-workspace APIs remain available for compatibility.

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

## Bounded Research Question reads

The Research Question matrix pages by `(sort_order, id)` and computes each visible Question's traceability diagnostics from latest-link events. The per-question workspace and target ledgers preserve released reader semantics while limiting result rows and using set-based reads. `fullyCovered` reflects only extraction, Evidence Set, synthesis, and Claim diagnostics; Answer drift is a separate count and does not change that badge.

Picker and Answer-candidate membership is separate from current eligibility. Ineligible or archived targets remain browseable with state annotations; Answer candidates that cannot be selected remain visible with a reason. Exact target detail preserves its complete relationship history after unlink, while its current-link diagnostics are empty. Answer snapshots retain exact revision references, and later revision or link changes are shown as drift rather than rewriting the snapshot.

Traceability cursors bind their Project, Question, target type or Field where relevant, page size, filter, epoch, and sequence boundary. The Question epoch advances transactionally on every typed relationship event insert; an epoch change invalidates a traceability continuation with `CONCURRENT_MODIFICATION`, including after a lower-sequence event commits late. Answer history has no traceability epoch: a lower reserved Answer sequence may commit after page one and appear on continuation when it is at or below the captured Answer high-water. This late-commit behavior is specific to Answer history. Included-Paper coverage uses the latest Title Abstract `include` plus latest Full Text `include`, and fresh reads reflect later screening decisions and finalized Extraction revisions; retrieval state does not change the formula after a Full Text decision exists. See `docs/adr/0048-scalable-research-question-workspace.md`.

Measured SELECT budgets are matrix 6, workspace 11, inherited Project layout plus workspace route 12, link 2, exact target detail 2, coverage 1, picker 2, Answer candidates 2, Answer history 2, and exact Answer snapshot 3. Response targets are matrix 256 KiB; link and picker 128 KiB; coverage 256 KiB; Answer history 128 KiB; target history 1 MiB. Exact Answer snapshots return complete pinned context and are output-sized; their response size is measured separately.

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

## Module architecture boundaries

Slice 35 keeps the v0.34 public façades at `src/db/schema.ts`,
`src/application/repositories.ts`, `src/application/services.ts`, and
`src/app/actions.ts` while splitting their implementations by bounded context.
The compatibility contract is 113 schema exports with the released `schema`
key order, 22 repository classes, 67 core review-service methods, and 137
Server Actions. See `docs/architecture/module-boundaries.md` and
`docs/adr/0035-bounded-context-modularization.md` for the dependency direction,
service composition order, accepted `createProject` precedence, and compiler-API
architecture checks. This refactor preserves research behavior and does not
change the data model or migrations.

## Bounded read page

A project-scoped, stable SQL page with database-derived counts and queue
classification. Queue count and page reads share a read-only `REPEATABLE READ`
snapshot; page rows alone are mapped to full review status. The retrieval `all`
queue includes both currently title/abstract-included Papers and historical
retrieval conflicts.

## Paper collection page

The canonical `/projects/{projectId}/papers` workspace uses
`getPaperCollectionPage()` for a compact Project-scoped Paper page. Its row
contains Paper identity, title, authors, publication year, venue, DOI, creation
and update timestamps, and the latest title/abstract screening badge
(`sequence DESC, id DESC`). It does not load abstract, bibliographic note,
decision notes, or downstream review history. A bounded Paper CTE is selected
before one lateral latest-decision lookup per returned Paper.

The previous page path called `listPapers()` and `listScreeningPapers()` in
parallel, built a Paper-ID Map in Node, and rendered the whole Project. The
replacement removes those two unbounded materializations only from this page;
the services and repositories remain available to specialized legacy callers.

The Project-anchored count and bounded page share a read-only `REPEATABLE READ`
transaction. Existing Projects use two core SELECTs, including an empty
Project; a missing Project returns `null` after the count SELECT. Page order is
`created_at DESC, id DESC`. Invalid pages normalize to one and valid pages past
the end clamp to the last page. Invalid, non-positive, or non-safe-integer page
sizes default to 50; values above 100 clamp to 100. The UI always requests 50.

`listPapers()` and `listScreeningPapers()` remain available for compatibility
and specialized callers. Remaining interactive `listPapers()` scalability
debt is deduplication resolution, bibliographic-import correction, PDF-intake
matching, and protocol-run linking/relinking. Full-project BibTeX export is an
intentional unbounded export and remains unchanged. See
`docs/adr/0042-scalable-paper-collection-read-model.md` for query, benchmark,
caller, and migration evidence.

The PostgreSQL 16 benchmark returned 50 Paper rows at 1k, 10k, and 50k
Project sizes with two core SELECTs, compared with 2k, 20k, and 100k Paper
objects from the released dual-list path. At 50k, the bounded payload was
18,210 bytes versus 100,172,196 bytes for both legacy service results. The
first-page plan used `papers_project_created_at_idx`; latest-decision lookups
used `screening_decisions_project_paper_sequence_idx`. The exact Project count
scanned the Project's 50k Papers. The last page scanned and sorted all 50k
rows for offset 49,950, which is expected OFFSET work; the first-page tie sort
was incremental and did not spill. No essential missing index was shown, so
the Slice 44 release checkpoint ended at
`0033_storage_materialization_recovery`. Evidence Set scaling was carried into
the separately approved Slice 45 work below.

## Evidence Set composition and workspace

Slice 45 migrates Evidence Set runtime composition from full ordered snapshots
to immutable temporal singly linked versions in `0034_evidence_set_composition_timeline`.
Stable Set, membership, and revision UUIDs remain intact; the released global
revision `sequence` identity and displayed values are preserved, while a new
per-Set `set_ordinal` governs temporal validity, latest-revision selection, and
history paging. Existing synthesis pins still identify exact revision UUIDs.

Ordinary add, remove, re-add, and one-step move update a bounded link
neighborhood and per-Paper counter under the Set lock. Their tuple-change targets
are 6, 5, 5, and 7 respectively. Database transition guards validate the exact
predecessor and changed neighborhood without enumerating the active Set; only
the retained full reorder compatibility operation is O(N). Current members,
candidate search, composition history, and exact historical members use bounded
revision-bound cursor pages. The retained Node 22.13.0/PostgreSQL 16.15
benchmark measured those tuple deltas at 1k, 10k, and 50k. It also measured
top-level SELECT counts of 5/6/5/5 and 10/10/9/12 statements in add/remove/
re-add/move order. These meet the plan's add/remove limit of six SELECTs and
move limit of five; tuple and query counts stayed constant across all three
member sizes.

Exact pinned reads preserve the exact revision UUID and never rewrite a
composition. The final resolver bounds its recursive walk by the pinned
revision's `member_count` and does not build a growing path array. It returned
50,000 exact members/8,688,895 bytes in one statement at 50k; the service read
took about 910 ms and its EXPLAIN completed at about 601 ms. Candidate pages
return 20 results plus the continuation row with an 80-code-point excerpt. The
benchmark verifies the exact 20 deep-page Evidence IDs within the seeded
equal-timestamp group at all three sizes; the 50k candidate plan still scans
Evidence and Paper rows and spills sort data.

The migration backfills every legacy revision and proves exact ordered-member
equivalence before retiring the snapshot source. The benchmark harness exercises
1k/10k/50k member Sets and 10/100/1k revision histories; retained SQL counts,
tuple deltas, payload measurements, and final-shape EXPLAIN plans are in
[`docs/benchmarks/slice45-evidence-set-composition.json`](docs/benchmarks/slice45-evidence-set-composition.json).
See [ADR 0045](docs/adr/0045-scalable-evidence-set-composition-and-workspace.md)
for schema, compatibility, boundedness, and benchmark decisions.

## Claim ledger page

A Project-scoped page of compact current ClaimRevision summaries. Current
revision selection and exact support, citation-candidate, and structural Paper
counts are computed in SQL. Citation and structural Paper paths remain separate;
the workspace citation total sums each current Claim's distinct Paper count, so
one Paper supporting multiple Claims contributes once for each Claim. State
counts and the page share a read-only `REPEATABLE READ` snapshot.

## Claim history summary

A compact immutable summary of one finalized ClaimRevision. Typed support status
and citation/structural Paper counts use the exact support snapshot for that
revision and do not change when current Evidence review, Paper screening, or
support-target freshness later changes. Claim detail keeps full provenance for
the current revision and, when withdrawn, the latest prior active revision used
for explicit reactivation context; remaining history stays compact.

## Claim support search page

A compact, kind-specific page for eligible Evidence, ExtractionRevisions, or
SynthesisRevisions. Search and pagination do not determine which support IDs
remain selected in the Claim form. Canonical Claim writes continue to recheck
eligibility.

## Synthesis evidence path count

For an exact SynthesisRevision, the count of ExtractionRevision-to-Evidence
links reachable through its support rows. Each supporting ExtractionRevision
contributes its links, including when multiple support paths reach the same
Evidence identity.

## Evidence workspace page

A filtered page of immutable Evidence and current curation context. The filtered
count, ordered Evidence page, current Labels, and historical downstream usage
share one read-only `REPEATABLE READ` snapshot. Current Label state uses the
latest event per Evidence × Label pair. Historical usage keeps the five
released reachability paths regardless of later review, screening, Claim, or
revision state.

## Canonical Paper selection

The shared Project-scoped Paper option read model returns only `id`, `title`,
`authors`, `publicationYear`, and `doi`. Literal case-insensitive title search
uses 20 rows by default, clamps at 50, limits query input to 200 Unicode code
points, and returns exact counts from a read-only `REPEATABLE READ` count/page
pair. Ordering is `created_at DESC, id DESC`. Search can exclude one optional
Paper ID. Exact lookup is one Project-scoped SELECT.

Batch lookup uses one set-based SQL SELECT with requested-ID ordinality. SQL
deduplicates UUIDs by first occurrence, preserves that order, and returns an
explicit null option for unavailable or foreign-Project IDs. It has no fixed
ID-count cap or per-Paper queries.

`PaperPicker` keeps its exact selected Paper independent from search results.
It starts with no Paper search results and loads a page only after the user
chooses Browse Papers or submits a nonempty search; focus does not load data.
Required selection is caller-controlled and defaults to optional. The Evidence
workspace delegates its existing search and exact-lookup APIs to this service;
queue `paperId` and capture `capturePaperId` remain independent state.

## Canonical Paper selector boundaries

Deduplication, PDF matching, Protocol linking/relinking, and resolved
Bibliographic-import correction use bounded Project-wide Paper selection.
Import candidate matching for an ordinary unresolved record remains restricted
to the computed candidate list. Project-wide retargeting is available only for
the explicitly cleared state. Search controls do not change writer validation,
Paper identity, or append-only resolution/history semantics.

## Title/abstract screening queue

The screening dashboard uses a Project-scoped page of compact Paper identity
and current title/abstract state. Counts and the selected page share one
read-only REPEATABLE READ snapshot. Queue order remains created_at ascending,
then Paper UUID ascending. The queue defaults to 50 rows and clamps at 100.
Start screening independently targets the first unscreened Paper, falling back
to the first Paper in queue order.

Detail navigation resolves one Paper's one-based position and immediate
neighbors in one Project-scoped SELECT across all Project Papers, regardless
of screening state. The compatibility full-list screening service remains
available; extraction progress still uses its current-state dependency.
Decision history and the complete per-Paper detail remain unchanged.

## Synthesis comparison page

A bounded page for one active Extraction Field, with Project-wide extraction
state counts and exact current ExtractionRevision IDs. Field and Paper order
remain stable. Evidence links are represented by counts; Evidence provenance
stays in exact-revision detail views.

## Synthesis ledger page

A compact page of finalized current Synthesis revisions and exact support
counts. Page rows and Project-wide support state counts share one read-only
`REPEATABLE READ` snapshot. Statements without a finalized revision remain
absent, matching the released ledger.

## Synthesis history summary

A compact summary of each finalized SynthesisRevision and its complete exact
ExtractionRevision support snapshots in released support order. It does not
hydrate Evidence provenance. The current revision retains its full-provenance
detail view.

## Synthesis support selection

The selected set contains exact `ExtractionRevisionId` values and persists
across matrix pages and searches. Visible labels are display context only;
the canonical Synthesis writer validates submitted IDs.

## Synthesis revision edit context

Targeted eligibility facts for exact historical supports and their Paper/Field
replacement candidates. Carry-forward follows canonical final Paper inclusion
and exact finalized, non-cleared support state. Archived Fields preserve exact
historical support but offer no current replacement.

## Slice 49 Deduplication queue

The normal Deduplication queue reads live rank-separated keyset pages. It
probes bounded per-left/per-signal pair identities, excludes adjudicated pairs
before local limits, removes strong overlap from possible candidates, and
deduplicates signals before the global rank/page boundary. Only visible pairs
receive compact record hydration and latest-current mapping projection.
Strong-to-possible continuation exhausts strong pairs first; the possible
branch restarts from its beginning when reached from a strong cursor. A
possible cursor skips strong. Each request uses its own read-only
`REPEATABLE READ` snapshot; no epoch or high-water mark is stored in the
cursor. Dense candidate generation remains output-sensitive and may be
quadratic inside PostgreSQL.

Compatibility full-return candidate/history APIs remain available. Exact pair
inspection still accepts any distinct same-Project records, even outside the
candidate set or after adjudication. Decision history is page-bounded, reads
BIGINT sequence as canonical decimal text, and keeps complete notes behind an
exact Project/pair/decision event read. Review Flow keeps its intentional exact
unresolved count and shares the candidate predicates.

The released comparison and history indexes are reused. Slice 49 adds no
migration: `0038` is absent. Benchmark evidence is retained in
`docs/benchmarks/slice49-deduplication-read-paths.json`; its provenance uses
the released baseline SHA and marks implementation SHA as null for the
uncommitted tree.

**Scalability work is not complete after Slice 49.** Remaining ranked debt:
Review Report contributors; workflow histories; imports/intakes;
manuscript/document histories; Protocol/report context; and configuration
lists. Do not treat the Slice 49 queue as a scalability closeout for those
read paths or start Slice 50 without separate authorization.
