import { DomainError } from "@/domain/errors";
import {
  EXTRACTION_HISTORY_CURSOR_MAX_LENGTH,
  EXTRACTION_HISTORY_DEFAULT_PAGE_SIZE,
  EXTRACTION_HISTORY_MAX_PAGE_SIZE,
  EXTRACTION_HISTORY_TYPE,
  type ExtractionHistoryCursor,
} from "./extraction-history-read-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BIGINT = "9223372036854775807";
const MIN_BIGINT_ABS = "9223372036854775808";
const WIRE_KEYS = ["v", "p", "pa", "f", "x", "t", "n", "s", "i"] as const;

type WireCursor = {
  v: 1;
  p: string;
  pa: string;
  f: string;
  x: string;
  t: typeof EXTRACTION_HISTORY_TYPE;
  n: number;
  s: string;
  i: string;
};

function invalidCursor(): DomainError {
  return new DomainError("VALIDATION_ERROR", "History link is invalid or belongs to a different record. Start from the first page.");
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || value !== value.toLowerCase() || !UUID.test(value)) throw new Error("invalid UUID");
  return value;
}

function canonicalBigint(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(value)) throw new Error("invalid BIGINT text");
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const bound = negative ? MIN_BIGINT_ABS : MAX_BIGINT;
  if (digits.length > bound.length || (digits.length === bound.length && digits > bound)) throw new Error("BIGINT is out of range");
  return value;
}

export function effectiveExtractionHistoryPageSize(value: number | undefined): number {
  if (value === undefined) return EXTRACTION_HISTORY_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DomainError("VALIDATION_ERROR", "History page size must be a positive integer");
  }
  return Math.min(value, EXTRACTION_HISTORY_MAX_PAGE_SIZE);
}

function toWire(cursor: ExtractionHistoryCursor): WireCursor {
  return {
    v: 1,
    p: cursor.projectId,
    pa: cursor.paperId,
    f: cursor.fieldId,
    x: cursor.extractionValueId,
    t: EXTRACTION_HISTORY_TYPE,
    n: cursor.pageSize,
    s: cursor.lastSequence,
    i: cursor.lastRevisionId,
  };
}

export function encodeExtractionHistoryCursor(cursor: ExtractionHistoryCursor): string {
  const token = Buffer.from(JSON.stringify(toWire(cursor)), "utf8").toString("base64url");
  if (token.length > EXTRACTION_HISTORY_CURSOR_MAX_LENGTH) {
    throw new DomainError("DATABASE_CONSTRAINT", "History cursor exceeds its size limit");
  }
  return token;
}

export function decodeExtractionHistoryCursor(
  token: string | null | undefined,
  expected: { projectId: string; paperId: string; fieldId: string; extractionValueId?: string; pageSize: number },
): ExtractionHistoryCursor | null {
  if (token == null) return null;
  try {
    if (token.length === 0 || token.length > EXTRACTION_HISTORY_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("invalid token");
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) throw new Error("noncanonical base64url");
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid object");
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).join("\0") !== WIRE_KEYS.join("\0")) throw new Error("invalid keys");
    if (record.v !== 1 || record.t !== EXTRACTION_HISTORY_TYPE || typeof record.n !== "number" || !Number.isSafeInteger(record.n)) throw new Error("invalid version or type");
    const cursor: ExtractionHistoryCursor = {
      v: 1,
      projectId: canonicalUuid(record.p),
      paperId: canonicalUuid(record.pa),
      fieldId: canonicalUuid(record.f),
      extractionValueId: canonicalUuid(record.x),
      historyType: EXTRACTION_HISTORY_TYPE,
      pageSize: record.n,
      lastSequence: canonicalBigint(record.s),
      lastRevisionId: canonicalUuid(record.i),
    };
    if (cursor.projectId !== expected.projectId.toLowerCase()
      || cursor.paperId !== expected.paperId.toLowerCase()
      || cursor.fieldId !== expected.fieldId.toLowerCase()
      || (expected.extractionValueId !== undefined && cursor.extractionValueId !== expected.extractionValueId.toLowerCase())
      || cursor.pageSize !== expected.pageSize) throw new Error("scope mismatch");
    if (JSON.stringify(toWire(cursor)) !== json) throw new Error("noncanonical JSON");
    return cursor;
  } catch {
    throw invalidCursor();
  }
}
