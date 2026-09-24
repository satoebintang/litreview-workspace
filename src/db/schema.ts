import * as foundationSchema from "./schema/foundation";
import * as screeningSchema from "./schema/screening";
import * as documentsEvidenceSchema from "./schema/documents-evidence";
import * as evidenceSetsSchema from "./schema/evidence-sets";
import * as extractionSchema from "./schema/extraction";
import * as synthesisSchema from "./schema/synthesis";
import * as claimsSchema from "./schema/claims";
import * as manuscriptSchema from "./schema/manuscript";
import * as protocolSearchSchema from "./schema/protocol-search";
import * as researchQuestionSchema from "./schema/research-question";
import * as intakeSchema from "./schema/intake";
import * as aiExtractionSchema from "./schema/ai-extraction";
import * as aiSynthesisSchema from "./schema/ai-synthesis";
import * as appraisalSchema from "./schema/appraisal";

export { projects, papers } from "./schema/foundation";
export { fullTextDocuments, paperFullTextPreferences, documentTextExtractions, documentTextExtractionPages, evidence, evidenceReviewDecisions, evidenceAnnotations, evidenceLabels, evidenceLabelEvents } from "./schema/documents-evidence";
export { evidenceSets, evidenceSetMemberships, evidenceSetCompositionRevisions, evidenceSetCompositionMembers, evidenceSetAnnotations } from "./schema/evidence-sets";
export { claims, claimRevisions, claimRevisionEvidenceSupports } from "./schema/claims";
export { screeningCriteria, screeningDecisions, fullTextScreeningCriteria, fullTextScreeningDecisions, fullTextRetrievalAttempts } from "./schema/screening";
export { extractionFields, extractionOptions, extractionValues, extractionValueRevisions, extractionRevisionEvidence } from "./schema/extraction";
export { synthesisStatements, synthesisRevisions, synthesisRevisionSupports, synthesisPreparations, synthesisPreparationSelections, synthesisInterpretations, synthesisInterpretationLimitations, synthesisInterpretationQuestions, synthesisInterpretationContradictions } from "./schema/synthesis";
export { claimRevisionExtractionSupports, claimRevisionSynthesisSupports } from "./schema/claims";
export { manuscripts, manuscriptSections, manuscriptClaimPlacements, manuscriptSectionItems, manuscriptSectionItemClaims, manuscriptProseBlocks, manuscriptProseRevisions, manuscriptClaimPlacementEvents, manuscriptReviewThreads, manuscriptReviewEvents } from "./schema/manuscript";
export { researchQuestions, searchSources, searchStrategies, searchRuns, retrievedRecords, retrievedRecordMatches, retrievedRecordDeduplicationDecisions } from "./schema/protocol-search";
export { researchQuestionExtractionFieldEvents, researchQuestionEvidenceSetEvents, researchQuestionSynthesisStatementEvents, researchQuestionClaimEvents, researchQuestionAnswers, researchQuestionAnswerClaimContexts, researchQuestionAnswerSynthesisContexts } from "./schema/research-question";
export { manuscriptSnapshots, manuscriptSnapshotSections, manuscriptSnapshotItems, manuscriptSnapshotProseItems, manuscriptSnapshotClaimItems, manuscriptSnapshotBibliographyEntries, manuscriptSnapshotClaimBibliographyMembers, manuscriptSnapshotWarnings } from "./schema/manuscript";
export { aiExtractionRequests, aiExtractionRequestPages, aiExtractionDispatches, aiExtractionResults, aiExtractionResultGroundings, aiExtractionDecisions, aiExtractionDecisionEvidence, aiExtractionBatches, aiExtractionBatchItems } from "./schema/ai-extraction";
export { bibliographicImports, bibliographicImportRecords, bibliographicImportResolutions, pdfIntakes, pdfIntakeMetadataResults, pdfIntakeMetadataFields, pdfIntakeResolutions } from "./schema/intake";
export { aiSynthesisRequests, aiSynthesisRequestSupports, aiSynthesisRequestSources, aiSynthesisDispatches, aiSynthesisResults, aiSynthesisResultGroundings, aiSynthesisDecisions } from "./schema/ai-synthesis";
export { doiLookupRequests, bibliographicMetadataFetches, doiLookupDispatches, bibliographicMetadataFetchResults, bibliographicMetadataResultAuthors, doiLookupResolutions, bibliographicMetadataHttpAttempts } from "./schema/intake";
export { appraisalFrameworks, appraisalFrameworkVersions, appraisalFrameworkSections, appraisalFrameworkItems, appraisalFrameworkResponseOptions, appraisalFrameworkOverallJudgementOptions, appraisals, appraisalRevisions, appraisalRevisionResponses, appraisalRevisionResponseEvidence } from "./schema/appraisal";

export const schema = {
  projects: foundationSchema.projects,
  papers: foundationSchema.papers,
  fullTextDocuments: documentsEvidenceSchema.fullTextDocuments,
  paperFullTextPreferences: documentsEvidenceSchema.paperFullTextPreferences,
  documentTextExtractions: documentsEvidenceSchema.documentTextExtractions,
  documentTextExtractionPages: documentsEvidenceSchema.documentTextExtractionPages,
  evidence: documentsEvidenceSchema.evidence,
  evidenceReviewDecisions: documentsEvidenceSchema.evidenceReviewDecisions,
  evidenceAnnotations: documentsEvidenceSchema.evidenceAnnotations,
  evidenceLabels: documentsEvidenceSchema.evidenceLabels,
  evidenceLabelEvents: documentsEvidenceSchema.evidenceLabelEvents,
  evidenceSets: evidenceSetsSchema.evidenceSets,
  evidenceSetMemberships: evidenceSetsSchema.evidenceSetMemberships,
  evidenceSetCompositionRevisions: evidenceSetsSchema.evidenceSetCompositionRevisions,
  evidenceSetCompositionMembers: evidenceSetsSchema.evidenceSetCompositionMembers,
  evidenceSetAnnotations: evidenceSetsSchema.evidenceSetAnnotations,
  claims: claimsSchema.claims,
  claimRevisions: claimsSchema.claimRevisions,
  claimRevisionEvidenceSupports: claimsSchema.claimRevisionEvidenceSupports,
  claimRevisionExtractionSupports: claimsSchema.claimRevisionExtractionSupports,
  claimRevisionSynthesisSupports: claimsSchema.claimRevisionSynthesisSupports,
  screeningCriteria: screeningSchema.screeningCriteria,
  screeningDecisions: screeningSchema.screeningDecisions,
  fullTextScreeningCriteria: screeningSchema.fullTextScreeningCriteria,
  fullTextScreeningDecisions: screeningSchema.fullTextScreeningDecisions,
  fullTextRetrievalAttempts: screeningSchema.fullTextRetrievalAttempts,
  extractionFields: extractionSchema.extractionFields,
  extractionOptions: extractionSchema.extractionOptions,
  extractionValues: extractionSchema.extractionValues,
  extractionValueRevisions: extractionSchema.extractionValueRevisions,
  extractionRevisionEvidence: extractionSchema.extractionRevisionEvidence,
  synthesisStatements: synthesisSchema.synthesisStatements,
  synthesisRevisions: synthesisSchema.synthesisRevisions,
  synthesisRevisionSupports: synthesisSchema.synthesisRevisionSupports,
  synthesisPreparations: synthesisSchema.synthesisPreparations,
  synthesisPreparationSelections: synthesisSchema.synthesisPreparationSelections,
  synthesisInterpretations: synthesisSchema.synthesisInterpretations,
  synthesisInterpretationLimitations: synthesisSchema.synthesisInterpretationLimitations,
  synthesisInterpretationQuestions: synthesisSchema.synthesisInterpretationQuestions,
  synthesisInterpretationContradictions: synthesisSchema.synthesisInterpretationContradictions,
  manuscripts: manuscriptSchema.manuscripts,
  manuscriptSections: manuscriptSchema.manuscriptSections,
  manuscriptClaimPlacements: manuscriptSchema.manuscriptClaimPlacements,
  manuscriptSectionItems: manuscriptSchema.manuscriptSectionItems,
  manuscriptSectionItemClaims: manuscriptSchema.manuscriptSectionItemClaims,
  manuscriptProseBlocks: manuscriptSchema.manuscriptProseBlocks,
  manuscriptProseRevisions: manuscriptSchema.manuscriptProseRevisions,
  manuscriptClaimPlacementEvents: manuscriptSchema.manuscriptClaimPlacementEvents,
  manuscriptReviewThreads: manuscriptSchema.manuscriptReviewThreads,
  manuscriptReviewEvents: manuscriptSchema.manuscriptReviewEvents,
  manuscriptSnapshots: manuscriptSchema.manuscriptSnapshots,
  manuscriptSnapshotSections: manuscriptSchema.manuscriptSnapshotSections,
  manuscriptSnapshotItems: manuscriptSchema.manuscriptSnapshotItems,
  manuscriptSnapshotProseItems: manuscriptSchema.manuscriptSnapshotProseItems,
  manuscriptSnapshotClaimItems: manuscriptSchema.manuscriptSnapshotClaimItems,
  manuscriptSnapshotBibliographyEntries: manuscriptSchema.manuscriptSnapshotBibliographyEntries,
  manuscriptSnapshotClaimBibliographyMembers: manuscriptSchema.manuscriptSnapshotClaimBibliographyMembers,
  manuscriptSnapshotWarnings: manuscriptSchema.manuscriptSnapshotWarnings,
  researchQuestions: protocolSearchSchema.researchQuestions,
  researchQuestionExtractionFieldEvents: researchQuestionSchema.researchQuestionExtractionFieldEvents,
  researchQuestionEvidenceSetEvents: researchQuestionSchema.researchQuestionEvidenceSetEvents,
  researchQuestionSynthesisStatementEvents: researchQuestionSchema.researchQuestionSynthesisStatementEvents,
  researchQuestionClaimEvents: researchQuestionSchema.researchQuestionClaimEvents,
  researchQuestionAnswers: researchQuestionSchema.researchQuestionAnswers,
  researchQuestionAnswerClaimContexts: researchQuestionSchema.researchQuestionAnswerClaimContexts,
  researchQuestionAnswerSynthesisContexts: researchQuestionSchema.researchQuestionAnswerSynthesisContexts,
  searchSources: protocolSearchSchema.searchSources,
  searchStrategies: protocolSearchSchema.searchStrategies,
  searchRuns: protocolSearchSchema.searchRuns,
  retrievedRecords: protocolSearchSchema.retrievedRecords,
  retrievedRecordMatches: protocolSearchSchema.retrievedRecordMatches,
  retrievedRecordDeduplicationDecisions: protocolSearchSchema.retrievedRecordDeduplicationDecisions,
  aiExtractionRequests: aiExtractionSchema.aiExtractionRequests,
  aiExtractionRequestPages: aiExtractionSchema.aiExtractionRequestPages,
  aiExtractionDispatches: aiExtractionSchema.aiExtractionDispatches,
  aiExtractionResults: aiExtractionSchema.aiExtractionResults,
  aiExtractionResultGroundings: aiExtractionSchema.aiExtractionResultGroundings,
  aiExtractionDecisions: aiExtractionSchema.aiExtractionDecisions,
  aiExtractionDecisionEvidence: aiExtractionSchema.aiExtractionDecisionEvidence,
  aiExtractionBatches: aiExtractionSchema.aiExtractionBatches,
  aiExtractionBatchItems: aiExtractionSchema.aiExtractionBatchItems,
  bibliographicImports: intakeSchema.bibliographicImports,
  bibliographicImportRecords: intakeSchema.bibliographicImportRecords,
  bibliographicImportResolutions: intakeSchema.bibliographicImportResolutions,
  pdfIntakes: intakeSchema.pdfIntakes,
  pdfIntakeMetadataResults: intakeSchema.pdfIntakeMetadataResults,
  pdfIntakeMetadataFields: intakeSchema.pdfIntakeMetadataFields,
  pdfIntakeResolutions: intakeSchema.pdfIntakeResolutions,
  aiSynthesisRequests: aiSynthesisSchema.aiSynthesisRequests,
  aiSynthesisRequestSupports: aiSynthesisSchema.aiSynthesisRequestSupports,
  aiSynthesisRequestSources: aiSynthesisSchema.aiSynthesisRequestSources,
  aiSynthesisDispatches: aiSynthesisSchema.aiSynthesisDispatches,
  aiSynthesisResults: aiSynthesisSchema.aiSynthesisResults,
  aiSynthesisResultGroundings: aiSynthesisSchema.aiSynthesisResultGroundings,
  aiSynthesisDecisions: aiSynthesisSchema.aiSynthesisDecisions,
  doiLookupRequests: intakeSchema.doiLookupRequests,
  bibliographicMetadataFetches: intakeSchema.bibliographicMetadataFetches,
  doiLookupDispatches: intakeSchema.doiLookupDispatches,
  bibliographicMetadataFetchResults: intakeSchema.bibliographicMetadataFetchResults,
  bibliographicMetadataResultAuthors: intakeSchema.bibliographicMetadataResultAuthors,
  doiLookupResolutions: intakeSchema.doiLookupResolutions,
  bibliographicMetadataHttpAttempts: intakeSchema.bibliographicMetadataHttpAttempts,
  appraisalFrameworks: appraisalSchema.appraisalFrameworks,
  appraisalFrameworkVersions: appraisalSchema.appraisalFrameworkVersions,
  appraisalFrameworkSections: appraisalSchema.appraisalFrameworkSections,
  appraisalFrameworkItems: appraisalSchema.appraisalFrameworkItems,
  appraisalFrameworkResponseOptions: appraisalSchema.appraisalFrameworkResponseOptions,
  appraisalFrameworkOverallJudgementOptions: appraisalSchema.appraisalFrameworkOverallJudgementOptions,
  appraisals: appraisalSchema.appraisals,
  appraisalRevisions: appraisalSchema.appraisalRevisions,
  appraisalRevisionResponses: appraisalSchema.appraisalRevisionResponses,
  appraisalRevisionResponseEvidence: appraisalSchema.appraisalRevisionResponseEvidence,
};
