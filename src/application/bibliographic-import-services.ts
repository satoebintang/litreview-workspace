import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { createPaperSchema, idSchema } from "@/domain/validation";
import { isPlausibleDoiForComparison, normalizeDoiForComparison, normalizeTitleForComparison } from "@/domain/search-normalization";
import { writePaper, type PaperWriteInput } from "./paper-writer";
import { serializeBibtex } from "@/domain/bibtex-export";

export type BibliographicFormat = "bibtex" | "ris";
export type BibliographicParseOutcome = "parsed" | "parsed_with_warnings" | "failed";
export type BibliographicFieldState = "absent" | "blank" | "invalid" | "present";

export type BibliographicMetadata = {
  title: string | null;
  authors: string[];
  publicationYear: number | null;
  venue: string | null;
  doi: string | null;
  url: string | null;
  abstract: string | null;
};

export type BibliographicParsedRecord = BibliographicMetadata & {
  sourceKey?: string | null;
  sourceType?: string | null;
  startByte: number;
  endByte: number;
  outcome?: BibliographicParseOutcome;
  fieldStates?: Partial<Record<keyof BibliographicMetadata, BibliographicFieldState>>;
  diagnostics?: string[];
};

export type BibliographicParser = {
  parserVersion: string;
  parse(bytes: Uint8Array, format: BibliographicFormat): BibliographicParsedRecord[];
  parseWithDiagnostics?: (bytes: Uint8Array, format: BibliographicFormat) => { records: BibliographicParsedRecord[]; diagnostics: string[]; fatal?: boolean };
};

export type BibliographicBulkSelection = {
  recordId: string;
  expectedResolutionId: string | null;
  fingerprint: string;
};

export type BibliographicBulkPreviewRecord = {
  recordId: string;
  ordinal: number;
  title: string | null;
  expectedResolutionId: string | null;
  fingerprint: string;
  eligible: boolean;
  reason: string | null;
  candidateIds: string[];
  peerRecordIds: string[];
};

export type BibliographicImportServicesOptions = {
  parser: BibliographicParser;
  parserVersion?: string;
  adapterVersion?: string;
  mappingVersion?: string;
  maxBytes?: number;
  maxRecords?: number;
};

type Row = Record<string, unknown>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 1_000;

function rows(value: unknown): Row[] { return value as Row[]; }
function id(value: string, label: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new DomainError("VALIDATION_ERROR", `${label} must be a UUID`, parsed.error.issues);
  return parsed.data;
}
function text(value: unknown): string | null { return value == null ? null : String(value); }
function pgTextArray(values: string[]): string {
  return `{${values.map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`).join(",")}}`;
}
function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") { try { return JSON.parse(value) as T; } catch { return fallback; } }
  return value as T;
}
function mapMetadata(row: Row): BibliographicMetadata {
  return {
    title: text(row.title),
    authors: Array.isArray(row.authors) ? row.authors.map(String) : json<string[]>(row.authors, []),
    publicationYear: row.publication_year == null ? null : Number(row.publication_year),
    venue: text(row.venue),
    doi: text(row.doi),
    url: text(row.url),
    abstract: text(row.abstract),
  };
}
function mapRecord(row: Row) {
  return {
    id: String(row.id),
    importId: String(row.import_id),
    projectId: String(row.project_id),
    ordinal: Number(row.ordinal),
    sourceKey: text(row.source_key),
    sourceType: text(row.source_type),
    startByte: Number(row.start_byte),
    endByte: Number(row.end_byte),
    outcome: String(row.parse_outcome) as BibliographicParseOutcome,
    fieldStates: json<Record<string, BibliographicFieldState>>(row.field_states, {}),
    diagnostics: json<string[]>(row.diagnostics, []),
    ...mapMetadata(row),
  };
}

function recordState(row: Row) {
  const state = String(row.event_type);
  return {
    id: String(row.id),
    importId: String(row.import_id),
    recordId: String(row.record_id),
    sequence: String(row.sequence),
    eventType: state,
    paperId: text(row.paper_id),
    note: text(row.note),
    creationPayload: json<PaperWriteInput | null>(row.creation_payload, null),
    candidate: row.candidate_paper_id == null ? null : {
      paperId: String(row.candidate_paper_id),
      rank: row.candidate_rank == null ? null : Number(row.candidate_rank),
      reason: text(row.candidate_reason),
      doi: text(row.candidate_doi),
      title: text(row.candidate_title),
      publicationYear: row.candidate_publication_year == null ? null : Number(row.candidate_publication_year),
      venue: text(row.candidate_venue),
    },
    candidateContext: json<unknown[] | null>(row.candidate_context, null),
    createdAt: row.created_at,
  };
}

function metadataInput(record: BibliographicMetadata | PaperWriteInput): PaperWriteInput {
  if (!record.title || !record.title.trim()) throw new DomainError("VALIDATION_ERROR", "A Paper title is required");
  return {
    title: record.title,
    authors: record.authors ?? [],
    publicationYear: record.publicationYear ?? null,
    venue: record.venue ?? null,
    doi: record.doi ?? null,
    abstract: record.abstract ?? null,
  };
}

function mergeCreationInput(base: PaperWriteInput, creation: Partial<PaperWriteInput> | undefined): PaperWriteInput {
  if (!creation) return base;
  const merged: PaperWriteInput = { ...base };
  if (creation.title?.trim()) merged.title = creation.title;
  if (creation.authors && creation.authors.length > 0) merged.authors = creation.authors;
  if (creation.publicationYear != null) merged.publicationYear = creation.publicationYear;
  if (creation.venue?.trim()) merged.venue = creation.venue;
  if (creation.doi?.trim()) merged.doi = creation.doi;
  if (creation.abstract?.trim()) merged.abstract = creation.abstract;
  if (creation.bibliographicNote?.trim()) merged.bibliographicNote = creation.bibliographicNote;
  return merged;
}

function canonicalPaperPayload(metadata: BibliographicMetadata): PaperWriteInput {
  const parsed = createPaperSchema.safeParse({
    title: metadata.title ?? "",
    authors: metadata.authors,
    publicationYear: metadata.publicationYear,
    venue: metadata.venue,
    doi: metadata.doi,
    abstract: metadata.abstract,
    bibliographicNote: null,
  });
  if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "The imported metadata cannot produce a valid canonical Paper payload", parsed.error.issues);
  return {
    title: parsed.data.title,
    authors: parsed.data.authors,
    publicationYear: parsed.data.publicationYear ?? null,
    venue: parsed.data.venue ?? null,
    doi: parsed.data.doi ?? null,
    abstract: parsed.data.abstract ?? null,
    bibliographicNote: null,
  };
}

function metadataPeerKeys(metadata: BibliographicMetadata): string[] {
  const keys: string[] = [];
  const doi = isPlausibleDoiForComparison(metadata.doi) ? normalizeDoiForComparison(metadata.doi) : null;
  if (doi) keys.push(`doi:${doi}`);
  const title = normalizeTitleForComparison(metadata.title);
  if (title) keys.push(`title:${title}`);
  return keys;
}

function metadataPeerRecordIds(metadata: BibliographicMetadata, peerGroups: Map<string, string[]>, recordId: string): string[] {
  const peerRecordIds = new Set<string>();
  for (const key of metadataPeerKeys(metadata)) {
    for (const peerRecordId of peerGroups.get(key) ?? []) {
      if (peerRecordId !== recordId) peerRecordIds.add(peerRecordId);
    }
  }
  return [...peerRecordIds].sort();
}

function fingerprintBulkRecord(input: {
  recordId: string;
  ordinal: number;
  outcome: BibliographicParseOutcome;
  expectedResolutionId: string | null;
  payload: PaperWriteInput | null;
  candidateIds: string[];
  peerRecordIds: string[];
}) {
  return createHash("sha256").update(JSON.stringify({
    recordId: input.recordId,
    ordinal: input.ordinal,
    outcome: input.outcome,
    expectedResolutionId: input.expectedResolutionId,
    payload: input.payload,
    candidateIds: [...input.candidateIds].sort(),
    peerRecordIds: [...input.peerRecordIds].sort(),
  }), "utf8").digest("hex");
}

export function createBibliographicImportServices(db: Database, options: BibliographicImportServicesOptions) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;

  async function projectExists(projectId: string, executor: Database | Tx = db) {
    const found = rows(await executor.execute(sql`select id from projects where id=${id(projectId, "Project")} limit 1`))[0];
    if (!found) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
  }

  async function currentResolution(executor: Database | Tx, projectId: string, recordId: string) {
    const found = rows(await executor.execute(sql`
      select r.* from bibliographic_import_resolutions r
      where r.project_id=${projectId} and r.record_id=${recordId}
      order by r.sequence desc, r.id desc limit 1
    `))[0];
    return found ? recordState(found) : null;
  }

  async function loadPaperCandidateRows(projectId: string, executor: Database | Tx = db) {
    return rows(await executor.execute(sql`
      select p.*,
        lower(trim(regexp_replace(regexp_replace(trim(p.doi), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i'))) as doi_comparison,
        lower(regexp_replace(trim(p.title), '[[:space:]]+', ' ', 'g')) as title_comparison
      from papers p
      where p.project_id=${projectId}
    `));
  }

  function candidateRowsForMetadata(paperRows: Row[], metadata: BibliographicMetadata | PaperWriteInput) {
    const doi = isPlausibleDoiForComparison(metadata.doi) ? normalizeDoiForComparison(metadata.doi) : null;
    const title = normalizeTitleForComparison(metadata.title);
    if (!doi && !title) return [];
    return paperRows
      .filter((row) => {
        const paperDoi = row.doi_comparison == null ? null : String(row.doi_comparison);
        const paperTitle = row.title_comparison == null ? null : String(row.title_comparison);
        return Boolean((doi && paperDoi === doi) || (title && paperTitle === title));
      })
      .map((row) => {
        const paperDoi = row.doi_comparison == null ? null : String(row.doi_comparison);
        const paperTitle = row.title_comparison == null ? null : String(row.title_comparison);
        const doiMatch = Boolean(doi && paperDoi === doi);
        const titleYearMatch = Boolean(title && metadata.publicationYear != null && paperTitle === title && row.publication_year === metadata.publicationYear);
        return {
          ...row,
          id: String(row.id),
          projectId: String(row.project_id),
          title: String(row.title),
          authors: json<string[]>(row.authors, []),
          publicationYear: row.publication_year == null ? null : Number(row.publication_year),
          venue: text(row.venue),
          doi: text(row.doi),
          abstract: text(row.abstract),
          candidateReason: doiMatch ? "doi" : titleYearMatch ? "title_year" : "title",
          candidatePriority: doiMatch ? 1 : titleYearMatch ? 2 : 3,
          createdAt: row.created_at,
        };
      })
      .sort((left, right) => left.candidatePriority - right.candidatePriority
        || String(left.createdAt).localeCompare(String(right.createdAt))
        || left.id.localeCompare(right.id));
  }

  async function candidates(projectId: string, metadata: BibliographicMetadata | PaperWriteInput, executor: Database | Tx = db, paperRows?: Row[]) {
    return candidateRowsForMetadata(paperRows ?? await loadPaperCandidateRows(projectId, executor), metadata);
  }

  async function getImport(projectId: string, importId: string) {
    await projectExists(projectId);
    const checkedImportId = id(importId, "Import");
    const found = rows(await db.execute(sql`select * from bibliographic_imports where project_id=${projectId} and id=${checkedImportId} limit 1`))[0];
    if (!found) throw new DomainError("NOT_FOUND", "Bibliographic import was not found");
    const records = rows(await db.execute(sql`select * from bibliographic_import_records where project_id=${projectId} and import_id=${checkedImportId} order by ordinal`)).map(mapRecord);
    const resolutionRows = rows(await db.execute(sql`select * from bibliographic_import_resolutions where project_id=${projectId} and import_id=${checkedImportId} order by record_id, sequence`));
    const current = new Map<string, ReturnType<typeof recordState>>();
    for (const row of resolutionRows) current.set(String(row.record_id), recordState(row));
    return {
      id: String(found.id), projectId: String(found.project_id), format: String(found.format) as BibliographicFormat,
      filename: String(found.filename), sourceByteSize: Number(found.source_byte_size ?? found.byte_size), sourceSha256: String(found.source_sha256 ?? found.sha256),
      parserVersion: String(found.parser_version), status: String(found.status), errorCode: text(found.error_code), errorMessage: text(found.error_message), diagnostics: json<string[]>(found.diagnostics, []),
      createdAt: found.created_at, finalizedAt: found.finalized_at ?? null, records,
      resolutions: resolutionRows.map(recordState), currentResolutions: current,
    };
  }

  async function getBulkImportPreview(projectId: string, importId: string, selectedRecordIds: string[] = []) {
    const imported = await getImport(projectId, importId);
    const selectedIds = [...new Set(selectedRecordIds.map((value) => id(value, "Bulk record")))];
    const knownIds = new Set(imported.records.map((record) => record.id));
    const unknownSelected = selectedIds.filter((recordId) => !knownIds.has(recordId));
    if (unknownSelected.length > 0) throw new DomainError("CROSS_PROJECT_REFERENCE", `Bulk selection contains a record outside import ${imported.id}`);
    const paperRows = await loadPaperCandidateRows(projectId);
    const peerGroups = new Map<string, string[]>();
    for (const record of imported.records) {
      for (const key of metadataPeerKeys(record)) peerGroups.set(key, [...(peerGroups.get(key) ?? []), record.id]);
    }
    const previewRecords: BibliographicBulkPreviewRecord[] = imported.records.map((record) => {
      const current = imported.currentResolutions.get(record.id) ?? null;
      const candidateRows = candidatesFromRecord(record, paperRows);
      const peerRecordIds = metadataPeerRecordIds(record, peerGroups, record.id);
      let payload: PaperWriteInput | null = null;
      let payloadError: string | null = null;
      try { payload = canonicalPaperPayload(record); }
      catch (error) { payloadError = error instanceof DomainError ? error.message : "The imported metadata cannot produce a valid canonical Paper payload"; }
      const reason = record.outcome === "failed"
        ? "Record parsing failed"
        : current?.paperId
          ? "Record already has a current Paper resolution"
          : payloadError
            ? payloadError
            : candidateRows.length > 0
              ? "A current canonical Paper candidate requires review"
              : peerRecordIds.length > 0
                ? `Duplicate imported peer record(s): ${peerRecordIds.map((recordId) => imported.records.find((item) => item.id === recordId)?.ordinal ?? recordId).join(", ")}`
                : null;
      const candidateIds = candidateRows.map((candidate) => String(candidate.id)).sort();
      const fingerprint = fingerprintBulkRecord({
        recordId: record.id,
        ordinal: record.ordinal,
        outcome: record.outcome,
        expectedResolutionId: current?.id ?? null,
        payload,
        candidateIds,
        peerRecordIds,
      });
      return {
        recordId: record.id,
        ordinal: record.ordinal,
        title: record.title,
        expectedResolutionId: current?.id ?? null,
        fingerprint,
        eligible: reason === null,
        reason,
        candidateIds,
        peerRecordIds,
      };
    });
    const selectedSet = new Set(selectedIds);
    const selected = previewRecords.filter((record) => selectedSet.has(record.recordId));
    return {
      importId: imported.id,
      maxRecords: 100,
      records: previewRecords,
      selected,
      selectedCount: selected.length,
      overLimit: selected.length > 100,
      canConfirm: selected.length > 0 && selected.length <= 100 && selected.every((record) => record.eligible),
      selection: selected.map(({ recordId, expectedResolutionId, fingerprint }) => ({ recordId, expectedResolutionId, fingerprint })),
    };
  }

  function candidatesFromRecord(record: BibliographicMetadata, paperRows: Row[]) {
    return candidateRowsForMetadata(paperRows, record);
  }

  const service = {
    async importFile(projectId: string, input: { format: BibliographicFormat; filename: string; bytes: Uint8Array }) {
      await projectExists(projectId);
      if (input.format !== "bibtex" && input.format !== "ris") throw new DomainError("VALIDATION_ERROR", "Bibliographic format must be BibTeX or RIS");
      if (!input.filename.trim() || input.filename.length > 500) throw new DomainError("VALIDATION_ERROR", "Bibliographic filename must be between 1 and 500 characters");
      if (input.bytes.byteLength === 0) throw new DomainError("VALIDATION_ERROR", "Bibliographic import cannot be empty");
      if (input.bytes.byteLength > maxBytes) throw new DomainError("VALIDATION_ERROR", `Bibliographic import exceeds ${maxBytes} bytes`);
      const hash = createHash("sha256").update(input.bytes).digest("hex");
      const prior = rows(await db.execute(sql`select id from bibliographic_imports where project_id=${projectId} and format=${input.format} and source_sha256=${hash} limit 1`))[0];
      if (prior) return getImport(projectId, String(prior.id));
      let parsed: BibliographicParsedRecord[] = [];
      let importDiagnostics: string[] = [];
      let parseFailure: { code: string; message: string } | null = null;
      try {
        const result = options.parser.parseWithDiagnostics?.(input.bytes, input.format);
        if (result) {
          parsed = result.records;
          importDiagnostics = result.diagnostics;
          if (result.fatal) parseFailure = { code: "invalid_source", message: "The uploaded source could not be decoded or parsed safely." };
        }
        else parsed = options.parser.parse(input.bytes, input.format);
      }
      catch (error) {
        parseFailure = { code: "parser_failure", message: `Bibliographic ${input.format} could not be parsed safely.` };
        importDiagnostics = [...importDiagnostics, `parser_failure: ${String(error)}`].slice(0, 100);
      }
      if (!parseFailure && parsed.length > maxRecords) throw new DomainError("VALIDATION_ERROR", `Bibliographic import exceeds ${maxRecords} records`);
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${projectId}:${input.format}:${hash}`}))`);
        const existing = rows(await tx.execute(sql`select id from bibliographic_imports where project_id=${projectId} and format=${input.format} and source_sha256=${hash} for update`))[0];
        if (existing) return String(existing.id);
        const importRows = rows(await tx.execute(sql`
          insert into bibliographic_imports (project_id, format, filename, source_bytes, source_byte_size, source_sha256, parser_version, adapter_version, mapping_version, status, expected_record_count, diagnostics, error_code, error_message, finalized_at)
          values (${projectId}, ${input.format}, ${input.filename}, ${Buffer.from(input.bytes)}, ${input.bytes.byteLength}, ${hash}, ${options.parserVersion ?? options.parser.parserVersion}, ${options.adapterVersion ?? "builtin"}, ${options.mappingVersion ?? "paper-v1"}, ${parseFailure ? "failed" : "complete"}, ${parseFailure ? 0 : parsed.length}, ${JSON.stringify(importDiagnostics)}::jsonb, ${parseFailure?.code ?? null}, ${parseFailure?.message ?? null}, ${parseFailure ? sql`now()` : null})
          returning id
        `));
        const importId = String(importRows[0]?.id ?? "");
        if (!importId) throw new DomainError("DATABASE_CONSTRAINT", "Bibliographic import could not be created");
        if (parseFailure) return importId;
        for (let index = 0; index < parsed.length; index += 1) {
          const record = parsed[index];
          if (!Number.isInteger(record.startByte) || !Number.isInteger(record.endByte) || record.startByte < 0 || record.endByte <= record.startByte || record.endByte > input.bytes.byteLength) throw new DomainError("VALIDATION_ERROR", `Bibliographic record ${index + 1} has an invalid byte span`);
          const outcome = record.outcome ?? (record.diagnostics?.length ? "parsed_with_warnings" : "parsed");
          await tx.execute(sql`
            insert into bibliographic_import_records (project_id, import_id, ordinal, source_key, source_type, start_byte, end_byte, parse_outcome, title, authors, publication_year, venue, doi, url, abstract, field_states, diagnostics, finalized_at)
            values (${projectId}, ${importId}, ${index + 1}, ${record.sourceKey ?? null}, ${record.sourceType ?? null}, ${record.startByte}, ${record.endByte}, ${outcome}, ${record.title}, ${pgTextArray(record.authors ?? [])}::text[], ${record.publicationYear ?? null}, ${record.venue ?? null}, ${record.doi ?? null}, ${record.url ?? null}, ${record.abstract ?? null}, ${JSON.stringify(record.fieldStates ?? {})}::jsonb, ${JSON.stringify(record.diagnostics ?? [])}::jsonb, ${outcome === "failed" ? null : sql`now()`})
          `);
        }
        await tx.execute(sql`update bibliographic_imports set status='finalized', finalized_at=now() where project_id=${projectId} and id=${importId}`);
        return importId;
      });
      return getImport(projectId, result);
    },

    getImport,
    getBulkImportPreview,
    async listImports(projectId: string) {
      await projectExists(projectId);
      const found = rows(await db.execute(sql`
        select i.*,
          (select count(*) from bibliographic_import_records r where r.project_id=i.project_id and r.import_id=i.id) as record_count,
          (select count(*) from bibliographic_import_resolutions r where r.project_id=i.project_id and r.import_id=i.id and r.paper_id is not null and r.sequence=(select max(r2.sequence) from bibliographic_import_resolutions r2 where r2.project_id=r.project_id and r2.record_id=r.record_id)) as resolved_count
        from bibliographic_imports i where i.project_id=${projectId} order by i.created_at desc, i.id desc
      `));
      return found.map((row) => ({ id: String(row.id), projectId: String(row.project_id), format: String(row.format) as BibliographicFormat, filename: String(row.filename), parserVersion: String(row.parser_version), status: String(row.status), sourceByteSize: Number(row.source_byte_size ?? row.byte_size), sourceSha256: String(row.source_sha256 ?? row.sha256), recordCount: Number(row.record_count ?? 0), resolvedCount: Number(row.resolved_count ?? 0), createdAt: row.created_at, diagnostics: json<string[]>(row.diagnostics, []) }));
    },

    async listImportRecords(projectId: string, importId: string, filter?: "unresolved" | "resolved" | "warnings" | "errors") {
      const found = await getImport(projectId, importId);
      return found.records.filter((record) => {
        const resolution = found.currentResolutions.get(record.id);
        if (filter === "resolved") return Boolean(resolution?.paperId);
        if (filter === "unresolved") return !resolution?.paperId;
        if (filter === "warnings") return record.diagnostics.length > 0 || record.outcome === "parsed_with_warnings";
        if (filter === "errors") return record.outcome === "failed";
        return true;
      }).map((record) => ({ ...record, currentResolution: found.currentResolutions.get(record.id) ?? null }));
    },

    async listRecordCandidates(projectId: string, importRecordId: string) {
      await projectExists(projectId);
      const row = rows(await db.execute(sql`select * from bibliographic_import_records where project_id=${projectId} and id=${id(importRecordId, "Import record")} limit 1`))[0];
      if (!row) throw new DomainError("CROSS_PROJECT_REFERENCE", "Bibliographic import record does not belong to this project");
      return candidates(projectId, mapMetadata(row));
    },

    async resolveImportRecord(input: { projectId: string; importRecordId: string; action: "created_paper" | "matched_paper" | "cleared"; paperId?: string | null; note?: string | null; expectedResolutionId?: string | null; creation?: Partial<PaperWriteInput>; distinctPaperAcknowledged?: boolean }) {
      const projectId = id(input.projectId, "Project");
      const recordId = id(input.importRecordId, "Import record");
      return db.transaction(async (tx) => {
        if (input.action === "created_paper") {
          const lockedProject = rows(await tx.execute(sql`select id from projects where id=${projectId} for update`))[0];
          if (!lockedProject) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
        }
        const record = rows(await tx.execute(sql`select * from bibliographic_import_records where project_id=${projectId} and id=${recordId} for update`))[0];
        if (!record) throw new DomainError("CROSS_PROJECT_REFERENCE", "Bibliographic import record does not belong to this project");
        if (String(record.parse_outcome) === "failed") throw new DomainError("VALIDATION_ERROR", "Failed bibliographic records cannot be resolved");
        const current = await currentResolution(tx, projectId, recordId);
        if ((input.expectedResolutionId ?? null) !== (current?.id ?? null)) throw new DomainError("CONCURRENT_MODIFICATION", "Bibliographic resolution changed; refresh before submitting");
        let paperId: string | null = null;
        let payload: PaperWriteInput | null = null;
        let candidateRows: Array<Record<string, unknown>> = [];
        let selectedCandidate: Record<string, unknown> | null = null;
        if (input.action === "matched_paper") {
          if (!input.paperId) throw new DomainError("VALIDATION_ERROR", "Matching a Paper requires a Paper id");
          const target = rows(await tx.execute(sql`select * from papers where project_id=${projectId} and id=${id(input.paperId, "Paper")} limit 1`))[0];
          if (!target) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
          paperId = String(target.id);
          candidateRows = await candidates(projectId, mapMetadata(record), tx);
          selectedCandidate = candidateRows.find((candidate) => String(candidate.id) === paperId) ?? null;
        } else if (input.action === "created_paper") {
          const metadata = mapMetadata(record);
          // Keep absent source metadata auditable while allowing the researcher
          // to supply a required canonical title during explicit resolution.
          payload = metadataInput(mergeCreationInput({
            title: metadata.title ?? "",
            authors: metadata.authors,
            publicationYear: metadata.publicationYear,
            venue: metadata.venue,
            doi: metadata.doi,
            abstract: metadata.abstract,
          }, input.creation));
          candidateRows = await candidates(projectId, { ...payload, authors: payload.authors ?? [] }, tx);
          if (candidateRows.length > 0 && !input.distinctPaperAcknowledged) throw new DomainError("DUPLICATE_REVIEW_REQUIRED", "Review candidate Papers before creating a distinct Paper");
          const paper = await writePaper(tx, projectId, payload, { source: "import" });
          paperId = String(paper.id);
        }
        const candidateContext = candidateRows.length > 0
          ? candidateRows.map((candidate, index) => ({
            paperId: String(candidate.id),
            rank: index + 1,
            reason: String(candidate.candidateReason ?? ""),
            doi: candidate.doi == null ? null : String(candidate.doi),
            title: String(candidate.title),
            publicationYear: candidate.publicationYear == null ? null : Number(candidate.publicationYear),
            venue: candidate.venue == null ? null : String(candidate.venue),
            selected: selectedCandidate != null && String(candidate.id) === String(selectedCandidate.id),
          }))
          : null;
        const inserted = rows(await tx.execute(sql`
          insert into bibliographic_import_resolutions (project_id, import_id, record_id, event_type, paper_id, expected_previous_resolution_id, note, creation_payload, candidate_paper_id, candidate_rank, candidate_reason, candidate_doi, candidate_title, candidate_publication_year, candidate_venue, candidate_context)
          values (${projectId}, ${record.import_id}, ${recordId}, ${input.action}, ${paperId}, ${current?.id ?? null}, ${input.note ?? null}, ${payload ? JSON.stringify(payload) : null}::jsonb, ${selectedCandidate ? String(selectedCandidate.id) : null}, ${selectedCandidate ? candidateRows.findIndex((candidate) => String(candidate.id) === String(selectedCandidate?.id)) + 1 : null}, ${selectedCandidate?.candidateReason ?? null}, ${selectedCandidate?.doi ?? null}, ${selectedCandidate?.title ?? null}, ${selectedCandidate?.publicationYear ?? null}, ${selectedCandidate?.venue ?? null}, ${candidateContext ? JSON.stringify(candidateContext) : null}::jsonb)
          returning *
        `))[0];
        return recordState(inserted);
      });
    },

    async bulkCreateImportRecords(input: { projectId: string; importId: string; selection: BibliographicBulkSelection[] }) {
      const projectId = id(input.projectId, "Project");
      const importId = id(input.importId, "Import");
      if (!Array.isArray(input.selection) || input.selection.length === 0) throw new DomainError("VALIDATION_ERROR", "Select at least one eligible import record");
      if (input.selection.length > 100) throw new DomainError("VALIDATION_ERROR", "Bulk creation is limited to 100 records");
      const selection = input.selection.map((item) => {
        if (!item || typeof item !== "object") throw new DomainError("VALIDATION_ERROR", "Bulk selection is invalid");
        const recordId = id(String(item.recordId), "Bulk record");
        if (typeof item.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(item.fingerprint)) throw new DomainError("VALIDATION_ERROR", `Bulk selection fingerprint is invalid for record ${recordId}`);
        const expectedResolutionId = item.expectedResolutionId == null || item.expectedResolutionId === "" ? null : id(String(item.expectedResolutionId), "Expected resolution");
        return { recordId, expectedResolutionId, fingerprint: item.fingerprint };
      }).sort((left, right) => left.recordId.localeCompare(right.recordId));
      if (new Set(selection.map((item) => item.recordId)).size !== selection.length) throw new DomainError("VALIDATION_ERROR", "Bulk selection contains duplicate records");

      return db.transaction(async (tx) => {
        const lockedProject = rows(await tx.execute(sql`select id from projects where id=${projectId} for update`))[0];
        if (!lockedProject) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
        const imported = rows(await tx.execute(sql`select * from bibliographic_imports where project_id=${projectId} and id=${importId} for update`))[0];
        if (!imported) throw new DomainError("CROSS_PROJECT_REFERENCE", "Bibliographic import does not belong to this project");
        if (imported.finalized_at == null || String(imported.status) !== "finalized") throw new DomainError("VALIDATION_ERROR", "Only finalized bibliographic imports can be bulk-resolved");

        const recordIds = selection.map((item) => item.recordId);
        const lockedRows = rows(await tx.execute(sql`
          select * from bibliographic_import_records
          where project_id=${projectId} and import_id=${importId}
            and id in (${sql.join(recordIds.map((recordId) => sql`${recordId}::uuid`), sql`, `)})
          order by id
          for update
        `));
        if (lockedRows.length !== selection.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Bulk selection contains a record outside this import");

        const allRecordRows = rows(await tx.execute(sql`select * from bibliographic_import_records where project_id=${projectId} and import_id=${importId} order by ordinal`));
        const allRecords = allRecordRows.map(mapRecord);
        const recordById = new Map(allRecords.map((record) => [record.id, record]));
        const peerGroups = new Map<string, string[]>();
        for (const record of allRecords) {
          for (const key of metadataPeerKeys(record)) peerGroups.set(key, [...(peerGroups.get(key) ?? []), record.id]);
        }
        const resolutionRows = rows(await tx.execute(sql`
          select * from bibliographic_import_resolutions
          where project_id=${projectId} and import_id=${importId}
            and record_id in (${sql.join(recordIds.map((recordId) => sql`${recordId}::uuid`), sql`, `)})
          order by record_id, sequence desc, id desc
        `));
        const currentById = new Map<string, ReturnType<typeof recordState>>();
        for (const row of resolutionRows) {
          const recordId = String(row.record_id);
          if (!currentById.has(recordId)) currentById.set(recordId, recordState(row));
        }
        const paperRows = await loadPaperCandidateRows(projectId, tx);
        const validated: Array<{ record: ReturnType<typeof mapRecord>; payload: PaperWriteInput; current: ReturnType<typeof recordState> | null }> = [];
        const submittedById = new Map(selection.map((item) => [item.recordId, item]));
        const block = (record: ReturnType<typeof mapRecord>, message: string, code: "VALIDATION_ERROR" | "CONCURRENT_MODIFICATION" | "DUPLICATE_REVIEW_REQUIRED" = "VALIDATION_ERROR"): never => {
          throw new DomainError(code, `Bulk creation blocked by record ${record.ordinal} (${record.id}): ${message}`, { recordId: record.id, ordinal: record.ordinal });
        };
        for (const row of lockedRows) {
          const record = mapRecord(row);
          const submitted = submittedById.get(record.id);
          const current = currentById.get(record.id) ?? null;
          if (!submitted) block(record, "the submitted selection is incomplete");
          const submittedSelection = submitted as BibliographicBulkSelection;
          let payload: PaperWriteInput | null = null;
          try { payload = canonicalPaperPayload(record); }
          catch (error) { block(record, error instanceof DomainError ? error.message : "the metadata is invalid"); }
          if (!payload) block(record, "the metadata is invalid");
          const candidateRows = candidatesFromRecord(record, paperRows);
          const candidateIds = candidateRows.map((candidate) => String(candidate.id)).sort();
          const peerRecordIds = metadataPeerRecordIds(record, peerGroups, record.id);
          const fingerprint = fingerprintBulkRecord({ recordId: record.id, ordinal: record.ordinal, outcome: record.outcome, expectedResolutionId: current?.id ?? null, payload, candidateIds, peerRecordIds });
          if (submittedSelection.expectedResolutionId !== (current?.id ?? null) || submittedSelection.fingerprint !== fingerprint) block(record, "the preview is stale; recompute eligibility", "CONCURRENT_MODIFICATION");
          if (record.outcome === "failed") block(record, "parsing failed");
          if (current?.paperId) block(record, "the record is already resolved");
          if (candidateRows.length > 0) block(record, "a current canonical Paper candidate requires review", "DUPLICATE_REVIEW_REQUIRED");
          if (peerRecordIds.length > 0) block(record, `duplicate imported peer record(s) ${peerRecordIds.map((recordId) => recordById.get(recordId)?.ordinal ?? recordId).join(", ")}`, "DUPLICATE_REVIEW_REQUIRED");
          validated.push({ record, payload: payload as PaperWriteInput, current });
        }

        const created: Array<{ recordId: string; ordinal: number; paperId: string }> = [];
        for (const item of validated) {
          const paper = await writePaper(tx, projectId, item.payload, { source: "import" });
          await tx.execute(sql`
            insert into bibliographic_import_resolutions (project_id, import_id, record_id, event_type, paper_id, expected_previous_resolution_id, creation_payload)
            values (${projectId}, ${importId}, ${item.record.id}, 'created_paper', ${paper.id}, ${item.current?.id ?? null}, ${JSON.stringify(item.payload)}::jsonb)
          `);
          created.push({ recordId: item.record.id, ordinal: item.record.ordinal, paperId: String(paper.id) });
        }
        return { importId, created };
      });
    },

    async getRecordSourceBytes(projectId: string, importRecordId: string) {
      const row = rows(await db.execute(sql`select i.source_bytes,r.start_byte,r.end_byte from bibliographic_import_records r join bibliographic_imports i on i.project_id=r.project_id and i.id=r.import_id where r.project_id=${id(projectId, "Project")} and r.id=${id(importRecordId, "Import record")} limit 1`))[0];
      if (!row) throw new DomainError("CROSS_PROJECT_REFERENCE", "Bibliographic import record does not belong to this project");
      const bytes = Buffer.from(row.source_bytes as Uint8Array);
      return bytes.subarray(Number(row.start_byte), Number(row.end_byte));
    },

    async exportBibtex(projectId: string) {
      await projectExists(projectId);
      const paperRows = rows(await db.execute(sql`select id,title,authors,publication_year,venue,doi,abstract from papers where project_id=${projectId} order by created_at,id`));
      return serializeBibtex(paperRows.map((row) => ({
        id: String(row.id), title: text(row.title), authors: Array.isArray(row.authors) ? row.authors.map(String) : json<string[]>(row.authors, []),
        year: row.publication_year == null ? null : Number(row.publication_year), journal: text(row.venue), doi: text(row.doi), abstract: text(row.abstract), entryType: "misc",
      })));
    },
  };
  return service;
}

export type BibliographicImportServices = ReturnType<typeof createBibliographicImportServices>;
