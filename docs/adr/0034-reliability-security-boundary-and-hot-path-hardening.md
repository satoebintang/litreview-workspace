# ADR 0034: Reliability, security boundary, and hot-path hardening

Status: Accepted for Slice 34 implementation

## Context

The released Slice 33 baseline is a local literature-review workspace for one
researcher. It needs narrow reliability and security hardening around database
configuration, local network exposure, duplicate candidate generation,
storage consistency, and action-state transport. The slice must preserve the
existing research data model and researcher-controlled workflow.

## Decisions

### Trusted local deployment

Development, production start, PostgreSQL Compose port publishing, and the
Playwright production server use loopback only. The application remains a
trusted local tool for one researcher, without authentication, LAN or remote
access, or multiuser collaboration. PostgreSQL and document files remain local.

### Fail-closed database configuration

createDb uses a nonblank explicit URL when provided. Otherwise it uses a
nonblank DATABASE_URL and throws synchronously when no URL is available.
Whitespace-only values count as missing. Vitest requires DATABASE_URL.
Playwright chooses a nonblank PLAYWRIGHT_ADMIN_DATABASE_URL before
DATABASE_URL and fails when neither is configured. There is no runner-specific
default URL. Runner output and lifecycle markers do not expose raw database
URLs.

### Indexed duplicate candidates

Candidate generation uses indexed matching branches for source record
identity, DOI, and title/year. It removes the global all-pairs join, while
remaining output-sensitive: N is the input record count and M is the number of
actual candidate pairs. Dense keys can still produce a large M. Benchmark
reports state N and M and measure indexed matching plus candidate output.

The retrieved-record DOI comparison index uses the exact released comparison
normalization. The source-record comparison index is scoped by project and
search source and excludes null or blank source identifiers. This is an index
hardening change only: no table or column additions, research-data backfill, or
provenance changes.

### Storage integrity

The existing local filesystem and PostgreSQL transaction boundary is not
atomic. Ordinary operation errors use compensating cleanup. A process or host
crash after a file is promoted but before the database transaction commits can
leave an orphan. Storage audit reports missing files, orphan files, and staged
artifacts. Slice 34 does not introduce a storage state machine or automatic
cleanup.

### Duplicate-review transport

Manual duplicate review remains an explicit POST action. Candidate review and
validation results return as bounded serializable action state on the clean
Papers URL; only a successful canonical add redirects. Draft metadata and
candidate details do not enter a URL. Any distinct-work acknowledgment is
cleared by draft edits and is valid only after server-side candidate review.
The server re-queries candidates under its existing lock and compares exact
candidate IDs before accepting the write.

### AI and dependency contract

Existing AI requests remain explicit researcher actions with their current
disclosure and proposal-acceptance boundaries. The two reasoning-effort form
boundaries accept only none, minimal, low, medium, high, and xhigh; omission
defaults to low, while invalid input uses the existing validation flow.

Node.js is pinned to 22.13.0. Next.js and eslint-config-next are pinned to
15.5.26. No provider, research semantics, or AI acceptance behavior changes.

## Deferred scope

Authentication, collaboration, remote or LAN deployment, multiuser support,
broad module splitting, general query redesign, a storage state machine, and
new research features require separate authorization and design.

## Consequences

The local boundary is explicit and the runtime fails early when database
configuration is absent. Indexed candidate generation avoids work on unrelated
record pairs while making dense-key output limits visible. Storage audit makes
cross-resource inconsistencies detectable without claiming atomic filesystem
and database commits. The released research model and explicit researcher
decisions remain the source of canonical state.
