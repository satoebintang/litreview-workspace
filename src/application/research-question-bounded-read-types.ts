import type {
  ResearchQuestionAnswerCandidateReasonCode,
  ProjectProtocolContext,
  ResearchQuestionAnswerSnapshot,
  TraceabilityFlagCode,
} from "@/domain/types";

export type ResearchQuestionTraceabilityTargetType =
  | "extraction-field"
  | "evidence-set"
  | "synthesis-statement"
  | "claim";

export interface ResearchQuestionBoundedPage<T> {
  items: T[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ResearchQuestionPageOptions {
  pageSize?: number;
  cursor?: string | null;
}

export interface ResearchQuestionSearchPageOptions extends ResearchQuestionPageOptions {
  search?: string;
}

export interface ResearchQuestionFlagCounts {
  extraction: Partial<Record<TraceabilityFlagCode, number>>;
  evidenceSets: Partial<Record<TraceabilityFlagCode, number>>;
  synthesis: Partial<Record<TraceabilityFlagCode, number>>;
  claims: Partial<Record<TraceabilityFlagCode, number>>;
  fullyCovered: boolean;
}

export interface ResearchQuestionMatrixPageOptions extends ResearchQuestionPageOptions {
  status?: "all" | "active" | "archived";
}

export interface ResearchQuestionMatrixPageRow {
  question: {
    id: string;
    projectId: string;
    identifier: string;
    label: string;
    sortOrder: number;
    archivedAt: Date | null;
  };
  counts: {
    linkedExtractionFields: number;
    linkedEvidenceSets: number;
    linkedSynthesisStatements: number;
    activeSynthesisStatements: number;
    interpretations: number;
    linkedClaims: number;
    activeClaims: number;
    currentManuscriptPlacements: number;
    finalizedAnswers: number;
    claimAnswerContexts: number;
    synthesisAnswerContexts: number;
    latestAnswerSequence: string | null;
    driftedAnswerContexts: number;
  };
  diagnostics: ResearchQuestionFlagCounts;
}

export interface ResearchQuestionMatrixPage {
  project: { id: string; title: string };
  rows: ResearchQuestionMatrixPageRow[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
  questionCounts: { active: number; archived: number };
  protocolContext: ProjectProtocolContext;
}

export interface ResearchQuestionDimensionSummary {
  linkedCount: number;
  diagnosticCounts: Partial<Record<TraceabilityFlagCode, number>>;
}

export interface ResearchQuestionWorkspaceSummary {
  project: { id: string; title: string };
  question: {
    id: string;
    projectId: string;
    identifier: string;
    label: string;
    sortOrder: number;
    archivedAt: Date | null;
  };
  protocolContext: ProjectProtocolContext;
  traceabilityEpoch: string;
  currentLinkCounts: {
    extractionFields: number;
    evidenceSets: number;
    synthesisStatements: number;
    claims: number;
  };
  diagnostics: ResearchQuestionFlagCounts;
  answerSummary: {
    finalizedAnswerCount: number;
    latestAnswerSequence: string | null;
    claimContextCount: number;
    synthesisContextCount: number;
    driftedContextCount: number;
  };
}

export interface ResearchQuestionExtractionLinkRow {
  id: string;
  name: string;
  fieldType: string;
  archivedAt: Date | null;
  hasCurrentData: boolean;
  diagnosticFlags: TraceabilityFlagCode[];
}

export interface ResearchQuestionEvidenceSetLinkRow {
  id: string;
  name: string;
  archivedAt: Date | null;
  latestCompositionRevisionId: string | null;
  memberCount: number;
  rejectedEvidenceCount: number;
  diagnosticFlags: TraceabilityFlagCode[];
}

export interface ResearchQuestionSynthesisLinkRow {
  id: string;
  currentActiveRevisionId: string | null;
  currentTitle: string;
  currentState: string | null;
  supportCount: number;
  interpretationAvailable: boolean;
  diagnosticFlags: TraceabilityFlagCode[];
}

export interface ResearchQuestionClaimLinkRow {
  id: string;
  currentActiveRevisionId: string | null;
  currentClaimText: string;
  currentState: string | null;
  supportCount: number;
  supportStatus: "supported" | "unsupported";
  currentPlacementCount: number;
  isCurrentlyPlaced: boolean;
  diagnosticFlags: TraceabilityFlagCode[];
}

export interface ResearchQuestionAnswerHistoryItem {
  id: string;
  sequence: string;
  finalizedAt: Date;
  textPreview: string;
  claimContextCount: number;
  synthesisContextCount: number;
  driftedContextCount: number;
}

export interface ResearchQuestionAnswerHistoryPage extends ResearchQuestionBoundedPage<ResearchQuestionAnswerHistoryItem> {
  highWaterSequence: string;
  totalCount: number;
  latestAnswerSequence: string | null;
}

export interface ResearchQuestionWorkspace extends ResearchQuestionWorkspaceSummary {
  links: {
    extractionFields: ResearchQuestionBoundedPage<ResearchQuestionExtractionLinkRow>;
    evidenceSets: ResearchQuestionBoundedPage<ResearchQuestionEvidenceSetLinkRow>;
    synthesisStatements: ResearchQuestionBoundedPage<ResearchQuestionSynthesisLinkRow>;
    claims: ResearchQuestionBoundedPage<ResearchQuestionClaimLinkRow>;
  };
  answerHistory: ResearchQuestionAnswerHistoryPage;
}

export type ResearchQuestionTraceabilityHistoryEvent = {
  id: string;
  sequence: string;
  action: "linked" | "unlinked";
  note: string | null;
  createdAt: Date;
};

export type ResearchQuestionTraceabilityTargetDetail = {
  project: { id: string; title: string };
  question: { id: string; identifier: string };
  traceabilityEpoch: string;
  targetType: ResearchQuestionTraceabilityTargetType;
  currentlyLinked: boolean;
  target:
    | ResearchQuestionExtractionLinkRow
    | ResearchQuestionEvidenceSetLinkRow
    | ResearchQuestionSynthesisLinkRow
    | ResearchQuestionClaimLinkRow;
  history: ResearchQuestionBoundedPage<ResearchQuestionTraceabilityHistoryEvent>;
};

export interface ResearchQuestionTargetPickerRow {
  targetType: ResearchQuestionTraceabilityTargetType;
  id: string;
  label: string;
  state?: string | null;
  archivedAt?: Date | null;
  fieldType?: string;
  isCurrentlyLinked: boolean;
}

export interface ResearchQuestionTargetPickerPage extends ResearchQuestionBoundedPage<ResearchQuestionTargetPickerRow> {
  traceabilityEpoch: string;
  highWaterSequence: string;
  search: string;
}

export interface ResearchQuestionExtractionCoverageRow {
  paperId: string;
  paperTitle: string;
  revisionId: string | null;
  status: "present" | "not_reported" | "not_applicable" | "cleared" | "no_finalized_revision";
  displayValue: string | null;
}

export interface ResearchQuestionExtractionCoveragePage extends ResearchQuestionBoundedPage<ResearchQuestionExtractionCoverageRow> {
  project: { id: string; title: string };
  question: { id: string; identifier: string };
  field: { id: string; name: string; fieldType: string };
  traceabilityEpoch: string;
  highWaterSequence: string;
}

export type ResearchQuestionAnswerBoundedCandidateType = "claim" | "synthesis";

export interface ResearchQuestionAnswerBoundedCandidate {
  targetType: ResearchQuestionAnswerBoundedCandidateType;
  targetId: string;
  label: string;
  revisionId: string | null;
  revisionSequence: string | null;
  revisionState: string | null;
  finalizedAt: Date | null;
  isCurrentlyLinked: true;
  isCurrentRevision: boolean;
  supportStatus: "supported" | "unsupported";
  supportCount: number;
  isSelectable: boolean;
  reason: ResearchQuestionAnswerCandidateReasonCode | null;
  interpretationAvailable?: boolean;
}

export interface ResearchQuestionAnswerCandidatePage extends ResearchQuestionBoundedPage<ResearchQuestionAnswerBoundedCandidate> {
  traceabilityEpoch: string;
}

export type ResearchQuestionAnswerBrowserClaimContext = Omit<ResearchQuestionAnswerSnapshot["claimContexts"][number], "claimRevisionSequence" | "currentRevisionSequence"> & {
  claimRevisionSequence: string;
  currentRevisionSequence: string | null;
};

export type ResearchQuestionAnswerBrowserSynthesisContext = Omit<ResearchQuestionAnswerSnapshot["synthesisContexts"][number], "synthesisRevisionSequence" | "currentRevisionSequence"> & {
  synthesisRevisionSequence: string;
  currentRevisionSequence: string | null;
};

export type ResearchQuestionAnswerBrowserSnapshotValue = Omit<ResearchQuestionAnswerSnapshot, "sequence" | "claimContexts" | "synthesisContexts"> & {
  sequence: string;
  claimContexts: ResearchQuestionAnswerBrowserClaimContext[];
  synthesisContexts: ResearchQuestionAnswerBrowserSynthesisContext[];
};

export interface ResearchQuestionAnswerBrowserSnapshot {
  project: { id: string; title: string };
  question: { id: string; identifier: string };
  traceabilityEpoch: string;
  snapshot: ResearchQuestionAnswerBrowserSnapshotValue;
}
