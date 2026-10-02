import type {
  FullTextRetrievalOutcome,
  FullTextRetrievalMethod,
  Paper,
  PaperReviewStatus,
  ScreeningDecisionValue,
  ScreeningCriterionType,
} from "@/domain/types";

export const SCREENING_HISTORY_DEFAULT_PAGE_SIZE = 20;
export const SCREENING_HISTORY_MAX_PAGE_SIZE = 50;
export const SCREENING_HISTORY_CURSOR_MAX_LENGTH = 512;

export const screeningHistoryTypes = [
  "title-abstract-decision",
  "full-text-decision",
  "full-text-retrieval-attempt",
] as const;

export type ScreeningHistoryType = typeof screeningHistoryTypes[number];

export type ScreeningHistoryCursor = {
  v: 1;
  projectId: string;
  paperId: string;
  historyType: ScreeningHistoryType;
  pageSize: number;
  lastSequence: string;
  lastEventId: string;
};

export type ScreeningHistoryPageOptions = {
  pageSize?: number;
  cursor?: string | null;
};

export type ScreeningHistoryPage<T> = {
  items: T[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
  currentEvent: CompactScreeningEvent | CompactRetrievalEvent | null;
};

export type CompactScreeningEvent = {
  id: string;
  sequence: string;
  decision: ScreeningDecisionValue;
};

export type CompactRetrievalEvent = {
  id: string;
  sequence: string;
  outcome: FullTextRetrievalOutcome;
};

export type ScreeningDecisionHistoryItem = {
  id: string;
  sequence: string;
  decision: ScreeningDecisionValue;
  exclusionCriterion: {
    id: string;
    type: ScreeningCriterionType | null;
    text: string;
    archivedAt: Date | null;
  } | null;
  criterionTextTruncated: boolean;
  note: string | null;
  noteTruncated: boolean;
  createdAt: Date;
  isCurrent: boolean;
};

export type FullTextScreeningDecisionHistoryItem = {
  id: string;
  sequence: string;
  decision: ScreeningDecisionValue;
  exclusionCriterion: {
    id: string;
    text: string;
    archivedAt: Date | null;
  } | null;
  criterionTextTruncated: boolean;
  note: string | null;
  noteTruncated: boolean;
  createdAt: Date;
  isCurrent: boolean;
};

export type FullTextRetrievalHistoryItem = {
  id: string;
  sequence: string;
  outcome: FullTextRetrievalOutcome;
  method: FullTextRetrievalMethod | null;
  attemptedAt: Date;
  sourceReference: string | null;
  sourceReferenceTruncated: boolean;
  note: string | null;
  noteTruncated: boolean;
  createdAt: Date;
  isCurrent: boolean;
};

export type ScreeningDecisionEvent = {
  id: string;
  sequence: string;
  projectId: string;
  paperId: string;
  decision: ScreeningDecisionValue;
  exclusionCriterion: {
    id: string;
    type: ScreeningCriterionType | null;
    text: string;
    archivedAt: Date | null;
  } | null;
  note: string | null;
  createdAt: Date;
};

export type FullTextScreeningDecisionEvent = {
  id: string;
  sequence: string;
  projectId: string;
  paperId: string;
  decision: ScreeningDecisionValue;
  exclusionCriterion: {
    id: string;
    text: string;
    archivedAt: Date | null;
  } | null;
  note: string | null;
  createdAt: Date;
};

export type FullTextRetrievalAttemptEvent = {
  id: string;
  sequence: string;
  projectId: string;
  paperId: string;
  outcome: FullTextRetrievalOutcome;
  method: FullTextRetrievalMethod | null;
  sourceReference: string | null;
  note: string | null;
  attemptedAt: Date;
  createdAt: Date;
};

export type ScreeningHistoryRouteContext = {
  projectId: string;
  paperId: string;
  title: string;
  currentEvent: CompactScreeningEvent | CompactRetrievalEvent | null;
  everRetrieved: boolean;
};

export type ScreeningHistoryRoutePage<T> = ScreeningHistoryRouteContext & ScreeningHistoryPage<T>;

export type ScreeningPaperDetail = {
  paper: Paper;
  reviewStatus: PaperReviewStatus;
  currentEvent: CompactScreeningEvent | null;
  history: ScreeningHistoryPage<ScreeningDecisionHistoryItem>;
  criteria: Array<{ id: string; projectId: string; type: ScreeningCriterionType; text: string; sortOrder: number; createdAt: Date; archivedAt: Date | null }>;
  navigation: { paperId: string; position: number; totalCount: number; previousPaperId: string | null; nextPaperId: string | null };
};

export type FullTextScreeningPaperDetail = {
  paper: Paper;
  reviewStatus: PaperReviewStatus;
  currentEvent: CompactScreeningEvent | null;
  retrievalCurrent: CompactRetrievalEvent | null;
  history: ScreeningHistoryPage<FullTextScreeningDecisionHistoryItem>;
  retrievalHistory: ScreeningHistoryPage<FullTextRetrievalHistoryItem>;
  criteria: Array<{ id: string; projectId: string; text: string; sortOrder: number; createdAt: Date; archivedAt: Date | null }>;
};

export type FullTextRetrievalPaperDetail = {
  paper: Paper;
  reviewStatus: PaperReviewStatus;
  currentAttempt: CompactRetrievalEvent | null;
  currentState: PaperReviewStatus["fullTextRetrievalState"];
  everRetrieved: boolean;
  history: ScreeningHistoryPage<FullTextRetrievalHistoryItem>;
};

export type ScreeningHistoryPageRead<T> = {
  route: ScreeningHistoryRouteContext;
  page: ScreeningHistoryPage<T>;
};

export type ScreeningHistoryExactRead<T> = {
  route: ScreeningHistoryRouteContext;
  event: T;
};
