export function withLosslessSequence<T extends { sequence: number | string }>(projection: T, sequence: string): Omit<T, "sequence"> & { sequence: string } {
  return { ...projection, sequence };
}

export function displaySequenceLabel(sequence: number | string | null | undefined): string {
  if (sequence === null || sequence === undefined) return "—";
  if (typeof sequence === "string") return sequence;
  return Number.isSafeInteger(sequence) ? String(sequence) : "sequence unavailable";
}
