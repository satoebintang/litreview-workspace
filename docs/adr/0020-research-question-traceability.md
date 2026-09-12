# ADR 0020: Research Question Traceability as Non-Provenance Planning Stream

- Status: Accepted
- Date: 2026-09-12

## Context

Literature reviews define research questions (RQs) early in the review protocol. As research proceeds through extraction, evidence curation, synthesis, and manuscript drafting, researchers must track which project artifacts operationalize and address each research question. 

However, formal provenance in Tracework is strictly defined:
- `ExtractionRevision` captures verbatim observations from included `Paper`s.
- `SynthesisRevision` synthesizes observations with explicit supports (`synthesis_revision_supports`).
- `ClaimRevision` asserts researcher conclusions with exact formal support from evidence, extractions, and syntheses.
- Manuscript sections place exact `ClaimRevision`s.
- Citations derive solely from the immutable support graph.

Research questions must not contaminate the formal support graph or alter citation, manuscript, review-flow, or PRISMA semantics. Furthermore, research questions, search strategies, and search runs are independently project-scoped; search strategies/runs represent project-wide protocol context rather than question-specific provenance.

## Decision

Introduce typed, append-only event streams connecting ResearchQuestions to Extraction Fields, Evidence Sets, Synthesis Statements, and Claims, while keeping traceability strictly separated from formal provenance.

Key architectural choices:

1. **Planning stream, not formal provenance:** No research question identifier enters any analytical support table (`claim_revisions`, `synthesis_revisions`, `manuscript_sections`, citations, etc.). Traceability mutations leave every formal support table byte-for-byte unchanged.
2. **Four typed event tables with composite ownership:**
   - `research_question_extraction_field_events`
   - `research_question_evidence_set_events`
   - `research_question_synthesis_statement_events`
   - `research_question_claim_events`
   Composite foreign keys `(project_id, research_question_id)` and `(project_id, target_id)` enforce same-project ownership with deletion restricted.
3. **Append-only transition enforcement:**
   - Updates and deletes are rejected at the database level.
   - Each event row stores an action (`linked | unlinked`) and optional trimmed note (max 2,000 characters).
   - A database trigger locks the `research_questions` row `FOR UPDATE` (the serialization boundary), rejects archived questions, inspects the pair's latest event sequence, and enforces transition validity:
     - First event must be `linked`.
     - `linked -> linked` and `unlinked -> unlinked` fail.
     - `linked -> unlinked` and `unlinked -> linked` succeed.
   - Archived/withdrawn targets remain linkable; their lifecycle status is preserved and displayed rather than invalidating history.
4. **Authoritative shared current-link reducer:**
   - A single reducer selects the greatest-sequence event for each `(project, question, typed target)` and retains only rows where action is `linked`.
   - Mutation and read services consume this same reducer.
5. **Factual coverage projection with canonical parity:**
   - Coverage across the six dimensions (Extraction, Evidence Sets, Synthesis, Interpretation, Claims, Manuscript Placement) is derived dynamically on read.
   - Parity with existing canonical resolvers is strictly maintained:
     - Extraction: greatest finalized sequence per stable value slot.
     - Evidence Sets: latest composition revision and latest review decisions.
     - Synthesis: greatest finalized sequence; only `active` is active.
     - Interpretation: greatest finalized snapshot for the exact active synthesis revision.
     - Claims: greatest finalized sequence; only `active` is active.
     - Placement: exact active revision placed in active section item in active section.
   - No cached coverage columns, scalar scores, stages, or percentages are stored.
   - Flag derivation follows strict dependency rules (e.g. missing support/interpretation flags are suppressed if no active revision exists).
6. **Project-wide protocol context:** SearchStrategy and SearchRun counts are labeled explicitly as project-wide and never attributed to an individual ResearchQuestion.

## Consequences

- Researchers can link and unlink review artifacts to research questions with full audit history and optional rationales.
- The formal scientific provenance and citation graph remains pure and unmodified.
- Protocol search context remains project-wide.
- Migrations 0000–0019 remain untouched; Slice 20 is strictly additive.
