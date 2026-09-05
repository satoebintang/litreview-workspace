export type ProjectId = string;
export type PaperId = string;
export type EvidenceId = string;
export type ClaimId = string;
export type ScreeningCriterionId = string;
export type ScreeningDecisionId = string;
export type ScreeningState = "unscreened" | "included" | "excluded" | "maybe";
export type ScreeningDecisionValue = "include" | "exclude" | "maybe";
export type ScreeningCriterionType = "inclusion" | "exclusion";
export type ExtractionFieldType = "short_text" | "long_text" | "number" | "boolean" | "single_select";
export type ExtractionValueState = "present" | "not_reported" | "not_applicable" | "cleared";

export type SupportStatus = "supported" | "unsupported";

export interface Project {
  id: ProjectId;
  title: string;
  description: string | null;
  researchQuestion: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Paper {
  id: PaperId;
  projectId: ProjectId;
  title: string;
  authors: string[];
  publicationYear: number | null;
  venue: string | null;
  doi: string | null;
  abstract: string | null;
  bibliographicNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Evidence {
  id: EvidenceId;
  projectId: ProjectId;
  paperId: PaperId;
  sourceText: string;
  pageNumber: number;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Claim {
  id: ClaimId;
  projectId: ProjectId;
  claimText: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClaimEvidenceLink {
  projectId: ProjectId;
  claimId: ClaimId;
  evidenceId: EvidenceId;
  createdAt: Date;
}

export interface EvidenceWithPaper {
  evidence: Evidence;
  paper: Paper;
}

export interface ClaimProvenance {
  claim: Claim;
  supportStatus: SupportStatus;
  evidence: EvidenceWithPaper[];
}

export interface ScreeningCriterion {
  id: ScreeningCriterionId;
  projectId: ProjectId;
  type: ScreeningCriterionType;
  text: string;
  sortOrder: number;
  createdAt: Date;
  archivedAt: Date | null;
}

export interface ScreeningDecision {
  id: ScreeningDecisionId;
  sequence: number;
  projectId: ProjectId;
  paperId: PaperId;
  stage: "title_abstract";
  decision: ScreeningDecisionValue;
  exclusionCriterionId: ScreeningCriterionId | null;
  exclusionCriterionType: "exclusion" | null;
  note: string | null;
  createdAt: Date;
}

export interface ScreeningHistoryItem extends ScreeningDecision {
  exclusionCriterion: ScreeningCriterion | null;
}

export interface PaperWithScreening extends Paper {
  screeningState: ScreeningState;
  currentDecision: ScreeningDecision | null;
}

export interface ExtractionField {
  id: string;
  projectId: ProjectId;
  name: string;
  description: string | null;
  fieldType: ExtractionFieldType;
  required: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface ExtractionOption {
  id: string;
  projectId: ProjectId;
  fieldId: string;
  label: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface ExtractionValue {
  id: string;
  projectId: ProjectId;
  paperId: PaperId;
  fieldId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExtractionRevision {
  id: string;
  sequence: number;
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
  finalizedAt: Date | null;
}

export interface ExtractionRevisionWithEvidence extends ExtractionRevision {
  evidence: Evidence[];
}

export type ExtractionSupportStatus = "grounded" | "ungrounded";

export interface ExtractionValueCurrent extends ExtractionValue {
  field: ExtractionField;
  currentRevision: ExtractionRevisionWithEvidence | null;
  supportStatus: ExtractionSupportStatus;
}
