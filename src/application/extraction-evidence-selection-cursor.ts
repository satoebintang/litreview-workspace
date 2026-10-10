import { createHash } from "node:crypto";
import { DomainError } from "@/domain/errors";

export const EXTRACTION_EVIDENCE_DEFAULT_PAGE_SIZE = 20;
export const EXTRACTION_EVIDENCE_MAX_PAGE_SIZE = 50;
export const EXTRACTION_EVIDENCE_CURSOR_MAX_LENGTH = 512;

type ExtractionEvidenceCandidateCursorBase = {
  kind: "paper-extraction-evidence-candidate";
  projectId: string;
  paperId: string;
  pageSize: number;
  createdAt: string;
  id: string;
};

export type ExtractionEvidenceCandidateCursor = ExtractionEvidenceCandidateCursorBase & (
  | { version: 1 }
  | { version: 2; queryHash: string }
);

type CursorScope = Pick<ExtractionEvidenceCandidateCursorBase, "projectId" | "paperId" | "pageSize"> & {
  queryHash?: string;
};

export function hashExtractionEvidenceSearchQuery(query: string): string {
  return createHash("sha256").update(query, "utf8").digest("hex");
}

function invalidCursor(): DomainError {
  return new DomainError("VALIDATION_ERROR", "Evidence page cursor is invalid for this Paper, search query, or page size", { input: "pagination" });
}

function canonicalUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function validMicrosecondTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

export function effectiveExtractionEvidencePageSize(input?: number): number {
  if (input === undefined) return EXTRACTION_EVIDENCE_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(input) || input < 1) {
    throw new DomainError("VALIDATION_ERROR", "Evidence page size must be a positive integer", { input: "pagination" });
  }
  return Math.min(input, EXTRACTION_EVIDENCE_MAX_PAGE_SIZE);
}

export function encodeExtractionEvidenceCandidateCursor(cursor: ExtractionEvidenceCandidateCursor): string {
  const canonical = {
    kind: cursor.kind,
    version: cursor.version,
    projectId: cursor.projectId,
    paperId: cursor.paperId,
    pageSize: cursor.pageSize,
    createdAt: cursor.createdAt,
    id: cursor.id,
    ...(cursor.version === 2 ? { queryHash: cursor.queryHash } : {}),
  };
  const encoded = Buffer.from(JSON.stringify(canonical), "utf8").toString("base64url");
  if (encoded.length > EXTRACTION_EVIDENCE_CURSOR_MAX_LENGTH) throw invalidCursor();
  return encoded;
}

export function decodeExtractionEvidenceCandidateCursor(
  value: string | null | undefined,
  expected: CursorScope,
): ExtractionEvidenceCandidateCursor | null {
  if (value == null || value === "") return null;
  if (value.length > EXTRACTION_EVIDENCE_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidCursor();
  try {
    const rawText = Buffer.from(value, "base64url").toString("utf8");
    const decoded: unknown = JSON.parse(rawText);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw invalidCursor();
    const raw = decoded as Record<string, unknown>;
    const version = raw.version;
    if (version !== 1 && version !== 2) throw invalidCursor();
    const expectedKeys = version === 1
      ? ["kind", "version", "projectId", "paperId", "pageSize", "createdAt", "id"]
      : ["kind", "version", "projectId", "paperId", "pageSize", "createdAt", "id", "queryHash"];
    if (Object.keys(raw).length !== expectedKeys.length || expectedKeys.some((key) => !(key in raw))) throw invalidCursor();
    if (raw.kind !== "paper-extraction-evidence-candidate") throw invalidCursor();
    if (!canonicalUuid(raw.projectId) || !canonicalUuid(raw.paperId) || !canonicalUuid(raw.id)) throw invalidCursor();
    if (typeof raw.pageSize !== "number" || !Number.isSafeInteger(raw.pageSize) || raw.pageSize < 1 || raw.pageSize > EXTRACTION_EVIDENCE_MAX_PAGE_SIZE) throw invalidCursor();
    if (!validMicrosecondTimestamp(raw.createdAt)) throw invalidCursor();
    const base: ExtractionEvidenceCandidateCursorBase = {
      kind: "paper-extraction-evidence-candidate",
      projectId: raw.projectId,
      paperId: raw.paperId,
      pageSize: raw.pageSize,
      createdAt: raw.createdAt,
      id: raw.id,
    };
    let cursor: ExtractionEvidenceCandidateCursor;
    if (version === 1) {
      cursor = { ...base, version: 1 };
    } else {
      if (typeof raw.queryHash !== "string" || !/^[0-9a-f]{64}$/.test(raw.queryHash)) throw invalidCursor();
      cursor = { ...base, version: 2, queryHash: raw.queryHash };
    }
    const canonicalText = JSON.stringify({
      kind: cursor.kind,
      version: cursor.version,
      projectId: cursor.projectId,
      paperId: cursor.paperId,
      pageSize: cursor.pageSize,
      createdAt: cursor.createdAt,
      id: cursor.id,
      ...(cursor.version === 2 ? { queryHash: cursor.queryHash } : {}),
    });
    if (rawText !== canonicalText || Buffer.from(rawText, "utf8").toString("base64url") !== value) throw invalidCursor();
    if (cursor.projectId !== expected.projectId || cursor.paperId !== expected.paperId || cursor.pageSize !== expected.pageSize) throw invalidCursor();
    const expectedQueryHash = expected.queryHash ?? hashExtractionEvidenceSearchQuery("");
    if (cursor.version === 1) {
      if (expectedQueryHash !== hashExtractionEvidenceSearchQuery("")) throw invalidCursor();
    } else if (cursor.queryHash !== expectedQueryHash) {
      throw invalidCursor();
    }
    return cursor;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw invalidCursor();
  }
}
