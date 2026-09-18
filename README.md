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

## Verification

```bash
npm run typecheck
npm run lint
npm test
npm run db:check
npm run build
npx playwright test
```

Formal support and citation authority remain on exact ClaimRevision provenance
paths. Manuscript snapshots preserve historical presentation and composition;
they do not create support edges, alter Research Question Answers, or act as a
publication/release workflow.
