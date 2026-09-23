# Security model

## Supported deployment boundary

Tracework is a local application for one trusted researcher. The development
and production Next.js scripts bind to 127.0.0.1. The Compose PostgreSQL host
port is also bound to 127.0.0.1, and the Playwright production server uses the
same loopback address.

The application does not provide authentication, authorization between users,
collaboration, or remote access controls. Do not expose the web server or
database on a LAN, public interface, reverse proxy, or shared multiuser host.
Loopback binding limits network reach; it does not replace operating-system
account security.

PostgreSQL and document files are stored on the local machine. Configure
DATABASE_URL in the local environment file. Runtime database selection uses an
explicit createDb URL when it is nonblank; otherwise it uses a nonblank
DATABASE_URL and throws when neither is configured. Vitest requires
DATABASE_URL. Playwright selects a nonblank PLAYWRIGHT_ADMIN_DATABASE_URL
first, then a nonblank DATABASE_URL, and throws when both are absent. Blank or
whitespace-only settings count as missing. Runner output and lifecycle markers
must not contain raw database URLs.

## Research and provider boundaries

The application preserves the existing explicit researcher-controlled AI
actions. Provider requests remain governed by the existing disclosure and
acknowledgment flow; model output remains proposal state until the researcher
acts. Slice 34 does not add automatic provider calls or alter research
acceptance semantics.

Manual duplicate review is a POST action. Candidate review returns as bounded
serializable form action state on the clean Papers URL; only a successful add
redirects. The submitted title, authors, year, venue, DOI, abstract,
bibliographic note, and candidate list do not enter a URL. Server-side
candidate re-query and exact candidate-ID comparison remain authoritative.

Deduplication generates candidates from indexed project/source-record, DOI,
and title/year matching branches instead of a global all-pairs join. Its work
is output-sensitive: a dense comparison key can produce a genuinely large
number of candidate pairs. Benchmarks report both retrieved record count N
and actual candidate count M; the objective is indexed matching plus candidate
output, not a promise of linear behavior for dense keys.

## Storage integrity and recovery

Database transactions and filesystem changes cannot be made atomic together.
Storage operations stage and promote files around database writes. Ordinary
errors attempt compensating cleanup, but a host or process crash after file
promotion and before database commit can leave an orphan file. Storage audits
identify missing referenced files, unreferenced orphan files, and staged
temporary artifacts for repair.

The audit is a detection mechanism; it is not a background cleanup service or
a storage state machine.

## Runtime contract and scope

The runtime contract pins Node.js to exactly 22.13.0 and Next.js plus
eslint-config-next to exactly 15.5.26. The application and database are local
services.

This hardening slice adds no authentication, collaboration, remote or LAN
deployment, multiuser support, broad module splitting, general query redesign,
storage state machine, or new research feature.
