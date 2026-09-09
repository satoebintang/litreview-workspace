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
