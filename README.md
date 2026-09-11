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

## Verification

```bash
npm run typecheck
npm run lint
npm test
npm run db:check
npm run build
npx playwright test
```

Slice 1 covers Project → Paper → Evidence → Claim → linked Evidence → provenance inspection. Claim support is derived from ClaimEvidence links; source text and researcher notes remain separate.
