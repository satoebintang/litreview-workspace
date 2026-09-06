export type ProjectId = string;
export type PaperId = string;
export type EvidenceId = string;
export type ClaimId = string;
export type ClaimRevisionId = string;
export type ManuscriptId = string;
export type ManuscriptSectionId = string;
export type ManuscriptSectionItemId = string;
export type ManuscriptClaimPlacementId = string;
export type ManuscriptPlacementEventId = string;
export type ScreeningCriterionId = string;
export type ScreeningDecisionId = string;
export type ScreeningState = "unscreened" | "included" | "excluded" | "maybe";
export type ScreeningDecisionValue = "include" | "exclude" | "maybe";
export type ScreeningCriterionType = "inclusion" | "exclusion";
export type ExtractionFieldType = "short_text" | "long_text" | "number" | "boolean" | "single_select";
export type ExtractionValueState = "present" | "not_reported" | "not_applicable" | "cleared";

export type SupportStatus = "supported" | "unsupported";
export type ClaimLifecycle = "active" | "withdrawn";
export type ClaimSupportKind = "evidence" | "extractionRevision" | "synthesisRevision";
export type ClaimRevisionSupportStatus = "supported" | "unsupported";
export type SynthesisState = "active" | "withdrawn";
export type SynthesisSupportStatus = "supported" | "unsupported";
export type ManuscriptSectionType = "introduction" | "methods" | "results" | "discussion" | "limitations" | "conclusion" | "custom";
export type ManuscriptPlacementEventType = "placed" | "replaced" | "removed";
export type ManuscriptSectionItemType = "claim" | "prose";
export type CitationStyle = "numeric" | "author_year";
export type ManuscriptWarningCode = "unsupported_claim_revision" | "superseded_claim_revision" | "withdrawn_parent_claim" | "no_citation_candidates" | "incomplete_bibliography";

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
  createdAt: Date;
}

export interface ClaimRevision {
  id: ClaimRevisionId;
  sequence: number;
  projectId: ProjectId;
  claimId: ClaimId;
  lifecycle: ClaimLifecycle;
  claimText: string | null;
  researcherNote: string | null;
  createdAt: Date;
  finalizedAt: Date | null;
}

export interface ClaimRevisionEvidenceSupport {
  projectId: ProjectId;
  claimRevisionId: ClaimRevisionId;
  evidenceId: EvidenceId;
  createdAt: Date;
  evidence: EvidenceWithPaper;
}

export interface ClaimRevisionExtractionSupport {
  projectId: ProjectId;
  claimRevisionId: ClaimRevisionId;
  extractionRevisionId: string;
  createdAt: Date;
  extractionRevision: ExtractionRevisionWithEvidence;
  paper: Paper;
  field: ExtractionField;
  isCurrentExtractionRevision: boolean;
  paperScreeningState: ScreeningState;
}

export interface ClaimRevisionSynthesisSupport {
  projectId: ProjectId;
  claimRevisionId: ClaimRevisionId;
  synthesisRevisionId: string;
  createdAt: Date;
  synthesisRevision: SynthesisRevisionView;
  statement: SynthesisStatement;
  isCurrentSynthesisRevision: boolean;
  statementLifecycle: SynthesisState;
}

export interface CitationCandidate {
  paper: Paper;
  pathCount: number;
  supportKinds: ClaimSupportKind[];
  paths?: string[];
}

export interface ClaimRevisionView extends ClaimRevision {
  supportStatus: ClaimRevisionSupportStatus;
  supports: {
    evidence: ClaimRevisionEvidenceSupport[];
    extractionRevisions: ClaimRevisionExtractionSupport[];
    synthesisRevisions: ClaimRevisionSynthesisSupport[];
  };
  totalSupportCount: number;
  directEvidenceCount: number;
  extractionRevisionCount: number;
  synthesisRevisionCount: number;
  distinctPaperCount: number;
  citationCandidateCount: number;
  citationCandidates: CitationCandidate[];
}

/** A structured manuscript container. Manuscripts are intentionally separate
 * from Project so that alternate drafts can be added without changing the
 * Project identity model. */
export interface Manuscript {
  id: ManuscriptId;
  projectId: ProjectId;
  title: string;
  isDefault: boolean;
  citationStyle: CitationStyle;
  createdAt: Date;
  updatedAt: Date;
}

export interface ManuscriptSection {
  id: ManuscriptSectionId;
  projectId: ProjectId;
  manuscriptId: ManuscriptId;
  title: string;
  sectionType: ManuscriptSectionType;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

/** The placement's claimRevisionId is the historical content identity. It is
 * never resolved dynamically to the stable Claim's latest revision. */
export interface ManuscriptClaimPlacement {
  id: ManuscriptClaimPlacementId;
  projectId: ProjectId;
  manuscriptId: ManuscriptId;
  sectionId: ManuscriptSectionId;
  claimId: ClaimId;
  claimRevisionId: ClaimRevisionId;
  createdAt: Date;
  removedAt: Date | null;
}

export interface ManuscriptSectionItem {
  id: ManuscriptSectionItemId;
  projectId: ProjectId;
  manuscriptId: ManuscriptId;
  sectionId: ManuscriptSectionId;
  itemType: ManuscriptSectionItemType;
  sortOrder: number;
  createdAt: Date;
  removedAt: Date | null;
}

export interface ManuscriptProseBlock extends ManuscriptSectionItem {
  itemType: "prose";
  text: string;
  updatedAt: Date;
}

export interface ManuscriptPlacementEvent {
  id: ManuscriptPlacementEventId;
  sequence: number;
  projectId: ProjectId;
  manuscriptId: ManuscriptId;
  sectionId: ManuscriptSectionId;
  placementId: ManuscriptClaimPlacementId;
  claimId: ClaimId;
  eventType: ManuscriptPlacementEventType;
  fromClaimRevisionId: ClaimRevisionId | null;
  toClaimRevisionId: ClaimRevisionId | null;
  occurredAt: Date;
}

/** Citation candidate with its derived number in one manuscript projection. */
export interface ManuscriptCitationCandidate extends CitationCandidate {
  citationNumber: number;
  firstOccurrence: {
    sectionId: ManuscriptSectionId;
    sectionItemId: ManuscriptSectionItemId;
    placementId: ManuscriptClaimPlacementId;
    claimRevisionId: ClaimRevisionId;
  };
}

export interface ManuscriptClaimCitationCandidate extends CitationCandidate {
  citationNumber: number;
}

export interface ManuscriptClaimPlacementView extends ManuscriptClaimPlacement {
  claim: Claim;
  claimRevision: ClaimRevision;
  latestClaimRevisionId: ClaimRevisionId;
  claimLifecycle: ClaimLifecycle;
  supportStatus: ClaimRevisionSupportStatus;
  isCurrentClaimRevision: boolean;
  isSuperseded: boolean;
  citationCandidates: ManuscriptClaimCitationCandidate[];
  citationNumbers: number[];
}

export interface ManuscriptClaimItemView extends ManuscriptSectionItem {
  itemType: "claim";
  placement: ManuscriptClaimPlacementView;
  citationCandidates: ManuscriptClaimCitationCandidate[];
  citationNumbers: number[];
}

export interface ManuscriptProseItemView extends ManuscriptSectionItem {
  itemType: "prose";
  text: string;
  updatedAt: Date;
}

export type ManuscriptSectionItemView = ManuscriptClaimItemView | ManuscriptProseItemView;

export interface ManuscriptBibliographyCandidate {
  paper: Paper;
  citationNumber: number;
  firstOccurrence: {
    sectionId: ManuscriptSectionId;
    sectionItemId: ManuscriptSectionItemId;
    placementId: ManuscriptClaimPlacementId;
    claimRevisionId: ClaimRevisionId;
  };
}

export interface ManuscriptWarning {
  code: ManuscriptWarningCode;
  message: string;
  sectionId?: ManuscriptSectionId;
  sectionItemId?: ManuscriptSectionItemId;
  placementId?: ManuscriptClaimPlacementId;
  claimId?: ClaimId;
  claimRevisionId?: ClaimRevisionId;
  paperId?: PaperId;
  metadataField?: "authors" | "publication_year" | "venue";
}

export interface ManuscriptCounts {
  sectionCount: number;
  activeItemCount: number;
  proseBlockCount: number;
  claimItemCount: number;
  placedClaimCount: number;
  unsupportedPlacedClaimCount: number;
  supersededPlacedClaimCount: number;
  withdrawnParentClaimCount: number;
  distinctCitationCandidatePaperCount: number;
}

export interface ManuscriptSectionView extends ManuscriptSection {
  items: ManuscriptSectionItemView[];
}

export interface ManuscriptView extends Manuscript {
  sections: ManuscriptSectionView[];
  bibliographyCandidates: ManuscriptBibliographyCandidate[];
  warnings: ManuscriptWarning[];
  counts: ManuscriptCounts;
}

export type ClaimHistoryItem = ClaimRevisionView;

export interface ClaimWorkspaceItem {
  claim: Claim;
  currentRevision: ClaimRevisionView;
  lifecycle: ClaimLifecycle;
  supportStatus: ClaimRevisionSupportStatus;
  citationCandidateCount: number;
  distinctPaperCount: number;
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

export interface SynthesisStatement {
  id: string;
  projectId: ProjectId;
  createdAt: Date;
}

export interface SynthesisRevision {
  id: string;
  sequence: number;
  projectId: ProjectId;
  synthesisStatementId: string;
  state: SynthesisState;
  title: string | null;
  statementText: string | null;
  researcherNote: string | null;
  createdAt: Date;
  finalizedAt: Date | null;
}

export interface SynthesisRevisionSupport {
  projectId: ProjectId;
  synthesisRevisionId: string;
  extractionRevisionId: string;
  createdAt: Date;
}

export interface SynthesisSupport extends SynthesisRevisionSupport {
  extractionRevision: ExtractionRevisionWithEvidence;
  paper: Paper;
  field: ExtractionField;
  isCurrentExtractionRevision: boolean;
}

export interface SynthesisRevisionView extends SynthesisRevision {
  supports: SynthesisSupport[];
  supportStatus: SynthesisSupportStatus;
  supportingRevisionCount: number;
  supportingPaperCount: number;
  supportingFieldCount: number;
}

export interface SynthesisProvenance extends SynthesisRevisionView {
  statement: SynthesisStatement;
}

export type ComparisonValueState = ExtractionValueState | "not_extracted";

export interface ExtractionComparisonRow {
  paper: Paper;
  field: ExtractionField;
  extractionRevision: ExtractionRevisionWithEvidence | null;
  valueState: ComparisonValueState;
  displayValue: string | null;
  supportStatus: ExtractionSupportStatus;
  isSelectable: boolean;
}

export interface ExtractionFieldSummary {
  field: ExtractionField;
  totalIncludedPapers: number;
  counts: Record<string, number>;
}
