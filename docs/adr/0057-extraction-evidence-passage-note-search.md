# ADR 0057: Extraction Evidence Passage and Note Search

- Status: Accepted for Slice 57.
- Date: 2026-10-10.
- Scope: explicit literal search in the Extraction worksheet's existing shared Evidence browser.

## Context

The worksheet already uses the scoped, keyset-paginated Evidence browser from
Slice 55. Researchers could browse pages and provenance filters, but could not
find Evidence by its complete passage or note. Search must retain immutable
Evidence identity and existing support eligibility while preserving the
worksheet's unsaved Field forms.

## Decision

Search is opt-in and submitted explicitly. The application trims surrounding
whitespace, preserves internal whitespace and punctuation, accepts at most 200
Unicode code points after trimming, rejects non-string input, decoded NUL, and
unpaired UTF-16 surrogate code units. A valid U+FFFD is accepted. URL decoding
is performed by the framework; malformed percent-encoded UTF-8 is validated as
the resulting decoded value, including U+FFFD where the framework normalizes it.
Matching is literal, case-insensitive substring matching against the complete
`evidence.source_text` or `evidence.note`; empty search omits the predicate.
The predicate runs in the scoped candidate-key query before ordering and
`LIMIT`, and only visible keys are hydrated into bounded previews.

The search term is carried in the `evidenceQuery` URL parameter. Cursor v2
binds Project, Paper, page size, and SHA-256 of the normalized query. Cursor v1
remains readable only for an empty query. Query validation failures are
reported separately from invalid pagination: a bad query never triggers
cursor repair; a bad cursor may recover once to the first page while retaining
the valid query. Stale request results cannot replace newer results.

## Contract amendment rationale

The original strict transport-validation requirement called for malformed
percent-encoded UTF-8 to be rejected before it could be treated as a valid
search or trigger invalid-cursor repair. Verification showed that Next.js / the
WHATWG URL parser decodes the request query before application validation. For
example, this runtime exposes `%ED%A0%80` as three U+FFFD code points, so the
application receives only the decoded string and cannot identify the original
malformed byte sequence.

The owner approved the decoded-query contract above: validate the value the
application actually receives, accept valid U+FFFD, and allow a valid decoded
query with an invalid cursor to recover once while retaining that query. This
is a local, single-user Evidence search; adding a raw-ingress hook, proxy, or
custom server to distinguish an encoding detail before framework parsing would
expand the deployment boundary for a search input without changing project or
paper scope, authorization, provenance, or researcher-controlled decisions.
No such ingress layer is part of this remediation. The residual ambiguity is
explicit: a malformed encoding normalized to U+FFFD is indistinguishable here
from a researcher intentionally searching for the same U+FFFD text, and both
are handled as the resulting decoded value.

## Acceptance matrix

| Decoded input or browse state | Required behavior | Evidence |
| --- | --- | --- |
| Non-string input, including repeated URL query parameters | Reject with `input: query` before cursor validation | Query normalizer and transport unit tests |
| Decoded NUL or an unpaired UTF-16 surrogate code unit | Reject with `input: query` | Query normalizer unit tests; NUL is also covered by read-service integration |
| Trimmed query of 200 Unicode code points, including astral characters | Accept; the limit is code points, not UTF-16 code units | Query normalizer unit test |
| Trimmed query longer than 200 Unicode code points | Reject with `input: query` | Query normalizer and worksheet E2E tests |
| Literal U+FFFD or malformed percent-encoded UTF-8 normalized by the framework | Accept the resulting decoded value; do not reject U+FFFD by itself | Query normalizer, transport unit, service integration, and worksheet E2E tests |
| Invalid query together with an invalid cursor | Show the query error and leave the cursor un-repaired | Read-service integration and worksheet E2E tests |
| Valid normalized query together with an invalid cursor | Repair once to the first page and retain the normalized query | Cursor unit and worksheet E2E tests |
| Cursor v1 with empty query; cursor v1 with non-empty query | Accept the former and reject the latter | Cursor unit tests |

No raw request-target validation, proxy, custom server, or middleware
normalization is part of this contract. Validation applies to the decoded value
available to the application after framework URL decoding.

Field forms retain stable React identity and draft/support state through
search, clear, page changes, Field switching, request failures, and
Back/Forward navigation. Selected support metadata remains independent of
candidate search. Successful-save redirects and writer behavior are unchanged.

No schema, index, migration, dependency, or verification-configuration change
was required. The existing read-only `REPEATABLE READ` transaction and
`SET LOCAL statement_timeout = '15000ms'` remain. This is not a universal
O(pageSize) database-work guarantee: selective or absent matches may scan the
Paper's Evidence population, and a sequential scan may cover other rows in the
Evidence relation before applying Project/Paper/search filters.

## Benchmark evidence

The disposable PostgreSQL 16.15 benchmark uses Node 22.13.0 and the final
application key SQL captured from the read service. It seeds 0, 25, 1,000,
10,000, and 50,000 candidate populations, plus two interleaved 1,000-row
Papers, for 63,025 Evidence rows. It records five unfiltered baselines, 25
search workloads (common, rare passage, rare note, long Unicode, and zero
result), six page-boundary profiles, and 33 `EXPLAIN (ANALYZE, BUFFERS, FORMAT
JSON)` plans. It checks the 20/50 page sizes, the 1 MiB candidate DTO ceiling,
long-text matches beyond both preview limits, selected support outside a rare
result, Project/Paper isolation across interleaved rows, and full 1,000-row
keyset traversal against a direct SQL oracle. The disposable database was
dropped and verified absent.

At 50,000 candidates, median/max application-service times were 235.74/240.91
ms for common matches, 379.22/426.42 ms for a rare passage, 322.60/360.66 ms
for a rare note, 332.39/333.65 ms for long Unicode, and 332.41/361.03 ms for
zero results. Every request observed the unchanged 15-second local timeout.
Rare and zero-result plans used a parallel sequential scan over approximately
the full 63,025-row Evidence relation, with 15,257 shared-hit blocks, zero
shared-read blocks, and zero temporary blocks; the common query used a top-N
sort and rare/zero queries used quicksort. Parallel plan counters are per-loop
averages, so the artifact retains both loops and approximate aggregate rows.
The largest measured DTO was 111,197 UTF-8 bytes for a 50-item page. These
measurements do not establish cold-cache or larger-than-50k performance. The
observed 50k workload did not demonstrate a need for a text index; timing is
diagnostic and no arbitrary latency target is introduced.

The complete SQL, parameters, plans, buffers, row counters, DTO sizes, timing,
fixtures, and cleanup record are in
[`docs/benchmarks/slice57-extraction-evidence-search-read-paths.json`](../benchmarks/slice57-extraction-evidence-search-read-paths.json).

## Verification and acceptance

Final focused verification passed with the pinned Node 22.13.0 / npm 10.9.2
runtime: query/transport/cursor unit tests (3 files, 15 tests), the search
read-service integration test (1 file, 3 tests), and the Slice 57 Chromium
browser spec (4 tests). The browser coverage includes malformed URL input and
its literal decoded-query equivalent, plus in-session invalid-cursor repair
that retains Field drafts, notes, selected support, and normalized query with
one first-page retry. `git diff --check` passed. Independent Luna/max review
reported no findings, and GPT-6.1 Sol/high accepted the implementation under
the owner-approved decoded-query contract.

The complete `npm run verify:full` acceptance run passed under Node 22.13.0 /
npm 10.9.2: fast tests (56 files, 356 tests), integration tests (82 files,
511 tests), typecheck, lint, schema check, standalone production build,
`audit:release`, E2E preflight, all 74 serial release E2E tests, and Playwright
diagnostics. An earlier attempt selected Node 26.4.0 and stopped at preflight
before test execution; it is not successful gate evidence. The accepted run's
production dependency audit was clean. The ordinary full audit reported only
the five authorized development-tooling exceptions, expiring 2027-01-06:
GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr, GHSA-vfj7-8cjw-p6xm,
GHSA-67mh-4wv8-2f99, and GHSA-82fw-gwwq-j7x9.
