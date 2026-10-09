# Tracework

Tracework is a source-first workspace for building literature-review claims that remain auditable to their source passages.

This release is designed for one trusted researcher on a local machine. It has no authentication and is not intended for LAN, remote, or multiuser deployment. See docs/security-model.md for the supported boundary and storage limits.

## Local development

Requirements: Node.js 22.13.0, Docker Desktop.

PostgreSQL and document files are local. External AI requests occur only through
the existing explicit researcher-controlled actions. Remote exposure is
unsupported.

Slice 15 text extraction uses the exact `pdfjs-dist@6.3.289` server-only entry
(`pdfjs-dist/legacy/build/pdf.mjs`). Next externalizes that package at runtime;
deployments must retain its `cmaps/` and `standard_fonts/` directories. The
text-only path does not import or invoke canvas/DOM rendering dependencies. For
a production text-only install, use `npm ci --omit=optional`; this keeps the
externalized PDF.js package and its data directories without installing its
optional rendering packages.

```bash
npm install
docker compose up -d
cp .env.example .env
npm run db:migrate
npm run dev
```

PowerShell setup equivalent:

```powershell
Copy-Item .env.example .env
```

Open <http://127.0.0.1:3000>.

Tracework follows the review chain from protocol and search through screening,
retrieval, documents, Evidence and Extraction, Synthesis, Claims, Research
Question Answers, and the structured Manuscript workspace. Manuscript content
has a stable ProseBlock/ProseRevision history and append-only editorial review;
an explicit researcher action can also persist an immutable whole-manuscript
Snapshot with frozen citation presentation and canonical Markdown export.

Paper intake also supports offline BibTeX and RIS imports. Uploads retain their
original bytes and parsed records as immutable intake provenance; a researcher
must explicitly match an existing Paper, create a new canonical Paper, or leave
the record unresolved. Project Papers can be exported as deterministic neutral
BibTeX. Imported bibliographic records remain separate from SearchRun and
RetrievedRecord acquisition history.

Project intake also accepts PDFs as immutable staged source artifacts. Local
PDF.js metadata proposals remain separate from canonical Paper metadata until a
researcher explicitly creates or selects a Paper; only then are the exact bytes
materialized as an ordinary FullTextDocument.

## Workspace navigation

The root route is project discovery and creation. After entering a project,
Tracework uses a derived workspace shell with eight navigational categories:
Overview, Plan, Papers, Screen, Extract, Synthesize, Write, and Reports.
Navigation location is presentation only; it is not a persisted workflow stage
and does not change research provenance or canonical state. The Overview is a
read-only summary of current facts and recommendations, while each category
links to the existing domain workspaces. Paper intake methods remain visibly
separate so staged imports and PDFs are not mistaken for canonical Papers
before explicit researcher resolution.

Critical appraisal is available from the Extract workspace at
`/projects/{projectId}/appraisal`. It supports researcher-defined custom
frameworks, exact immutable framework-version snapshots, Paper-level appraisal
history, and same-Paper Evidence grounding. It assigns no numeric score, ships
no official instrument content, calls no AI, and never gates synthesis or any
downstream provenance.

## Verification

### Runtime preflight

Use the preflight before verification when changing runtimes, dependencies, database configuration, or E2E setup. It reports executable identities and environment-variable presence without printing database URLs or credentials.

```bash
npm run verify:preflight -- --mode fast
npm run verify:preflight -- --mode integration
npm run verify:preflight -- --mode e2e
```

`fast` does not require `DATABASE_URL` or PostgreSQL. `integration` checks PostgreSQL connectivity and disposable-database create/drop privileges. `e2e` performs those database checks, requires a clean Playwright marker, and verifies writable temporary storage. Node.js 22.13.0 is required. The CI distribution uses npm 10.9.2; local npm version differences are reported because the repository does not pin npm separately.

### Focused implementation feedback

Run the test selection closest to a change and broaden when ownership or dependency impact is uncertain:

| Change | Initial feedback | Broaden to |
| --- | --- | --- |
| Isolated pure module | Related unit tests or root tests | Known consumers and full verification if impact is unclear |
| Application service or repository | Related unit and integration tests | Related route/UI workflows |
| Route or UI workflow | Related integration and E2E specs | Shared helpers and all known consumers |
| Shared UI or helper | Tests for every known consumer | Full verification when the consumer set is uncertain |
| Schema, transaction, provenance, or security | Focused regression and invariant tests | Full relevant verification, schema check, and serial E2E |
| Unknown, deleted, or unmapped impact | Broad verification | Complete local verification |

Useful focused commands:

```bash
npm run test:unit
npm run test:architecture
npm run test:fast
npm run test:partition-inventory
npm run test:integration
npm run test:e2e -- tests/e2e/<spec-file>.spec.ts
```

`test:fast` covers unit tests, architecture tests, and root-level tests without resolving a database URL. `test:integration` owns one disposable database for the serial integration partition. `test:partition-inventory` lists both Vitest configurations and fails on overlap, omission, an unknown test path, configuration errors, or zero selected files. Keep file parallelism disabled until test isolation is proven.

### Complete local verification

```bash
npm run verify:full
```

`verify:full` checks the disjoint fast and integration partitions, typecheck, lint, Drizzle schema, standalone production build, `audit:release`, complete serial zero-retry production-mode E2E, and the synthetic diagnostics probe. It does not run the legacy complete Vitest command in addition to the disjoint partitions.

The backward-compatible `npm test` remains the full Vitest suite. Slice acceptance also runs it once separately to verify compatibility. `npm run test:e2e:release` is the complete production-mode browser suite; `npm run test:e2e -- <spec paths>` accepts focused specs.

To verify first-failure browser artifacts independently:

```bash
npm run verify:diagnostics
```

The probe uses only synthetic page content, runs once with zero retries, inspects a readable trace and failure screenshot, and removes its temporary output. Hosted CI uploads only failed-test `.zip` traces and `.png` screenshots, plus sanitized lifecycle diagnostics, with seven-day retention. Complete authoritative release tests remain mandatory; focused feedback never replaces them.

### Evidence reuse

Record the source state, selected command/files, partition inventory, Node/npm versions, lockfile and installation/cache condition, OS, required environment-variable presence, database/service version, start/end time, exit status, and cleanup result when retaining local verification evidence. Re-run the invalidated check when source/tests, configuration, dependency installation, runtime, database contract, required environment, or platform changes. CBM can help discover impact, but it is not required by CI and cannot authorize skipping tests. Slice 56 adds no cached-result system or automated dependency map.

Formal support and citation authority remain on exact ClaimRevision provenance paths. Manuscript snapshots preserve historical presentation and composition; they do not create support edges, alter Research Question Answers, or act as a publication/release workflow.
