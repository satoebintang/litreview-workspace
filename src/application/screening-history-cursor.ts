import { DomainError } from "@/domain/errors";
import {
  SCREENING_HISTORY_CURSOR_MAX_LENGTH,
  SCREENING_HISTORY_DEFAULT_PAGE_SIZE,
  SCREENING_HISTORY_MAX_PAGE_SIZE,
  screeningHistoryTypes,
  type ScreeningHistoryCursor,
  type ScreeningHistoryType,
} from "./screening-history-read-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR_KEYS = ["v", "projectId", "paperId", "historyType", "pageSize", "lastSequence", "lastEventId"] as const;
const MAX_BIGINT = "9223372036854775807";
const MIN_BIGINT_ABS = "9223372036854775808";

function invalidCursor(): DomainError {
  return new DomainError("VALIDATION_ERROR", "History link is invalid or belongs to a different Paper. Start from the first page.");
}

function cursorUuid(value: unknown): string {
  if (typeof value !== "string" || value !== value.toLowerCase() || !UUID.test(value)) throw new Error("invalid UUID");
  return value;
}

function cursorSequence(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(value)) throw new Error("invalid sequence");
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const bound = negative ? MIN_BIGINT_ABS : MAX_BIGINT;
  if (digits.length > bound.length || (digits.length === bound.length && digits > bound)) throw new Error("sequence is outside PostgreSQL BIGINT");
  return value;
}

export function effectiveScreeningHistoryPageSize(value: number | undefined): number {
  if (value === undefined) return SCREENING_HISTORY_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DomainError("VALIDATION_ERROR", "History page size must be a positive integer");
  }
  return Math.min(value, SCREENING_HISTORY_MAX_PAGE_SIZE);
}

export function encodeScreeningHistoryCursor(cursor: ScreeningHistoryCursor): string {
  const token = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  if (token.length > SCREENING_HISTORY_CURSOR_MAX_LENGTH) {
    throw new DomainError("DATABASE_CONSTRAINT", "History cursor exceeds its size limit");
  }
  return token;
}

export function decodeScreeningHistoryCursor(
  token: string | null | undefined,
  expected: { projectId: string; paperId: string; historyType: ScreeningHistoryType; pageSize: number },
): ScreeningHistoryCursor | null {
  if (token == null) return null;
  try {
    if (token.length === 0 || token.length > SCREENING_HISTORY_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("invalid token encoding");
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) throw new Error("noncanonical token encoding");
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid cursor object");
    const record = value as Record<string, unknown>;
    if (Object.keys(record).join("\0") !== CURSOR_KEYS.join("\0")) throw new Error("invalid cursor fields");
    if (record.v !== 1 || typeof record.pageSize !== "number" || !Number.isSafeInteger(record.pageSize)) throw new Error("invalid cursor version or size");
    if (typeof record.historyType !== "string" || !screeningHistoryTypes.includes(record.historyType as ScreeningHistoryType)) throw new Error("invalid history type");
    const cursor: ScreeningHistoryCursor = {
      v: 1,
      projectId: cursorUuid(record.projectId),
      paperId: cursorUuid(record.paperId),
      historyType: record.historyType as ScreeningHistoryType,
      pageSize: record.pageSize,
      lastSequence: cursorSequence(record.lastSequence),
      lastEventId: cursorUuid(record.lastEventId),
    };
    if (cursor.projectId !== expected.projectId.toLowerCase()
      || cursor.paperId !== expected.paperId.toLowerCase()
      || cursor.historyType !== expected.historyType
      || cursor.pageSize !== expected.pageSize) throw new Error("cursor binding mismatch");
    if (JSON.stringify(cursor) !== json) throw new Error("noncanonical cursor JSON");
    return cursor;
  } catch {
    throw invalidCursor();
  }
}
