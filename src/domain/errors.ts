export type DomainErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "PROJECT_NOT_FOUND"
  | "CROSS_PROJECT_REFERENCE"
  | "DUPLICATE_LINK"
  | "PROTECTED_DELETE"
  | "DATABASE_CONSTRAINT";

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function isConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  return [candidate.code, candidate.cause?.code].some((code) =>
    ["23503", "23505", "23514"].includes(String(code)),
  );
}
