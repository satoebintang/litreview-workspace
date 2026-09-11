export type ProjectId = string;
export type PaperId = string;
export type EvidenceId = string;
export type EvidenceReviewDecisionId = string;
export type EvidenceAnnotationId = string;
export type EvidenceLabelId = string;
export type EvidenceLabelEventId = string;
export type EvidenceSetId = string;
export type EvidenceSetMembershipId = string;
export type EvidenceSetCompositionRevisionId = string;
export type EvidenceSetAnnotationId = string;
export type SynthesisPreparationId = string;
export type ExtractionFieldId = string;
export type FullTextDocumentId = string;
export type DocumentTextExtractionId = string;
export type ClaimId = string;
export type ClaimRevisionId = string;
export type ManuscriptId = string;
export type ManuscriptSectionId = string;
export type ManuscriptSectionItemId = string;
export type ManuscriptClaimPlacementId = string;
export type ManuscriptPlacementEventId = string;
export type ScreeningCriterionId = string;
export type ScreeningDecisionId = string;
export type FullTextScreeningCriterionId = string;
export type FullTextScreeningDecisionId = string;
export type FullTextRetrievalAttemptId = string;
export type ResearchQuestionId = string;
export type SearchSourceId = string;
export type SearchStrategyId = string;
export type SearchRunId = string;
export type RetrievedRecordId = string;
export type RetrievedRecordMatchId = string;
export type ScreeningState = "unscreened" | "included" | "excluded" | "maybe";
export type ScreeningDecisionValue = "include" | "exclude" | "maybe";
export type ScreeningCriterionType = "inclusion" | "exclusion";
export type FullTextDecisionState = "not_started" | "included" | "excluded" | "maybe";
export type FullTextRetrievalOutcome = "pending" | "unavailable" | "retrieved";
export type FullTextRetrievalState = "not_sought" | FullTextRetrievalOutcome;
export type FullTextRetrievalMethod = "publisher" | "bibliographic_database" | "institutional_access" | "library" | "interlibrary_loan" | "author_contact" | "web" | "manual" | "other";
export type FullTextDocumentMediaType = "application/pdf";
export type FinalEligibility = "title_abstract_pending" | "title_abstract_unresolved" | "not_eligible" | "pending_full_text" | "included" | "excluded" | "unresolved_full_text";
export type PaperReviewWarning = "cross_stage_conflict" | "legacy_analysis_precedes_full_text_screening" | "legacy_full_text_decision_without_retrieval_record" | "retrieval_history_without_current_title_abstract_inclusion";
export type ExtractionFieldType = "short_text" | "long_text" | "number" | "boolean" | "single_select";
export type ExtractionValueState = "present" | "not_reported" | "not_applicable" | "cleared";
export type EvidenceReviewDecisionValue = "needs_review" | "accepted" | "rejected";
export type EvidenceReviewState = "unreviewed" | EvidenceReviewDecisionValue;
export type EvidenceLabelEventType = "assigned" | "removed";
export type EvidenceSetCompositionOperationKind = "created" | "added" | "readded" | "removed" | "reordered";

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
export type SearchRunStatus = "completed" | "failed";
export type RetrievedRecordMatchAction = "linked" | "unlinked";
export type ManuscriptWarningCode = "unsupported_claim_revision" | "superseded_claim_revision" | "withdrawn_parent_claim" | "no_citation_candidates" | "incomplete_bibliography";
export type DocumentTextExtractionStatus = "succeeded" | "partial" | "failed";
export type DocumentTextExtractionPageStatus = "succeeded" | "failed";

export interface Project {
  id: ProjectId;
  title: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResearchQuestion {
  id: ResearchQuestionId;
  projectId: ProjectId;
  identifier: string;
  label: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface SearchSource {
  id: SearchSourceId;
  projectId: ProjectId;
  sourceKey: string;
  displayName: string;
  baseUrl: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface SearchStrategy {
  id: SearchStrategyId;
  projectId: ProjectId;
  searchSourceId: SearchSourceId;
  name: string;
  queryText: string;
  filtersText: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface SearchRun {
  id: SearchRunId;
  sequence: number;
  projectId: ProjectId;
  searchSourceId: SearchSourceId;
  sourceKeySnapshot: string;
  sourceDisplayNameSnapshot: string;
  strategyId: SearchStrategyId;
  queryText: string;
  filtersTextSnapshot: string | null;
  reportedResultCount: number;
  executedAt: Date;
  notes: string | null;
  createdAt: Date;
}

export interface RetrievedRecord {
  id: RetrievedRecordId;
  projectId: ProjectId;
  searchRunId: SearchRunId;
  searchSourceId: SearchSourceId;
  sourceRecordId: string | null;
  title: string;
  authors: string[];
  abstract: string | null;
  doi: string | null;
  url: string | null;
  publicationYear: number | null;
  venue: string | null;
  retrievedAt: Date;
  rawCitation: string | null;
  createdAt: Date;
}

export interface RetrievedRecordMatch {
  id: RetrievedRecordMatchId;
  sequence: number;
  projectId: ProjectId;
  retrievedRecordId: RetrievedRecordId;
  paperId: PaperId;
  action: RetrievedRecordMatchAction;
  createdAt: Date;
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
  fullTextDocumentId: FullTextDocumentId | null;
  documentTextExtractionId: DocumentTextExtractionId | null;
  document?: FullTextDocumentSummary | null;
  sourceText: string;
  pageNumber: number;
  extractionStartOffset: number | null;
  extractionEndOffset: number | null;
  note: string | null;
  reviewState?: EvidenceReviewState;
  curationWarning?: "never_reviewed" | "needs_review" | "currently_rejected" | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EvidenceReviewDecision {
  id: EvidenceReviewDecisionId;
  sequence: number;
  projectId: ProjectId;
  evidenceId: EvidenceId;
  decision: EvidenceReviewDecisionValue;
  note: string | null;
  createdAt: Date;
}

export interface EvidenceAnnotation {
  id: EvidenceAnnotationId;
  sequence: number;
  projectId: ProjectId;
  evidenceId: EvidenceId;
  body: string;
  createdAt: Date;
}

export interface EvidenceLabel {
  id: EvidenceLabelId;
  projectId: ProjectId;
  name: string;
  description: string | null;
  createdAt: Date;
  archivedAt: Date | null;
}

export interface EvidenceLabelEvent {
  id: EvidenceLabelEventId;
  sequence: number;
  projectId: ProjectId;
  evidenceId: EvidenceId;
  labelId: EvidenceLabelId;
  event: EvidenceLabelEventType;
  createdAt: Date;
}

export interface EvidenceSet {
  id: EvidenceSetId;
  projectId: ProjectId;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface EvidenceSetMembership {
  id: EvidenceSetMembershipId;
  projectId: ProjectId;
  evidenceSetId: EvidenceSetId;
  evidenceId: EvidenceId;
  createdAt: Date;
}

export interface EvidenceSetCompositionRevision {
  id: EvidenceSetCompositionRevisionId;
  sequence: number;
  projectId: ProjectId;
  evidenceSetId: EvidenceSetId;
  operationKind: EvidenceSetCompositionOperationKind;
  createdAt: Date;
}

export interface EvidenceSetCompositionMember {
  projectId: ProjectId;
  evidenceSetId: EvidenceSetId;
  compositionRevisionId: EvidenceSetCompositionRevisionId;
  membershipId: EvidenceSetMembershipId;
  sortOrder: number;
}

export interface EvidenceSetAnnotation {
  id: EvidenceSetAnnotationId;
  sequence: number;
  projectId: ProjectId;
  evidenceSetId: EvidenceSetId;
  body: string;
  createdAt: Date;
}

export interface DocumentTextExtractionPage {
  extractionId: DocumentTextExtractionId;
  pageNumber: number;
  status: DocumentTextExtractionPageStatus;
  text: string;
  characterCount: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface DocumentTextExtraction {
  id: DocumentTextExtractionId;
  projectId: ProjectId;
  paperId: PaperId;
  fullTextDocumentId: FullTextDocumentId;
  sequence: number;
  extractorKey: string;
  extractorVersion: string;
  algorithmVersion: string;
  status: DocumentTextExtractionStatus;
  pageCount: number | null;
  characterCount: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
  pages?: DocumentTextExtractionPage[];
}

export interface FullTextDocument {
  id: FullTextDocumentId;
  projectId: ProjectId;
  paperId: PaperId;
  storageKey: string;
  originalFilename: string;
  mediaType: FullTextDocumentMediaType;
  byteSize: number;
  sha256: string;
  note: string | null;
  createdAt: Date;
  archivedAt: Date | null;
}

export interface FullTextDocumentSummary {
  id: FullTextDocumentId;
  originalFilename: string;
  mediaType: FullTextDocumentMediaType;
  byteSize: number;
  sha256: string;
  createdAt: Date;
  archivedAt: Date | null;
}

export interface PaperFullTextPreference {
  projectId: ProjectId;
  paperId: PaperId;
  fullTextDocumentId: FullTextDocumentId;
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
  document?: FullTextDocumentSummary | null;
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

export interface FullTextScreeningCriterion {
  id: FullTextScreeningCriterionId;
  projectId: ProjectId;
  text: string;
  sortOrder: number;
  createdAt: Date;
  archivedAt: Date | null;
}

export interface FullTextScreeningDecision {
  id: FullTextScreeningDecisionId;
  sequence: number;
  projectId: ProjectId;
  paperId: PaperId;
  decision: ScreeningDecisionValue;
  exclusionCriterionId: FullTextScreeningCriterionId | null;
  note: string | null;
  createdAt: Date;
}

export interface FullTextScreeningHistoryItem extends FullTextScreeningDecision {
  exclusionCriterion: FullTextScreeningCriterion | null;
}

export interface FullTextRetrievalAttempt {
  id: FullTextRetrievalAttemptId;
  sequence: number;
  projectId: ProjectId;
  paperId: PaperId;
  outcome: FullTextRetrievalOutcome;
  method: FullTextRetrievalMethod | null;
  sourceReference: string | null;
  note: string | null;
  attemptedAt: Date;
  createdAt: Date;
}

export interface PaperReviewStatus {
  titleAbstractState: ScreeningState;
  fullTextState: FullTextDecisionState;
  fullTextRetrievalState: FullTextRetrievalState;
  everRetrieved: boolean;
  finalEligibility: FinalEligibility;
  crossStageConflict: boolean;
  warnings: PaperReviewWarning[];
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

export type SynthesisPreparationStatus = "active" | "finalized" | "abandoned";

export interface SynthesisPreparation {
  id: SynthesisPreparationId;
  projectId: ProjectId;
  evidenceSetId: EvidenceSetId;
  evidenceSetCompositionRevisionId: EvidenceSetCompositionRevisionId;
  extractionFieldId: ExtractionFieldId;
  workingTitle: string | null;
  workingNote: string | null;
  targetSynthesisStatementId: string | null;
  status: SynthesisPreparationStatus;
  finalizedSynthesisRevisionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  finalizedAt: Date | null;
  abandonedAt: Date | null;
}

export interface SynthesisPreparationSelection {
  projectId: ProjectId;
  preparationId: SynthesisPreparationId;
  extractionRevisionId: string;
  createdAt: Date;
}

export interface SynthesisCandidateConnectingEvidence {
  membershipId: EvidenceSetMembershipId;
  membershipOrder: number;
  evidenceId: EvidenceId;
  sourceText: string;
  pageNumber: number;
  document?: FullTextDocumentSummary | null;
  curationState: EvidenceReviewState;
  curationWarning?: "never_reviewed" | "needs_review" | "currently_rejected" | null;
}

export type SynthesisCandidateWarning =
  | "underlying_evidence_unreviewed"
  | "underlying_evidence_needs_review"
  | "underlying_evidence_rejected"
  | "paper_not_finally_included"
  | "extraction_revision_superseded"
  | "extraction_revision_cleared";

export interface SynthesisCandidate {
  extractionRevision: ExtractionRevisionWithEvidence;
  paper: Paper;
  paperScreeningState: string;
  isFinallyIncluded: boolean;
  isCurrentExtractionRevision: boolean;
  connectingEvidence: SynthesisCandidateConnectingEvidence[];
  selected: boolean;
  selectable: boolean;
  eligibilityReasons: string[];
  warnings: SynthesisCandidateWarning[];
}

export interface SynthesisPreparationSummary {
  id: SynthesisPreparationId;
  projectId: ProjectId;
  evidenceSetId: EvidenceSetId;
  evidenceSetName: string;
  evidenceSetArchivedAt: Date | null;
  evidenceSetCompositionRevisionId: EvidenceSetCompositionRevisionId;
  pinnedCompositionSequence: number;
  extractionFieldId: ExtractionFieldId;
  extractionFieldName: string;
  extractionFieldType: ExtractionFieldType;
  workingTitle: string | null;
  workingNote: string | null;
  targetSynthesisStatementId: string | null;
  status: SynthesisPreparationStatus;
  finalizedSynthesisRevisionId: string | null;
  sourceSetChanged: boolean;
  candidateCount: number;
  selectedCount: number;
  createdAt: Date;
  updatedAt: Date;
  finalizedAt: Date | null;
  abandonedAt: Date | null;
}

export interface SynthesisPreparationWorkspace {
  preparation: SynthesisPreparation;
  evidenceSet: EvidenceSet;
  pinnedCompositionSequence: number;
  latestCompositionSequence: number;
  sourceSetChanged: boolean;
  field: ExtractionField;
  targetStatement: SynthesisStatement | null;
  currentTargetRevision: SynthesisRevision | null;
  finalizedRevision: SynthesisRevision | null;
  candidateCount: number;
  selectedCount: number;
  candidates: SynthesisCandidate[];
}

export interface SynthesisPreparationContext {
  preparationId: SynthesisPreparationId;
  evidenceSetId: EvidenceSetId;
  evidenceSetName: string;
  evidenceSetArchivedAt: Date | null;
  pinnedCompositionRevisionId: EvidenceSetCompositionRevisionId;
  pinnedCompositionSequence: number;
  finalizedAt: Date;
}

export interface CreateSynthesisPreparationInput {
  evidenceSetId: string;
  extractionFieldId: string;
  workingTitle?: string | null;
  workingNote?: string | null;
}

export interface UpdateSynthesisPreparationInput {
  workingTitle?: string | null;
  workingNote?: string | null;
  targetSynthesisStatementId?: string | null;
}

export interface ReplaceSynthesisPreparationSelectionsInput {
  extractionRevisionIds: string[];
}

export interface FinalizeSynthesisPreparationInput {
  title?: string | null;
  statementText: string;
  researcherNote?: string | null;
}

export type ConvergenceState = "convergent" | "mixed" | "contradictory" | "inconclusive";

export type LimitationCategory =
  | "methodological"
  | "population"
  | "measurement"
  | "generalizability"
  | "missing_data"
  | "heterogeneity"
  | "reporting"
  | "other";

export type EvidenceCurationWarning = "never_reviewed" | "needs_review" | "currently_rejected" | null;

export interface SynthesisInterpretationLimitation {
  id: string;
  projectId: ProjectId;
  interpretationId: string;
  sortOrder: number;
  category: LimitationCategory;
  body: string;
  createdAt: Date;
}

export interface SynthesisInterpretationQuestion {
  id: string;
  projectId: ProjectId;
  interpretationId: string;
  sortOrder: number;
  body: string;
  createdAt: Date;
}

export interface SynthesisInterpretationContradiction {
  id: string;
  projectId: ProjectId;
  interpretationId: string;
  synthesisRevisionId: string;
  sortOrder: number;
  leftExtractionRevisionId: string;
  rightExtractionRevisionId: string;
  note: string | null;
  createdAt: Date;
}

export interface SynthesisInterpretationSnapshot {
  id: string;
  sequence: number;
  projectId: ProjectId;
  synthesisStatementId: string;
  synthesisRevisionId: string;
  convergenceState: ConvergenceState;
  summary: string;
  researcherNote: string | null;
  createdAt: Date;
  finalizedAt: Date;
  limitations: SynthesisInterpretationLimitation[];
  questions: SynthesisInterpretationQuestion[];
  contradictions: SynthesisInterpretationContradiction[];
}

export interface AppendSynthesisInterpretationLimitationInput {
  category: LimitationCategory;
  body: string;
}

export interface AppendSynthesisInterpretationQuestionInput {
  body: string;
}

export interface AppendSynthesisInterpretationContradictionInput {
  leftExtractionRevisionId: string;
  rightExtractionRevisionId: string;
  note?: string | null;
}

export interface AppendSynthesisInterpretationInput {
  convergenceState: ConvergenceState;
  summary: string;
  researcherNote?: string | null;
  limitations?: AppendSynthesisInterpretationLimitationInput[];
  questions?: AppendSynthesisInterpretationQuestionInput[];
  contradictions?: AppendSynthesisInterpretationContradictionInput[];
}

export interface SynthesisInterpretationContradictionView extends SynthesisInterpretationContradiction {
  leftSupport: SynthesisSupport | null;
  rightSupport: SynthesisSupport | null;
}

export interface SynthesisInterpretationSnapshotView extends Omit<SynthesisInterpretationSnapshot, "contradictions"> {
  contradictions: SynthesisInterpretationContradictionView[];
}

export interface SynthesisInterpretationProjection {
  revision: SynthesisRevisionView;
  currentInterpretation: SynthesisInterpretationSnapshotView | null;
  history: SynthesisInterpretationSnapshotView[];
  supportsLookup: Record<string, SynthesisSupport>;
  evidenceWarnings: {
    evidenceId: string;
    warning: EvidenceCurationWarning;
  }[];
}

export interface CreateClaimWithSynthesisSupportInput {
  claimText: string;
  researcherNote?: string | null;
  synthesisRevisionId: string;
}

export interface CreateClaimFromInterpretationInput {
  interpretationId: string;
  synthesisRevisionId?: string;
  claimText: string;
  researcherNote?: string | null;
}
