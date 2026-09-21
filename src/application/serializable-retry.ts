import type { Database } from "@/db/client";

export type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const MAX_SERIALIZABLE_ATTEMPTS = 3;

function sqlState(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (typeof current === "object" && current !== null && "code" in current) {
      const code = String((current as { code?: unknown }).code ?? "");
      if (code) return code;
    }
    current = typeof current === "object" && current !== null && "cause" in current
      ? (current as { cause?: unknown }).cause
      : null;
  }
  return null;
}

export function isSerializableRetryable(error: unknown): boolean {
  const code = sqlState(error);
  return code === "40001" || code === "40P01";
}

/**
 * Run a transaction at SERIALIZABLE isolation. At most three total attempts
 * are made, and only PostgreSQL serialization/deadlock failures are retried.
 * The callback is intentionally rerun from the beginning so every lock and
 * validation query observes a newly recomputed transaction snapshot.
 */
export async function withSerializableRetry<T>(
  db: Database,
  operation: (tx: DatabaseTransaction) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_SERIALIZABLE_ATTEMPTS) {
    throw new Error(`maxAttempts must be an integer from 1 to ${MAX_SERIALIZABLE_ATTEMPTS}`);
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await db.transaction(operation, { isolationLevel: "serializable" });
    } catch (error) {
      if (!isSerializableRetryable(error) || attempt === maxAttempts - 1) throw error;
    }
  }
  throw new Error("Serializable transaction retry loop did not return");
}
