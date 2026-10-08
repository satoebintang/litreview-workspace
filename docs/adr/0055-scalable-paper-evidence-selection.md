# ADR 0055: Scalable Paper Evidence Selection for the Extraction Worksheet

**Status:** implemented and accepted for publication; unpublished

**Date:** 2026-10-07

**Baseline:** `v0.54.0-slice54`,
`971f3623b9176da7a08c00cf54015535d7f2f698`

**Migration:** none. Retain migration tail `0040`; do not create `0041`.

## Context

The normal Extraction worksheet previously loaded the complete Paper Evidence
candidate collection and repeated it in every active Field form. The worksheet
needs exact current support memberships, while candidate browsing needs only a
bounded page. These are separate cardinalities: the Paper candidate universe
is `N`; the selected support set is `S`.

## Decision

Keep the normal route at
`/projects/[projectId]/extraction/[paperId]`. It loads no candidate page and
renders no candidate controls before browsing. A single lazy Evidence browser
is shared by all active Fields. Candidate page size defaults to 20 and is
capped at 50; the service has no Field-specific candidate query or new search
filter.

Each Field keeps its own structured value, researcher-note draft, complete
selected Evidence ID set, bounded selected-support display metadata, and save
action state. A save submits the complete intended Evidence set once and
creates one immutable `ExtractionRevision` containing the value, note, and
support snapshot. Candidate page changes, Field switching, and browser
Back/Forward do not change that Field's state. Successful saves retain the
released full-page redirect; unsaved drafts in other Fields are not guaranteed
to survive it. No persisted multi-Field draft model is added.

### Candidate and selected-support projections

The candidate reader is `getPaperExtractionEvidenceCandidatePage(projectId,
paperId, { pageSize, after })`. It validates same-Project Paper ownership,
returns all curation states including rejected Evidence, and selects keys in
`created_at DESC, id ASC` order. Visible candidate content is hydrated only for
the page; the `pageSize + 1` sentinel is used only for `hasNext`. Source text
and note previews are clipped in SQL to 1,200 and 600 characters, with
truncation flags, provenance, current review warnings, and the exact Evidence
detail route.

The cursor is canonical versioned base64url data, at most 512 characters, and
is bound to Project, Paper, and effective page size. It preserves PostgreSQL
timestamp microseconds as text and continues with
`created_at < cursor_created_at OR (created_at = cursor_created_at AND id >
cursor_id)`. It never round-trips cursor identity through JavaScript `Date`.
The ID tie-breaker only makes candidate timestamp ties traversable; it does not
change greatest-sequence ExtractionRevision identity semantics or selected
support ordering.

Current support reads retain the exact complete current Evidence ID set and
Project/Paper provenance, page number, current review state/warning, bounded
display previews, truncation flags, and exact Evidence detail href. This
projection is proportional to selected membership cardinality `S`; it is not
described as candidate-page bounded. Exact Evidence, revision history, and
audit routes continue to provide their existing authoritative content.

Rejected candidates remain visible and cannot be added as new direct support.
`needs_review` and unreviewed candidates remain eligible with warnings. A
currently selected Evidence item that later becomes rejected stays selected in
the draft and is marked ineligible for carry-forward until the researcher
explicitly removes it. A writer rejection race retains the attempted draft and
refreshes support review metadata without deselection. Historical revisions
and links remain immutable.

### Form, action, and browser history behavior

Failed saves return a serializable, versioned form state containing the raw
attempted value/note, complete submitted Evidence ID set, safe error, refreshed
support-review metadata, and response identity. The active Field reconciles
each new failed response once. The existing parser behavior that omits
`researcherNote` for non-`present` states is preserved and characterized; this
slice does not correct that adjacent behavior.

Browse URL state records the active Field, cursor, and page size. Opening or
changing the browser updates history without remounting the worksheet;
`popstate` restores the active Field and bounded page while leaving scalar and
support drafts intact. Invalid browse state falls back to the first bounded
page. Candidate loads use request-generation checks so an older response cannot
replace the current page. Candidate-load errors do not
modify selection state.

**Transport deviation:** the approved
`getPaperExtractionEvidenceCandidatePageAction` Server Action remains exposed
and delegates to the shared candidate reader. The interactive browser uses a
no-store GET route that delegates to that same reader. This lets independently
issued candidate requests complete out of order for deterministic stale
response protection. Validation, cursor handling, SQL, and bounded DTO logic
are not duplicated between transports.

When JavaScript is disabled, current supports stay visible and removable, and
the complete remaining support set and structured value can still be saved.
Active-Field failed-save permalink recovery remains available. The page
discloses that browsing and adding additional Evidence requires JavaScript; it
does not restore an unbounded server-rendered candidate list.

### Compatibility and scope

`getPaperExtraction()`, support-only link/unlink commands, Field history,
exact revision readers, historical provenance, AI acceptance, inclusion
rules, option rules, and the immutable writer remain compatible. Ordinary
extraction saves do not add expected-current/CAS semantics. The work adds no
Evidence full-text search or filters, persisted extraction drafts, AI behavior
changes, or dependency. Candidate discoverability remains deferred.

## Query and migration decision

Use the existing Evidence and review indexes. Candidate pages execute a
Project/Paper scope query, a `pageSize + 1` key query, and a visible-ID
projection query for nonempty pages; empty pages omit hydration. Current
selected-support membership is read separately from the candidate universe.
The page-size limit bounds transferred keys, hydrated previews, and rendered
candidate controls. It does not promise universal O(pageSize) database work.
The existing timestamp index does not supply the mixed `created_at DESC,
id ASC` order; large timestamp tie groups and Paper distribution can still
drive extra traversal or sorting.

The final implemented-service benchmark below retains migration `0040` and
does not add a speculative index. No dependency or lockfile change is expected;
only the intentional benchmark script entry is added to `package.json`.

## Benchmark evidence

Recorded against the final service SQL using a disposable PostgreSQL 16
database. Candidate work and selected-support work are recorded separately.
The artifact includes service SQL and safe parameters, `EXPLAIN (ANALYZE,
BUFFERS, FORMAT JSON)` plans, driver row counts, JSON-byte estimates for
decoded rows, DTO sizes, setup/query accounting, and rendering bounds.

**Final results:** benchmarked on the verified `971f3623b9176da7a08c00cf54015535d7f2f698`
baseline with Node `22.13.0` and PostgreSQL `16.15`. The harness exercised
candidate universes of 0, 25, 1k, 10k, and 50k; 1/10/50 active Fields;
selected-support cardinalities of 0/5/250/2k; mixed, 90%-rejected, and
all-rejected curation; microsecond timestamps; a 5k-row timestamp tie group;
interleaved Papers; and large Unicode/control-character payloads.

- All candidate page structural gates passed. The 25-row profile at page size
  20 transferred 21 keys, hydrated/rendered 20, and returned a 182,616-byte
  candidate DTO. At page size 50, first pages across the 1k–50k profiles
  transferred at most 51 keys and hydrated/rendered 50. The largest measured
  candidate DTO was 455,608 bytes on a terminal page containing long previews,
  below the 1 MiB gate. The sentinel was never hydrated.
- The 1k static traversal matched the direct SQL oracle: zero duplicate IDs
  and zero omissions. First, middle, deep, terminal, partial-terminal,
  after-terminal, tie-group, and interleaved-Paper pages were recorded.
- With 1, 10, and 50 active Fields, the shared candidate page used the same
  three application SELECTs, transferred 51 keys, and hydrated 50 previews.
  A 50-Field worksheet over 50k candidates issued zero candidate-universe
  reads and projected its five selected supports separately (45,747 DTO
  bytes).
- The selected-support profiles measured 2, 45,707, 552,811, and 1,395,814
  DTO bytes for S=0/5/250/2,000 respectively. Exact membership held at every
  size; 1,950 of the 2,000 selected IDs were off the first candidate page, and
  a now-rejected selected support remained present with its refreshed state.
- The actual first-page key plan used the existing
  `evidence_project_paper_created_at_idx`. For a 50k unique-timestamp Paper,
  the index scan produced 52 rows for a 51-row page key result. In the 5k-row
  tie-group profile, the same plan scanned 5,001 rows to produce 51 keys.
  These results support bounded transfer and hydration, not a universal
  O(pageSize) PostgreSQL-work claim; tie-group traversal remains
  distribution-dependent.
- The harness captured final application SQL, safe parameters, plans,
  buffers, driver row counts, decoded-row bytes, DTO bytes, rendering counts,
  and setup/query accounting. It used existing indexes only, retained
  migration `0040`, changed no dependencies, and verified disposable database
  cleanup.

The durable results artifact is
[`docs/benchmarks/slice55-extraction-evidence-selection-read-paths.json`](../benchmarks/slice55-extraction-evidence-selection-read-paths.json).

## Known limitations

- Large tie groups and interleaved Paper distributions may require additional
  index/heap traversal or sorting despite bounded page transfer.
- Worksheet display and write work remains proportional to selected support
  membership `S`.
- Candidate pages are live reads across requests; they are not one persistent
  snapshot.
- Candidate search is deferred, and new Evidence selection requires
  JavaScript.
- A successful Field save redirects; other unsaved Field drafts are not
  guaranteed to survive that navigation.
- Existing note omission for non-`present` responses remains characterized
  behavior in this slice.
