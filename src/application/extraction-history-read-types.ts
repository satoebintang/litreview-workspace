import type { Evidence, ExtractionFieldType, ExtractionValueState, PaperId, ProjectId } from "@/domain/types";

export const EXTRACTION_HISTORY_DEFAULT_PAGE_SIZE = 20;
export const EXTRACTION_HISTORY_MAX_PAGE_SIZE = 50;
export const EXTRACTION_HISTORY_CURSOR_MAX_LENGTH = 512;
export const EXTRACTION_HISTORY_TYPE = "extraction-value-revision" as const;

export type ExtractionHistoryCursor = {
  v: 1;
  projectId: string;
  paperId: string;
  fieldId: string;
  extractionValueId: string;
  historyType: typeof EXTRACTION_HISTORY_TYPE;
  pageSize: number;
  lastSequence: string;
  lastRevisionId: string;
};

export type ExtractionHistoryPageOptions = {
  pageSize?: number;
  cursor?: string | null;
};

export type ExtractionHistoryFieldContext = {
  id: string;
  namePreview: string;
  nameTruncated: boolean;
  fieldType: ExtractionFieldType;
  archivedAt: Date | null;
  extractionValueId: string | null;
};

export type CurrentExtractionRevisionIdentity = {
  id: string;
  sequence: string;
};

export type ExtractionRevisionHistoryItem = {
  id: string;
  sequence: string;
  fieldType: ExtractionFieldType;
  valueState: ExtractionValueState;
  textValuePreview: string | null;
  textValueTruncated: boolean;
  numberValue: string | null;
  booleanValue: boolean | null;
  optionId: string | null;
  optionLabelPreview: string | null;
  optionLabelTruncated: boolean;
  optionArchivedAt: Date | null;
  researcherNotePreview: string | null;
  researcherNoteTruncated: boolean;
  createdAt: Date;
  finalizedAt: Date;
  evidenceCount: string;
  supportStatus: "grounded" | "ungrounded";
  isCurrent: boolean;
  href: string;
};

export type ExtractionRevisionHistoryPage = {
  field: ExtractionHistoryFieldContext;
  items: ExtractionRevisionHistoryItem[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
  current: CurrentExtractionRevisionIdentity | null;
};

export type ExactExtractionRevision = {
  id: string;
  sequence: string;
  projectId: ProjectId;
  paperId: PaperId;
  fieldId: string;
  extractionValueId: string;
  fieldType: ExtractionFieldType;
  valueState: ExtractionValueState;
  textValue: string | null;
  numberValue: string | null;
  booleanValue: boolean | null;
  optionId: string | null;
  researcherNote: string | null;
  createdAt: Date;
  finalizedAt: Date;
  optionLabel: string | null;
  optionArchivedAt: Date | null;
  evidence: Array<Evidence & {
    reviewState: "unreviewed" | "needs_review" | "accepted" | "rejected";
    curationWarning: "never_reviewed" | "needs_review" | "currently_rejected" | null;
  }>;
};

export type ExactExtractionRevisionAudit = {
  projectId: ProjectId;
  paper: { id: PaperId; title: string };
  field: { id: string; name: string; fieldType: ExtractionFieldType; archivedAt: Date | null };
  revision: ExactExtractionRevision;
  isCurrentRevision: boolean;
};
