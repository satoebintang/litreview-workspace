import { DomainError } from "@/domain/errors";

export const MANUSCRIPT_CLAIM_SELECTION_DEFAULT_PAGE_SIZE = 20;
export const MANUSCRIPT_CLAIM_SELECTION_MAX_PAGE_SIZE = 50;
export const MANUSCRIPT_CLAIM_SELECTION_CURSOR_MAX_LENGTH = 512;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BIGINT = "9223372036854775807";
const MIN_BIGINT_ABS = "9223372036854775808";
const PLACEMENT_KEYS = ["v", "t", "p", "m", "d", "n", "s", "i"] as const;
const REPLACEMENT_KEYS = ["v", "t", "p", "m", "l", "c", "r", "b", "n", "s", "i"] as const;

export type PlacementSelectionCursor = {
  v: 1;
  selectorType: "placement";
  projectId: string;
  manuscriptId: string;
  sectionId: string;
  pageSize: number;
  lastSequence: string;
  lastRevisionId: string;
};

export type ReplacementSelectionCursor = {
  v: 1;
  selectorType: "replacement";
  projectId: string;
  manuscriptId: string;
  placementId: string;
  claimId: string;
  placedRevisionId: string;
  placedSequence: string;
  pageSize: number;
  lastSequence: string;
  lastRevisionId: string;
};

export function canonicalSelectionUuid(value: unknown): string {
  if (typeof value !== "string") throw new DomainError("VALIDATION_ERROR", "Candidate selection scope is invalid");
  const normalized = value.toLowerCase();
  if (!UUID.test(normalized)) throw new DomainError("VALIDATION_ERROR", "Candidate selection scope is invalid");
  return normalized;
}

export function canonicalSelectionBigint(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(value)) {
    throw new Error("invalid BIGINT text");
  }
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const bound = negative ? MIN_BIGINT_ABS : MAX_BIGINT;
  if (digits.length > bound.length || (digits.length === bound.length && digits > bound)) {
    throw new Error("BIGINT is out of range");
  }
  return value;
}

export function effectiveManuscriptClaimSelectionPageSize(value: number | undefined): number {
  if (value === undefined) return MANUSCRIPT_CLAIM_SELECTION_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DomainError("VALIDATION_ERROR", "Candidate page size must be a positive integer");
  }
  return Math.min(value, MANUSCRIPT_CLAIM_SELECTION_MAX_PAGE_SIZE);
}

function invalidCursor(): DomainError {
  return new DomainError("VALIDATION_ERROR", "Candidate page link is invalid or belongs to a different selection. Start from the first page.");
}

function encodeWire(value: object): string {
  const token = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  if (token.length > MANUSCRIPT_CLAIM_SELECTION_CURSOR_MAX_LENGTH) {
    throw new DomainError("DATABASE_CONSTRAINT", "Candidate cursor exceeds its size limit");
  }
  return token;
}

function decodeWire(token: string | null | undefined, keys: readonly string[]): { json: string; record: Record<string, unknown> } | null {
  if (token == null) return null;
  try {
    if (token.length === 0 || token.length > MANUSCRIPT_CLAIM_SELECTION_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("invalid token");
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) throw new Error("noncanonical base64url");
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid object");
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).join("\0") !== keys.join("\0")) throw new Error("invalid keys");
    return { json, record };
  } catch {
    throw invalidCursor();
  }
}

export function encodePlacementSelectionCursor(cursor: PlacementSelectionCursor): string {
  return encodeWire({
    v: 1,
    t: "placement",
    p: canonicalSelectionUuid(cursor.projectId),
    m: canonicalSelectionUuid(cursor.manuscriptId),
    d: canonicalSelectionUuid(cursor.sectionId),
    n: cursor.pageSize,
    s: canonicalSelectionBigint(cursor.lastSequence),
    i: canonicalSelectionUuid(cursor.lastRevisionId),
  });
}

export function decodePlacementSelectionCursor(
  token: string | null | undefined,
  expected: { projectId: string; manuscriptId: string; sectionId: string; pageSize: number },
): PlacementSelectionCursor | null {
  const wire = decodeWire(token, PLACEMENT_KEYS);
  if (!wire) return null;
  try {
    const row = wire.record;
    if (row.v !== 1 || row.t !== "placement" || typeof row.n !== "number" || !Number.isSafeInteger(row.n)) throw new Error("invalid type");
    const cursor: PlacementSelectionCursor = {
      v: 1,
      selectorType: "placement",
      projectId: canonicalSelectionUuid(row.p),
      manuscriptId: canonicalSelectionUuid(row.m),
      sectionId: canonicalSelectionUuid(row.d),
      pageSize: row.n,
      lastSequence: canonicalSelectionBigint(row.s),
      lastRevisionId: canonicalSelectionUuid(row.i),
    };
    if (cursor.projectId !== canonicalSelectionUuid(expected.projectId)
      || cursor.manuscriptId !== canonicalSelectionUuid(expected.manuscriptId)
      || cursor.sectionId !== canonicalSelectionUuid(expected.sectionId)
      || cursor.pageSize !== expected.pageSize) throw new Error("scope mismatch");
    const canonical = { v: 1, t: "placement", p: cursor.projectId, m: cursor.manuscriptId, d: cursor.sectionId, n: cursor.pageSize, s: cursor.lastSequence, i: cursor.lastRevisionId };
    if (JSON.stringify(canonical) !== wire.json) throw new Error("noncanonical JSON");
    return cursor;
  } catch {
    throw invalidCursor();
  }
}

export function encodeReplacementSelectionCursor(cursor: ReplacementSelectionCursor): string {
  return encodeWire({
    v: 1,
    t: "replacement",
    p: canonicalSelectionUuid(cursor.projectId),
    m: canonicalSelectionUuid(cursor.manuscriptId),
    l: canonicalSelectionUuid(cursor.placementId),
    c: canonicalSelectionUuid(cursor.claimId),
    r: canonicalSelectionUuid(cursor.placedRevisionId),
    b: canonicalSelectionBigint(cursor.placedSequence),
    n: cursor.pageSize,
    s: canonicalSelectionBigint(cursor.lastSequence),
    i: canonicalSelectionUuid(cursor.lastRevisionId),
  });
}

export function decodeReplacementSelectionCursor(
  token: string | null | undefined,
  expected: { projectId: string; manuscriptId: string; placementId: string; claimId: string; placedRevisionId: string; placedSequence: string; pageSize: number },
): ReplacementSelectionCursor | null {
  const wire = decodeWire(token, REPLACEMENT_KEYS);
  if (!wire) return null;
  try {
    const row = wire.record;
    if (row.v !== 1 || row.t !== "replacement" || typeof row.n !== "number" || !Number.isSafeInteger(row.n)) throw new Error("invalid type");
    const cursor: ReplacementSelectionCursor = {
      v: 1,
      selectorType: "replacement",
      projectId: canonicalSelectionUuid(row.p),
      manuscriptId: canonicalSelectionUuid(row.m),
      placementId: canonicalSelectionUuid(row.l),
      claimId: canonicalSelectionUuid(row.c),
      placedRevisionId: canonicalSelectionUuid(row.r),
      placedSequence: canonicalSelectionBigint(row.b),
      pageSize: row.n,
      lastSequence: canonicalSelectionBigint(row.s),
      lastRevisionId: canonicalSelectionUuid(row.i),
    };
    if (cursor.projectId !== canonicalSelectionUuid(expected.projectId)
      || cursor.manuscriptId !== canonicalSelectionUuid(expected.manuscriptId)
      || cursor.placementId !== canonicalSelectionUuid(expected.placementId)
      || cursor.claimId !== canonicalSelectionUuid(expected.claimId)
      || cursor.placedRevisionId !== canonicalSelectionUuid(expected.placedRevisionId)
      || cursor.placedSequence !== canonicalSelectionBigint(expected.placedSequence)
      || cursor.pageSize !== expected.pageSize) throw new Error("scope mismatch");
    const canonical = {
      v: 1,
      t: "replacement",
      p: cursor.projectId,
      m: cursor.manuscriptId,
      l: cursor.placementId,
      c: cursor.claimId,
      r: cursor.placedRevisionId,
      b: cursor.placedSequence,
      n: cursor.pageSize,
      s: cursor.lastSequence,
      i: cursor.lastRevisionId,
    };
    if (JSON.stringify(canonical) !== wire.json) throw new Error("noncanonical JSON");
    return cursor;
  } catch {
    throw invalidCursor();
  }
}
