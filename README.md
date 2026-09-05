# Tracework

Tracework is a source-first workspace for building literature-review claims that remain auditable to their source passages.

## Local development

Requirements: Node.js 20+, Docker Desktop.

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
