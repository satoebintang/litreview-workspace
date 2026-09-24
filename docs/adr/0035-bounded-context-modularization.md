# ADR 0035: Bounded-context application modularization

Status: Accepted for Slice 35 implementation

## Context

The v0.34 application already has distinct schema, repository, service, and
Server Action responsibilities, but several large source files combine those
responsibilities. Slice 35 makes those boundaries visible as modules without
changing the underlying research workflows or data model.

The compatibility baseline is 113 schema runtime exports (112 tables plus
`schema`), 22 repository classes, 67 core review-service methods, and 137
Server Actions. Service decomposition carries receiver risk because 17 existing
core methods call sibling methods through `this`. Service composition also has
one intentional duplicate: `acquisitionServices.createProject` wins over the
core `createProject` method.

## Decisions

### Keep public façades stable

`src/db/schema.ts`, `src/application/repositories.ts`,
`src/application/services.ts`, and `src/app/actions.ts` remain the public import
paths. Schema exports and the `schema` object key order, repository classes,
service methods, and action signatures are checked against the frozen v0.34
manifest.

### Split schema and repositories by context

Schema table definitions move into `src/db/schema/` and repository classes move
into `src/application/repositories/`. The schema façade explicitly builds its
canonical object in released table order. Schema contexts do not import the
root façade, and their dependency graph must remain acyclic.

### Split core review services without changing method bodies

The six core factories move into `src/application/review-services/` in the
fixture order: Project/Paper, Evidence, Screening, Extraction, Synthesis, and
Claim. Their method bodies, SQL, helper calls, and `this.*` receiver semantics
remain mechanically unchanged. Regression coverage exercises the distinct
receiver dependency chains through the composed service object.

`src/application/services.ts` remains composition and wiring. It preserves the
exact base and final `Object.assign` orders and the existing lazy interpretation
callback. The only accepted collision is `createProject`, where
`acquisitionServices` retains precedence over the core factory. The architecture
test asserts the factory key sets, method signatures, ordered composition, and
collision winner.

### Keep Server Actions behind one server façade

Sixteen context modules under `src/app/actions/` retain the `'use server'`
directive and export async runtime functions only. `src/app/action-helpers.ts`
holds helpers shared by those modules and has no server directive.

`src/app/actions.ts` also retains `'use server'` and exposes the 137 actions as
explicit async forwarding functions. Each wrapper forwards the same named
positional arguments and preserves the frozen TypeScript signature. The
compiler-based contract check verifies wrapper-to-implementation type equality
and direct argument forwarding; the production build and ManualPaper E2E smoke
verify the client action flow. The public Server Action compatibility façade
uses async forwarding functions rather than ES module re-exports because Next.js
15.5.26 does not reliably accept/register the desired re-export façade shape.

### Enforce boundaries with the TypeScript compiler API

The architecture check resolves modules with the project `tsconfig.json` and
inspects import, export, type-only, alias, dynamic-import, and import-type
syntax. It checks context cycles, schema façade usage, upward dependencies,
Server Action module shape, and the frozen public API and composition manifests.

## Consequences

Existing consumers retain their import paths while implementation files become
bounded by responsibility. The root service module becomes composition and
wiring only, and cross-context violations become test failures. The async
forwarding façade adds a small call boundary while preserving argument,
return, validation, scoping, revision, revalidation, redirect, and error
behavior.

No migrations, SQL redesign, route or UI changes, dependency or configuration
changes, or research-behavior changes are part of this decision. Deduplication
benchmarking and the complete release gate remain separate verification steps.

The inherited dependency audit is accepted as a non-blocking release exception:
`npm audit` exits nonzero with 7 moderate, 2 high, and 0 critical advisories.
Slice 35 dependency files are byte-identical to v0.34, the dependency graph did
not change, and Slice 35 introduced no advisories. Remediation belongs in a
deliberate dependency-maintenance slice.
