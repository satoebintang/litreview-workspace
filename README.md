# Tracework

Tracework is a source-first workspace for building literature-review claims that remain auditable to their source passages.

## Local development

Requirements: Node.js >=22.13.0, Docker Desktop.

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
copy .env.example .env   # PowerShell: Copy-Item .env.example .env
npm run db:migrate
npm run dev
```

Open <http://localhost:3000>.

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

## Verification

Everyday local verification (with PostgreSQL 16 running):

```bash
npm run typecheck
npm run lint
npm test
npm run db:check
npm run build
npx playwright test --workers=1
```

Complete release verification:

```bash
npm run typecheck
npm run lint
npm run db:check
npm test
npm run test:integration
npm run build
npx playwright test --workers=1 --retries=0
git diff --check
```

Formal support and citation authority remain on exact ClaimRevision provenance
paths. Manuscript snapshots preserve historical presentation and composition;
they do not create support edges, alter Research Question Answers, or act as a
publication/release workflow.
