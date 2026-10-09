# ADR 0056: Verification Pipeline Efficiency and Failure Diagnostics

- Status: implemented locally; uncommitted pending independent acceptance.
- Date: 2026-10-09.
- Scope: Slice 56 verification commands and hosted CI only.

## Context

The published Slice 55 workflow used one serial job for typecheck, lint, schema check, all Vitest tests, a second integration-only Vitest invocation, standalone build, and production Playwright. Vitest's complete configuration included the integration directory, so the 82 integration files (510 tests in the Slice 55 inventory) ran twice in hosted CI. The complete suite had 134 files and 848 tests: 48 unit files / 307 tests, two architecture files / 17 tests, two root files / 14 tests, and 82 integration files / 510 tests.

The observed hosted Linux candidate and exact-merge runs took 17m12s and 19m05s. The repeated integration steps took 4m53s and 4m51s (about 4m52s). These are historical observations, not a guaranteed critical-path saving. No authorized hosted qualification run is part of Slice 56 implementation.

## Decision

Keep `npm test` as the backward-compatible complete Vitest command and create two authoritative disjoint partitions:

- Fast: `tests/unit/**/*.test.ts`, `tests/architecture/**/*.test.ts`, and `tests/*.test.ts`.
- Integration: `tests/integration/**/*.test.ts` through the existing disposable-database runner.

`vitest.fast.config.ts` does not load dotenv or resolve a database URL. Both new configurations keep `fileParallelism: false`. `test:partition-inventory` discovers every `tests/**/*.test.ts` file, asks Vitest to list each actual selection, and rejects omitted, overlapping, unclassified, empty, or misconfigured partitions. The two existing root-level test paths are explicit inventory requirements.

The Slice 55 baseline inventory was 134 files / 848 tests: fast 52 files / 338 tests and integration 82 files / 510 tests. The Slice 56 implementation inventory is 136 files / 854 tests: fast 54 files / 344 tests (unit 50 / 313, architecture 2 / 17, root 2 / 14) and integration 82 / 510. The new preflight and aggregator tests account for the increase; these are observed inventory results, not hardcoded permanent counts.

CI has independent `quality`, `integration`, and `e2e` jobs. Each has an isolated checkout/install; the database-backed jobs have separate PostgreSQL 16 services. Quality uses a nonblank but unreachable database URL only because Drizzle configuration requires a URL at load time. Local proof ran both `db:check` and the standalone production build with that URL and neither connected to PostgreSQL. Fast preflight/tests run with both database URL variables absent.

The final `verify` job has `if: always()` and waits for all three lanes. It succeeds only when the `quality`, `integration`, and `e2e` results are each exactly `success`; failure, skipped, cancelled, or missing results fail the check. The workflow remains named `CI`, retains the `verify` check context and existing PR/master/workflow-dispatch triggers, and does not change branch protection.

The E2E release command keeps `fullyParallel: false`, one worker, and zero retries. Failed tests retain traces and screenshots; videos remain off. On failure, CI uploads only `.zip` traces and `.png` screenshots for seven days. A separate JSONL file captures sanitized lifecycle phase, status, elapsed time, and exit status for database migration/schema validation, build, readiness, and cleanup. The Playwright launcher continues to own its migration and production build; quality keeps its independent standalone build.

## Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Backward-compatible complete Vitest suite through the disposable database wrapper |
| `npm run test:fast` | DB-free unit, architecture, and root tests |
| `npm run test:unit` | Unit tests and both root tests through the fast config |
| `npm run test:architecture` | Architecture tests through the fast config |
| `npm run test:integration` | One complete serial integration partition through the disposable database wrapper |
| `npm run test:partition-inventory` | Prove actual Vitest selections are exhaustive and disjoint |
| `npm run test:e2e -- <spec paths>` | Focused production-mode browser specifications |
| `npm run test:e2e:release` | Full production-mode browser suite, serially, with zero retries |
| `npm run verify:preflight -- --mode fast` | Runtime, npm, lockfile, installed direct dependency, and PDF.js checks; no database requirement |
| `npm run verify:preflight -- --mode integration` | Fast preflight plus PostgreSQL connectivity and disposable database create/drop |
| `npm run verify:preflight -- --mode e2e` | Integration preflight plus clean marker and writable temporary-storage checks |
| `npm run verify:diagnostics` | One isolated synthetic Playwright failure and trace/screenshot inspection |
| `npm run verify:full` | Complete disjoint local verification, static/schema/security checks, both production builds, E2E, and diagnostics |

`verify:full` deliberately does not run `npm test` after the disjoint partitions. Slice acceptance runs `npm test` once separately to verify compatibility; authoritative CI does not add it as a duplicate gate.

## Verification guidance and evidence

Use focused verification for implementation feedback and broaden according to known consumers. Pure modules start with related unit/root tests; services and repositories include related integration tests; route/UI work includes integration and E2E specs; shared helpers include all known consumers; schema, transactions, provenance, or security changes require complete relevant regressions and invariants. Unknown or incomplete impact requires broad verification. Codebase Memory can help discover impact but is not a CI dependency and cannot authorize skipped tests.

Retained evidence should identify the source state including uncommitted file bytes, selected commands/files, partition inventory, Node/npm, lockfile and cache/install conditions, OS, environment-variable presence, database/service version, start/end times, exit status, and cleanup. Evidence is invalidated by relevant source/test/config changes, runtime or install changes, changed environment/database contracts, platform changes, incomplete output, or failed cleanup. This is documented guidance; Slice 56 adds no result cache, evidence database, or automated dependency map.

## Performance qualification

Historical hosted Linux baseline:

| Measurement | Candidate | Exact merge |
| --- | ---: | ---: |
| Workflow wall time | 17m12s | 19m05s |
| Repeated integration step | 4m53s | 4m51s |
| Quality/build/test selection | Complete 134-file / 848-test suite | Same |

The engineering target is a hosted critical path of 15 minutes or less. New hosted lane times, queue/setup time, aggregate job time, cache conditions, critical path, and non-regression comparison remain pending an authorized candidate qualification. Do not report an unrun hosted workflow as passing or claim that removing a 4m52s duplicated step yields an equal wall-clock saving.

Slice 56 local measurements were collected on Windows with Node 22.13.0 and npm 10.9.2. The existing `node_modules` installation was reused; `npm ci` was not run. Playwright Chromium and the `postgres:16-alpine` image were already cached. Database-backed checks used a newly created disposable PostgreSQL 16 container with a tmpfs data directory; it was stopped and removed after verification. These measurements are separate from the historical hosted Linux measurements and do not qualify the hosted workflow.

| Local Windows measurement | Result | Conditions |
| --- | ---: | --- |
| `npm run test:fast` | 54 files / 344 tests; 110.40s Vitest | `DATABASE_URL` and `PLAYWRIGHT_ADMIN_DATABASE_URL` absent |
| `npm run test:integration` | 82 files / 510 tests; 808.43s Vitest | Fresh disposable PostgreSQL 16 service |
| Exact `npm test` compatibility command | 136 files / 854 tests; 861.23s Vitest, 866.97s shell | Same disposable service; `npm test` invoked without appended arguments |
| Standalone `npm run build` | 194.78s shell; Next compilation 24.0s | Nonblank unreachable loopback `DATABASE_URL`; no live DB |
| Playwright production startup | Migration/schema 3.77s; launcher-owned build 150.58s; readiness 5.42s | Full serial E2E acceptance run |
| `npm run test:e2e:release` | 70 tests passed in 10.5m | One Chromium worker, zero retries |
| `npm run verify:full` | 1,827.22s shell | Sequential local acceptance workflow; includes the above partitioned checks and release E2E |

Hosted `quality`, `integration`, and `e2e` lane durations, aggregate job time, critical-path duration, install/cache conditions, and comparison against the Slice 55 hosted baseline remain pending. They require an authorized candidate qualification stage. The local sequential `verify:full` duration is not a substitute for hosted parallel critical-path timing.

## Deferred work

This slice does not enable test-file parallelism, add E2E workers or sharding, share databases/storage/build outputs across jobs, remove either production build, add result caching or a dependency graph, update dependency versions, change application services, or add a migration. The production dependency audit must be clean. The full legacy npm audit may remain nonzero only under the existing exact five-GHSA development-tooling exception policy, which expires January 6, 2027; the ordinary full audit must not be described as clean. `audit:release` is an explicit hosted gate.

## Rollback

If a partition or aggregator regression appears, stop using the partitioned CI topology and restore the previous serial execution sequence under the unchanged `CI / verify` required context. Keep `npm test` as the compatibility fallback. Revert the diagnostic configuration and upload steps independently if needed. No dependency or schema rollback is required because Slice 56 changes neither dependencies nor migrations. Do not weaken failed-test handling, schema checks, or required release coverage to obtain a green check.
