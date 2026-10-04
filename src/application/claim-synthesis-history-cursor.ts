import { DomainError } from "@/domain/errors";
import {
  CLAIM_SYNTHESIS_HISTORY_CURSOR_MAX_LENGTH,
  CLAIM_SYNTHESIS_HISTORY_DEFAULT_PAGE_SIZE,
  CLAIM_SYNTHESIS_HISTORY_MAX_PAGE_SIZE,
  type ClaimSynthesisHistoryCursor,
  type ClaimSynthesisHistoryType,
} from "./claim-synthesis-history-read-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BIGINT = "9223372036854775807";
const MIN_BIGINT_ABS = "9223372036854775808";

function invalidCursor(): DomainError {
  return new DomainError("VALIDATION_ERROR", "History link is invalid or belongs to a different record. Start from the first page.");
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

export function effectiveClaimSynthesisHistoryPageSize(value: number | undefined): number {
  if (value === undefined) return CLAIM_SYNTHESIS_HISTORY_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DomainError("VALIDATION_ERROR", "History page size must be a positive integer");
  }
  return Math.min(value, CLAIM_SYNTHESIS_HISTORY_MAX_PAGE_SIZE);
}

function cursorKeys(historyType: ClaimSynthesisHistoryType): readonly string[] {
  if (historyType === "claim-revision") return ["v", "projectId", "claimId", "historyType", "pageSize", "lastSequence", "lastEventId"];
  if (historyType === "synthesis-revision") return ["v", "projectId", "statementId", "historyType", "pageSize", "lastSequence", "lastEventId"];
  return ["v", "projectId", "statementId", "revisionId", "historyType", "pageSize", "lastSequence", "lastEventId"];
}

export function encodeClaimSynthesisHistoryCursor(cursor: ClaimSynthesisHistoryCursor): string {
  const token = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  if (token.length > CLAIM_SYNTHESIS_HISTORY_CURSOR_MAX_LENGTH) {
    throw new DomainError("DATABASE_CONSTRAINT", "History cursor exceeds its size limit");
  }
  return token;
}

export function decodeClaimSynthesisHistoryCursor(
  token: string | null | undefined,
  expected: { projectId: string; historyType: ClaimSynthesisHistoryType; pageSize: number; claimId?: string; statementId?: string; revisionId?: string },
): ClaimSynthesisHistoryCursor | null {
  if (token == null) return null;
  try {
    if (token.length === 0 || token.length > CLAIM_SYNTHESIS_HISTORY_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("invalid token encoding");
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) throw new Error("noncanonical token encoding");
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid cursor object");
    const record = value as Record<string, unknown>;
    if (typeof record.historyType !== "string" || record.historyType !== expected.historyType) throw new Error("invalid history type");
    const keys = cursorKeys(expected.historyType as ClaimSynthesisHistoryType);
    if (Object.keys(record).join("\0") !== keys.join("\0")) throw new Error("invalid cursor fields");
    if (record.v !== 1 || typeof record.pageSize !== "number" || !Number.isSafeInteger(record.pageSize)) throw new Error("invalid cursor version or size");
    const projectId = cursorUuid(record.projectId);
    const pageSize = record.pageSize;
    const lastSequence = cursorSequence(record.lastSequence);
    const lastEventId = cursorUuid(record.lastEventId);
    let cursor: ClaimSynthesisHistoryCursor;
    if (expected.historyType === "claim-revision") {
      cursor = { v: 1, projectId, claimId: cursorUuid(record.claimId), historyType: "claim-revision", pageSize, lastSequence, lastEventId };
    } else if (expected.historyType === "synthesis-revision") {
      cursor = { v: 1, projectId, statementId: cursorUuid(record.statementId), historyType: "synthesis-revision", pageSize, lastSequence, lastEventId };
    } else {
      cursor = {
        v: 1,
        projectId,
        statementId: cursorUuid(record.statementId),
        revisionId: cursorUuid(record.revisionId),
        historyType: "synthesis-interpretation",
        pageSize,
        lastSequence,
        lastEventId,
      };
    }
    if (cursor.projectId !== expected.projectId.toLowerCase() || cursor.pageSize !== expected.pageSize) throw new Error("cursor binding mismatch");
    if (cursor.historyType === "claim-revision" && cursor.claimId !== expected.claimId?.toLowerCase()) throw new Error("cursor binding mismatch");
    if (cursor.historyType !== "claim-revision" && cursor.statementId !== expected.statementId?.toLowerCase()) throw new Error("cursor binding mismatch");
    if (cursor.historyType === "synthesis-interpretation" && cursor.revisionId !== expected.revisionId?.toLowerCase()) throw new Error("cursor binding mismatch");
    if (JSON.stringify(cursor) !== json) throw new Error("noncanonical cursor JSON");
    return cursor;
  } catch {
    throw invalidCursor();
  }
}
