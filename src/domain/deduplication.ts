import { idSchema } from "./validation";

export type DeduplicationDecisionValue = "same_work" | "different_work";
export type DeduplicationPairState = "unreviewed" | DeduplicationDecisionValue;
export type DuplicateCandidateReason = "normalized_doi" | "same_source_record_id" | "normalized_title_year";
export type DuplicateCandidateStrength = "strong" | "possible";
export type DeduplicationConflictCode =
  | "same_work_conflicts_with_distinct_canonical_papers"
  | "different_work_conflicts_with_shared_canonical_paper";

export interface DeduplicationPairInput {
  leftRetrievedRecordId: string;
  rightRetrievedRecordId: string;
}

export interface DeduplicationDecision {
  id: string;
  sequence: number;
  projectId: string;
  leftRetrievedRecordId: string;
  rightRetrievedRecordId: string;
  decision: DeduplicationDecisionValue;
  note: string | null;
  createdAt: Date;
}

export function canonicalizeDeduplicationPair(input: DeduplicationPairInput): DeduplicationPairInput {
  const left = idSchema.parse(input.leftRetrievedRecordId);
  const right = idSchema.parse(input.rightRetrievedRecordId);
  if (left === right) throw new Error("A RetrievedRecord cannot be paired with itself");
  return left < right
    ? { leftRetrievedRecordId: left, rightRetrievedRecordId: right }
    : { leftRetrievedRecordId: right, rightRetrievedRecordId: left };
}

export function deduplicationPairKey(pair: DeduplicationPairInput): string {
  const canonical = canonicalizeDeduplicationPair(pair);
  return `${canonical.leftRetrievedRecordId}:${canonical.rightRetrievedRecordId}`;
}
