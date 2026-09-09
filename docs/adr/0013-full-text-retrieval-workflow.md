# ADR 0013: Full-text retrieval as an auditable workflow stage

- Status: Accepted
- Date: 2026-09-09

## Context

Slice 12 allowed full-text decisions but did not record how full text was obtained. Slice 13 needs an auditable retrieval history while preserving historical full-text decisions and the existing final-inclusion and analytical-eligibility rules.

## Decision

Add an append-only `full_text_retrieval_attempts` relation keyed to the canonical project Paper. Each attempt records an outcome, optional method/source/note, an investigator-supplied attempt time, and a database identity sequence.

Operational retrieval state is selected by the greatest sequence, never by `attemptedAt`. Historical `everRetrieved` is independently derived from the existence of any `retrieved` attempt. New attempts require current title/abstract inclusion. New full-text decisions require current title/abstract inclusion and current retrieval state `retrieved`. Database triggers enforce these gates and append-only behavior; the service layer performs the same checks for user-facing errors.

Legacy full-text decisions are not backfilled with synthetic attempts. They remain readable and continue to participate in the existing title/abstract plus full-text final-inclusion formula, with a warning that no retrieval record exists.

Review Flow exposes current queue metrics among currently title/abstract-included Papers. Review Report separately exposes historical ever-sought/ever-retrieved facts and marks Paper-level PRISMA mappings as partial; current unavailable is not presented as proof that a Paper was never retrieved.

## Consequences

- Retrieval and eligibility histories are distinct and independently auditable.
- No document storage, downloader, parser, or viewer is introduced.
- Existing migrations remain immutable; Slice 13 is additive and has explicit clean, upgrade, and rollback verification.
- Current retrieval state can change without rewriting historical support or changing final inclusion for an already-recorded full-text decision.
