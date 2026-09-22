# ADR 0032: Project workspace navigation and read-only overview

Status: Accepted for Slice 32 implementation

## Context

Project pages previously repeated application chrome, presented workflow stages
as if they were navigation, and placed Paper, Evidence, Claim, and other
domain actions on the project home. The root route created projects but could
not resume them. A project and its Research Questions are distinct objects,
and navigation must not create or mutate either one merely because a page was
visited.

## Decision

The root route remains project discovery and creation. Each project uses a
pathname-derived shell with these primary categories and canonical landing
routes:

| Category | Landing route |
| --- | --- |
| Overview | `/projects/{projectId}` |
| Plan | `/projects/{projectId}/protocol` |
| Papers | `/projects/{projectId}/papers` |
| Screen | `/projects/{projectId}/screening` |
| Extract | `/projects/{projectId}/extraction` |
| Synthesize | `/projects/{projectId}/synthesis` |
| Write | `/projects/{projectId}/manuscript` |
| Reports | `/projects/{projectId}/review-flow` |

Route matching is centralized and most-specific-first. Detail routes remain
contextual, including Answer manuscript routes under Write, Answer routes under
Synthesize, Research Question routes under Plan, and Paper document routes under
Extract. DOI, bibliographic import, and PDF intake routes remain under Papers.

The shell stores no workflow stage, last-opened timestamp, dashboard snapshot,
or navigation preference. It reads project identity only. Overview facts and
guidance are read models derived from current domain state, use bounded
set-based queries, and contain no mutation forms. Project discovery is
deterministically paginated at 24 projects per page, ordered by
`created_at DESC, id DESC`.

Paper acquisition gets a dedicated `/projects/{projectId}/papers` workspace.
Manual Papers, DOI lookup, bibliographic imports, PDF intake, and search
acquisition remain visibly distinct so intake provenance is not confused with
canonical Paper identity. Existing writers and provenance rules remain
unchanged.

Shared presentation primitives provide the shell, route-derived breadcrumbs,
page headers, status/alert/empty-state treatment, audit details, action groups,
and a narrow native-dialog destructive confirmation. `ConfirmAction` owns its
destructive form and therefore cannot create nested forms. It preserves hidden
immutable identifiers and expected revision fields, focuses Cancel first,
supports Escape, and restores focus to its trigger.

The default Manuscript query used by the Write landing page is read-only. If no
Manuscript exists, the page offers an explicit Start manuscript POST that calls
the existing canonical creation logic and redirects to the workspace.

## Consequences

- Navigation location is not workflow truth, and Overview recommendations are
  not researcher decisions.
- The shell can be shared by all project pages without duplicate landmarks or
  repeated top bars.
- Root discovery and Overview remain bounded and do not perform per-Paper
  loops.
- Browser journeys can verify active navigation, breadcrumbs, mobile focus,
  overflow, and read-only landing-page behavior without changing domain
  semantics.
- Deeper task redesign, persisted stage state, new migrations, and new
  provenance concepts remain out of scope.

## Verification expectations

Slice 32 must preserve released URLs and run the existing domain/release gates,
serial Playwright with zero retries, focused route/guidance/read-model tests,
and `git diff --check`. No migration `0031` is introduced.
