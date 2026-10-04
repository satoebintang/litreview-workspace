export const CLAIM_SYNTHESIS_HISTORY_DEFAULT_PAGE_SIZE = 20;
export const CLAIM_SYNTHESIS_HISTORY_MAX_PAGE_SIZE = 50;
export const CLAIM_SYNTHESIS_HISTORY_CURSOR_MAX_LENGTH = 512;

export type ClaimSynthesisHistoryType =
  | "claim-revision"
  | "synthesis-revision"
  | "synthesis-interpretation";

type HistoryCursorBase = {
  v: 1;
  projectId: string;
  historyType: ClaimSynthesisHistoryType;
  pageSize: number;
  lastSequence: string;
  lastEventId: string;
};

export type ClaimRevisionHistoryCursor = HistoryCursorBase & {
  historyType: "claim-revision";
  claimId: string;
};

export type SynthesisRevisionHistoryCursor = HistoryCursorBase & {
  historyType: "synthesis-revision";
  statementId: string;
};

export type SynthesisInterpretationHistoryCursor = HistoryCursorBase & {
  historyType: "synthesis-interpretation";
  statementId: string;
  revisionId: string;
};

export type ClaimSynthesisHistoryCursor =
  | ClaimRevisionHistoryCursor
  | SynthesisRevisionHistoryCursor
  | SynthesisInterpretationHistoryCursor;

export type HistoryPageOptions = {
  pageSize?: number;
  cursor?: string | null;
};

export type SynthesisInterpretationHistoryPageOptions = HistoryPageOptions & {
  /** Reuse the current identity selected earlier in the same read snapshot. */
  currentIdentity?: CurrentSynthesisInterpretationIdentity | null;
};

export type HistoryPage<T, C> = {
  items: T[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
  current: C | null;
};

export type ClaimRevisionHistoryItem = {
  id: string;
  sequence: string;
  lifecycle: "active" | "withdrawn";
  isCurrent: boolean;
  claimTextPreview: string | null;
  claimTextTruncated: boolean;
  researcherNotePreview: string | null;
  researcherNoteTruncated: boolean;
  createdAt: Date;
  finalizedAt: Date;
  supportStatus: "supported" | "unsupported";
  directEvidenceCount: number;
  extractionRevisionCount: number;
  synthesisRevisionCount: number;
  totalSupportCount: number;
  citationCandidateCount: number;
  distinctPaperCount: number;
  href: string;
};

export type CurrentClaimRevisionIdentity = {
  id: string;
  sequence: string;
  lifecycle: "active" | "withdrawn";
};

export type SynthesisPreparationHistorySummary = {
  synthesisRevisionId: string;
  preparationId: string;
  evidenceSetId: string;
  evidenceSetNamePreview: string;
  evidenceSetNameTruncated: boolean;
  evidenceSetArchivedAt: Date | null;
  pinnedCompositionRevisionId: string;
  pinnedCompositionSequence: string;
  finalizedAt: Date;
};

export type SynthesisRevisionHistoryItem = {
  id: string;
  sequence: string;
  lifecycle: "active" | "withdrawn";
  isCurrent: boolean;
  titlePreview: string | null;
  titleTruncated: boolean;
  statementPreview: string | null;
  statementTruncated: boolean;
  researcherNotePreview: string | null;
  researcherNoteTruncated: boolean;
  createdAt: Date;
  finalizedAt: Date;
  supportStatus: "supported" | "unsupported";
  supportingRevisionCount: number;
  supportingPaperCount: number;
  supportingFieldCount: number;
  preparation: SynthesisPreparationHistorySummary | null;
  href: string;
};

export type CurrentSynthesisRevisionIdentity = {
  id: string;
  sequence: string;
  lifecycle: "active" | "withdrawn";
};

export type SynthesisInterpretationHistoryItem = {
  id: string;
  sequence: string;
  convergenceState: "convergent" | "mixed" | "contradictory" | "inconclusive";
  summaryPreview: string;
  summaryTruncated: boolean;
  researcherNotePreview: string | null;
  researcherNoteTruncated: boolean;
  createdAt: Date;
  finalizedAt: Date;
  limitationCount: number;
  questionCount: number;
  contradictionCount: number;
  isCurrent: boolean;
  href: string;
};

export type CurrentSynthesisInterpretationIdentity = {
  id: string;
  sequence: string;
  convergenceState: "convergent" | "mixed" | "contradictory" | "inconclusive";
  finalizedAt: Date;
};

export type CurrentSynthesisInterpretationSummary = CurrentSynthesisInterpretationIdentity & {
  summary: string;
  researcherNote: string | null;
};
