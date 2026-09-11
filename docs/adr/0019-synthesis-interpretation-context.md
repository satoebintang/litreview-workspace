# ADR 0019: Synthesis interpretation context as descriptive layer

- Status: Accepted
- Date: 2026-09-11

## Context

Researchers interpreting synthesized evidence need a structured, versioned format to record analytical interpretations—including convergence state, overall summary, methodological limitations, open questions, and contradiction pairs between extracted observations. Slice 4 established immutable \SynthesisRevision\s and their formal support graph, and Slice 5 established stable Claims and ClaimRevisions grounded in synthesis revisions.

We must define the boundary between the descriptive interpretation layer authored on synthesized evidence and the formal analytical support graph.

## Decision

Introduce immutable, complete interpretation snapshots (\synthesis_interpretations\) and ordered relational children (\synthesis_interpretation_limitations\, \synthesis_interpretation_questions\, \synthesis_interpretation_contradictions\) scoped strictly to exact finalized \SynthesisRevision\s.

Interpretation is descriptive context, never formal support:

\SynthesisRevision → immutable interpretation snapshots → limitations/questions/contradiction pairs\

Formal grounding remains unchanged:

\ExtractionRevision → synthesis_revision_supports → SynthesisRevision → ClaimRevision\

Key architecture choices:
1. **Interpretation is descriptive context, never support:** No interpretation identifier, text, or relationship enters Claim persistence, citations, Preparation provenance, or ReviewFlow.
2. **Exact revision scoping:** Interpretations target an exact \(project_id, synthesis_statement_id, synthesis_revision_id)\. Active or withdrawn finalized revisions may be interpreted. No interpretation is inherited across statement revisions.
3. **Draft-then-finalize immutable snapshot construction:** Snapshots are constructed atomically via \lock exact SynthesisRevision → insert draft snapshot → insert complete children → finalize → deferred validation → commit\. Finalized snapshots and their children are strictly immutable and cannot be deleted or updated.
4. **Cardinality limits as operational safety only:** Array ceilings (100 limitations, 100 questions, 500 contradiction pairs) are enforced via Zod validation before opening a transaction and deferred PostgreSQL constraints as operational defense-in-depth, without treating them as analytical semantics.
5. **Contradiction composite-FK design:** Contradiction pairs include \synthesis_revision_id\ as an enforcement key. Left and right members reference the composite primary key of \synthesis_revision_supports(project_id, synthesis_revision_id, extraction_revision_id)\, guaranteeing that both members are exact supports of that revision. UUID canonical ordering (\left < right\) prevents self-pairs and unordered duplicate pairs.
6. **Reliance on finalized synthesis-support immutability:** Because finalized \synthesis_revision_supports\ cannot be mutated or deleted, no locks on ExtractionRevisions, Papers, Evidence, Statements, Preparations, or EvidenceSets are needed beyond locking the exact \SynthesisRevision\.
7. **Claim persistence boundary:** When drafting a Claim from an interpretation, the interpretation ID provides transient drafting context (and prefill from its summary), but all interpretation context is stripped before persistence. Claims persist only the exact \SynthesisRevision\ support.

## Consequences

- The formal support graph remains pure: claims, citations, manuscripts, and reports depend solely on exact ExtractionRevisions and SynthesisRevisions.
- Researchers can record rich, structured qualitative assessments of synthesis findings over time.
- All four convergence states (\convergent\, \mixed\, \contradictory\, \inconclusive\) reflect explicit researcher judgment, not automated inference.
- Migrations 0000–0018 remain untouched; Slice 19 is strictly additive.
