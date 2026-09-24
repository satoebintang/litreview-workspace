'use server';

import * as actionsAiExtraction from "./actions/ai-extraction";
import * as actionsAiSynthesis from "./actions/ai-synthesis";
import * as actionsAppraisal from "./actions/appraisal";
import * as actionsBibliographicIntake from "./actions/bibliographic-intake";
import * as actionsClaims from "./actions/claims";
import * as actionsDocumentsEvidence from "./actions/documents-evidence";
import * as actionsDoiIntake from "./actions/doi-intake";
import * as actionsEvidenceSets from "./actions/evidence-sets";
import * as actionsExtraction from "./actions/extraction";
import * as actionsManuscript from "./actions/manuscript";
import * as actionsPdfIntake from "./actions/pdf-intake";
import * as actionsProjectsPapers from "./actions/projects-papers";
import * as actionsProtocolSearch from "./actions/protocol-search";
import * as actionsResearchQuestion from "./actions/research-question";
import * as actionsScreening from "./actions/screening";
import * as actionsSynthesis from "./actions/synthesis";

export async function beginAiExtractionSuggestionAction(  form: Parameters<typeof actionsAiExtraction.beginAiExtractionSuggestionAction>[0]): Promise<Awaited<ReturnType<typeof actionsAiExtraction.beginAiExtractionSuggestionAction>>> {
  return actionsAiExtraction.beginAiExtractionSuggestionAction(form);
}
export async function executeAiExtractionSuggestionAction(  form: Parameters<typeof actionsAiExtraction.executeAiExtractionSuggestionAction>[0]): Promise<Awaited<ReturnType<typeof actionsAiExtraction.executeAiExtractionSuggestionAction>>> {
  return actionsAiExtraction.executeAiExtractionSuggestionAction(form);
}
export async function expireAiExtractionSuggestionAction(  form: Parameters<typeof actionsAiExtraction.expireAiExtractionSuggestionAction>[0]): Promise<Awaited<ReturnType<typeof actionsAiExtraction.expireAiExtractionSuggestionAction>>> {
  return actionsAiExtraction.expireAiExtractionSuggestionAction(form);
}
export async function rejectAiExtractionSuggestionAction(  form: Parameters<typeof actionsAiExtraction.rejectAiExtractionSuggestionAction>[0]): Promise<Awaited<ReturnType<typeof actionsAiExtraction.rejectAiExtractionSuggestionAction>>> {
  return actionsAiExtraction.rejectAiExtractionSuggestionAction(form);
}
export async function acceptAiExtractionSuggestionAction(  form: Parameters<typeof actionsAiExtraction.acceptAiExtractionSuggestionAction>[0]): Promise<Awaited<ReturnType<typeof actionsAiExtraction.acceptAiExtractionSuggestionAction>>> {
  return actionsAiExtraction.acceptAiExtractionSuggestionAction(form);
}
export async function previewAiExtractionBatchAction(  form: Parameters<typeof actionsAiExtraction.previewAiExtractionBatchAction>[0]): Promise<Awaited<ReturnType<typeof actionsAiExtraction.previewAiExtractionBatchAction>>> {
  return actionsAiExtraction.previewAiExtractionBatchAction(form);
}
export async function createAiExtractionBatchAction(  form: Parameters<typeof actionsAiExtraction.createAiExtractionBatchAction>[0]): Promise<Awaited<ReturnType<typeof actionsAiExtraction.createAiExtractionBatchAction>>> {
  return actionsAiExtraction.createAiExtractionBatchAction(form);
}
export async function processAiExtractionBatchAction(  form: Parameters<typeof actionsAiExtraction.processAiExtractionBatchAction>[0]): Promise<Awaited<ReturnType<typeof actionsAiExtraction.processAiExtractionBatchAction>>> {
  return actionsAiExtraction.processAiExtractionBatchAction(form);
}
export async function cancelAiExtractionBatchAction(  form: Parameters<typeof actionsAiExtraction.cancelAiExtractionBatchAction>[0]): Promise<Awaited<ReturnType<typeof actionsAiExtraction.cancelAiExtractionBatchAction>>> {
  return actionsAiExtraction.cancelAiExtractionBatchAction(form);
}
export async function beginAiSynthesisSuggestionAction(  form: Parameters<typeof actionsAiSynthesis.beginAiSynthesisSuggestionAction>[0]): Promise<Awaited<ReturnType<typeof actionsAiSynthesis.beginAiSynthesisSuggestionAction>>> {
  return actionsAiSynthesis.beginAiSynthesisSuggestionAction(form);
}
export async function executeAiSynthesisSuggestionAction(  form: Parameters<typeof actionsAiSynthesis.executeAiSynthesisSuggestionAction>[0]): Promise<Awaited<ReturnType<typeof actionsAiSynthesis.executeAiSynthesisSuggestionAction>>> {
  return actionsAiSynthesis.executeAiSynthesisSuggestionAction(form);
}
export async function expireAiSynthesisSuggestionAction(  form: Parameters<typeof actionsAiSynthesis.expireAiSynthesisSuggestionAction>[0]): Promise<Awaited<ReturnType<typeof actionsAiSynthesis.expireAiSynthesisSuggestionAction>>> {
  return actionsAiSynthesis.expireAiSynthesisSuggestionAction(form);
}
export async function rejectAiSynthesisSuggestionAction(  form: Parameters<typeof actionsAiSynthesis.rejectAiSynthesisSuggestionAction>[0]): Promise<Awaited<ReturnType<typeof actionsAiSynthesis.rejectAiSynthesisSuggestionAction>>> {
  return actionsAiSynthesis.rejectAiSynthesisSuggestionAction(form);
}
export async function acceptAiSynthesisSuggestionAction(  form: Parameters<typeof actionsAiSynthesis.acceptAiSynthesisSuggestionAction>[0]): Promise<Awaited<ReturnType<typeof actionsAiSynthesis.acceptAiSynthesisSuggestionAction>>> {
  return actionsAiSynthesis.acceptAiSynthesisSuggestionAction(form);
}
export async function createAppraisalFrameworkAction(  form: Parameters<typeof actionsAppraisal.createAppraisalFrameworkAction>[0]): Promise<Awaited<ReturnType<typeof actionsAppraisal.createAppraisalFrameworkAction>>> {
  return actionsAppraisal.createAppraisalFrameworkAction(form);
}
export async function updateFrameworkDraftMetadataAction(  form: Parameters<typeof actionsAppraisal.updateFrameworkDraftMetadataAction>[0]): Promise<Awaited<ReturnType<typeof actionsAppraisal.updateFrameworkDraftMetadataAction>>> {
  return actionsAppraisal.updateFrameworkDraftMetadataAction(form);
}
export async function addAppraisalFrameworkSectionAction(  form: Parameters<typeof actionsAppraisal.addAppraisalFrameworkSectionAction>[0]): Promise<Awaited<ReturnType<typeof actionsAppraisal.addAppraisalFrameworkSectionAction>>> {
  return actionsAppraisal.addAppraisalFrameworkSectionAction(form);
}
export async function updateAppraisalFrameworkSectionAction(  form: Parameters<typeof actionsAppraisal.updateAppraisalFrameworkSectionAction>[0]): Promise<Awaited<ReturnType<typeof actionsAppraisal.updateAppraisalFrameworkSectionAction>>> {
  return actionsAppraisal.updateAppraisalFrameworkSectionAction(form);
}
export async function reorderAppraisalFrameworkSectionsAction(  form: Parameters<typeof actionsAppraisal.reorderAppraisalFrameworkSectionsAction>[0]): Promise<Awaited<ReturnType<typeof actionsAppraisal.reorderAppraisalFrameworkSectionsAction>>> {
  return actionsAppraisal.reorderAppraisalFrameworkSectionsAction(form);
}
export async function removeAppraisalFrameworkSectionAction(  form: Parameters<typeof actionsAppraisal.removeAppraisalFrameworkSectionAction>[0]): Promise<Awaited<ReturnType<typeof actionsAppraisal.removeAppraisalFrameworkSectionAction>>> {
  return actionsAppraisal.removeAppraisalFrameworkSectionAction(form);
}
export async function addAppraisalFrameworkItemAction(  form: Parameters<typeof actionsAppraisal.addAppraisalFrameworkItemAction>[0]): Promise<Awaited<ReturnType<typeof actionsAppraisal.addAppraisalFrameworkItemAction>>> {
  return actionsAppraisal.addAppraisalFrameworkItemAction(form);
}
export async function updateAppraisalFrameworkItemAction(  form: Parameters<typeof actionsAppraisal.updateAppraisalFrameworkItemAction>[0]): Promise<Awaited<ReturnType<typeof actionsAppraisal.updateAppraisalFrameworkItemAction>>> {
  return actionsAppraisal.updateAppraisalFrameworkItemAction(form);
}
export async function reorderAppraisalFrameworkItemsAction(  form: Parameters<typeof actionsAppraisal.reorderAppraisalFrameworkItemsAction>[0]): Promise<Awaited<ReturnType<typeof actionsAppraisal.reorderAppraisalFrameworkItemsAction>>> {
  return actionsAppraisal.reorderAppraisalFrameworkItemsAction(form);
}
export async function removeAppraisalFrameworkItemAction(  form: Parameters<typeof actionsAppraisal.removeAppraisalFrameworkItemAction>[0]): Promise<Awaited<ReturnType<typeof actionsAppraisal.removeAppraisalFrameworkItemAction>>> {
  return actionsAppraisal.removeAppraisalFrameworkItemAction(form);
}
export async function addAppraisalFrameworkResponseOptionAction(  form: Parameters<typeof actionsAppraisal.addAppraisalFrameworkResponseOptionAction>[0]): Promise<Awaited<ReturnType<typeof actionsAppraisal.addAppraisalFrameworkResponseOptionAction>>> {
  return actionsAppraisal.addAppraisalFrameworkResponseOptionAction(form);
}
export async function updateAppraisalFrameworkResponseOptionAction(  form: Parameters<typeof actionsAppraisal.updateAppraisalFrameworkResponseOptionAction>[0]): Promise<Awaited<ReturnType<typeof actionsAppraisal.updateAppraisalFrameworkResponseOptionAction>>> {
  return actionsAppraisal.updateAppraisalFrameworkResponseOptionAction(form);
}
export async function reorderAppraisalFrameworkResponseOptionsAction(  form: Parameters<typeof actionsAppraisal.reorderAppraisalFrameworkResponseOptionsAction>[0]): Promise<Awaited<ReturnType<typeof actionsAppraisal.reorderAppraisalFrameworkResponseOptionsAction>>> {
  return actionsAppraisal.reorderAppraisalFrameworkResponseOptionsAction(form);
}
export async function removeAppraisalFrameworkResponseOptionAction(  form: Parameters<typeof actionsAppraisal.removeAppraisalFrameworkResponseOptionAction>[0]): Promise<Awaited<ReturnType<typeof actionsAppraisal.removeAppraisalFrameworkResponseOptionAction>>> {
  return actionsAppraisal.removeAppraisalFrameworkResponseOptionAction(form);
}
export async function setAppraisalFrameworkOverallOptionsAction(  form: Parameters<typeof actionsAppraisal.setAppraisalFrameworkOverallOptionsAction>[0]): Promise<Awaited<ReturnType<typeof actionsAppraisal.setAppraisalFrameworkOverallOptionsAction>>> {
  return actionsAppraisal.setAppraisalFrameworkOverallOptionsAction(form);
}
export async function reorderAppraisalFrameworkOverallOptionsAction(  form: Parameters<typeof actionsAppraisal.reorderAppraisalFrameworkOverallOptionsAction>[0]): Promise<Awaited<ReturnType<typeof actionsAppraisal.reorderAppraisalFrameworkOverallOptionsAction>>> {
  return actionsAppraisal.reorderAppraisalFrameworkOverallOptionsAction(form);
}
export async function finalizeAppraisalFrameworkVersionAction(  form: Parameters<typeof actionsAppraisal.finalizeAppraisalFrameworkVersionAction>[0]): Promise<Awaited<ReturnType<typeof actionsAppraisal.finalizeAppraisalFrameworkVersionAction>>> {
  return actionsAppraisal.finalizeAppraisalFrameworkVersionAction(form);
}
export async function createAppraisalFrameworkVersionAction(  form: Parameters<typeof actionsAppraisal.createAppraisalFrameworkVersionAction>[0]): Promise<Awaited<ReturnType<typeof actionsAppraisal.createAppraisalFrameworkVersionAction>>> {
  return actionsAppraisal.createAppraisalFrameworkVersionAction(form);
}
export async function archiveAppraisalFrameworkAction(  form: Parameters<typeof actionsAppraisal.archiveAppraisalFrameworkAction>[0]): Promise<Awaited<ReturnType<typeof actionsAppraisal.archiveAppraisalFrameworkAction>>> {
  return actionsAppraisal.archiveAppraisalFrameworkAction(form);
}
export async function saveAppraisalRevisionAction(  _previousState: Parameters<typeof actionsAppraisal.saveAppraisalRevisionAction>[0],   form: Parameters<typeof actionsAppraisal.saveAppraisalRevisionAction>[1]): Promise<Awaited<ReturnType<typeof actionsAppraisal.saveAppraisalRevisionAction>>> {
  return actionsAppraisal.saveAppraisalRevisionAction(_previousState, form);
}
export async function uploadBibliographicImportAction(  form: Parameters<typeof actionsBibliographicIntake.uploadBibliographicImportAction>[0]): Promise<Awaited<ReturnType<typeof actionsBibliographicIntake.uploadBibliographicImportAction>>> {
  return actionsBibliographicIntake.uploadBibliographicImportAction(form);
}
export async function resolveBibliographicImportRecordAction(  form: Parameters<typeof actionsBibliographicIntake.resolveBibliographicImportRecordAction>[0]): Promise<Awaited<ReturnType<typeof actionsBibliographicIntake.resolveBibliographicImportRecordAction>>> {
  return actionsBibliographicIntake.resolveBibliographicImportRecordAction(form);
}
export async function bulkCreateBibliographicImportRecordsAction(  form: Parameters<typeof actionsBibliographicIntake.bulkCreateBibliographicImportRecordsAction>[0]): Promise<Awaited<ReturnType<typeof actionsBibliographicIntake.bulkCreateBibliographicImportRecordsAction>>> {
  return actionsBibliographicIntake.bulkCreateBibliographicImportRecordsAction(form);
}
export async function createClaimAction(  form: Parameters<typeof actionsClaims.createClaimAction>[0]): Promise<Awaited<ReturnType<typeof actionsClaims.createClaimAction>>> {
  return actionsClaims.createClaimAction(form);
}
export async function linkEvidenceAction(  form: Parameters<typeof actionsClaims.linkEvidenceAction>[0]): Promise<Awaited<ReturnType<typeof actionsClaims.linkEvidenceAction>>> {
  return actionsClaims.linkEvidenceAction(form);
}
export async function unlinkEvidenceAction(  form: Parameters<typeof actionsClaims.unlinkEvidenceAction>[0]): Promise<Awaited<ReturnType<typeof actionsClaims.unlinkEvidenceAction>>> {
  return actionsClaims.unlinkEvidenceAction(form);
}
export async function createClaimRevisionAction(  form: Parameters<typeof actionsClaims.createClaimRevisionAction>[0]): Promise<Awaited<ReturnType<typeof actionsClaims.createClaimRevisionAction>>> {
  return actionsClaims.createClaimRevisionAction(form);
}
export async function reviseClaimAction(  form: Parameters<typeof actionsClaims.reviseClaimAction>[0]): Promise<Awaited<ReturnType<typeof actionsClaims.reviseClaimAction>>> {
  return actionsClaims.reviseClaimAction(form);
}
export async function withdrawClaimAction(  form: Parameters<typeof actionsClaims.withdrawClaimAction>[0]): Promise<Awaited<ReturnType<typeof actionsClaims.withdrawClaimAction>>> {
  return actionsClaims.withdrawClaimAction(form);
}
export async function reactivateClaimAction(  form: Parameters<typeof actionsClaims.reactivateClaimAction>[0]): Promise<Awaited<ReturnType<typeof actionsClaims.reactivateClaimAction>>> {
  return actionsClaims.reactivateClaimAction(form);
}
export async function createClaimFromInterpretationAction(  form: Parameters<typeof actionsClaims.createClaimFromInterpretationAction>[0]): Promise<Awaited<ReturnType<typeof actionsClaims.createClaimFromInterpretationAction>>> {
  return actionsClaims.createClaimFromInterpretationAction(form);
}
export async function recordEvidenceAction(  form: Parameters<typeof actionsDocumentsEvidence.recordEvidenceAction>[0]): Promise<Awaited<ReturnType<typeof actionsDocumentsEvidence.recordEvidenceAction>>> {
  return actionsDocumentsEvidence.recordEvidenceAction(form);
}
export async function setPreferredFullTextDocumentAction(  form: Parameters<typeof actionsDocumentsEvidence.setPreferredFullTextDocumentAction>[0]): Promise<Awaited<ReturnType<typeof actionsDocumentsEvidence.setPreferredFullTextDocumentAction>>> {
  return actionsDocumentsEvidence.setPreferredFullTextDocumentAction(form);
}
export async function clearPreferredFullTextDocumentAction(  form: Parameters<typeof actionsDocumentsEvidence.clearPreferredFullTextDocumentAction>[0]): Promise<Awaited<ReturnType<typeof actionsDocumentsEvidence.clearPreferredFullTextDocumentAction>>> {
  return actionsDocumentsEvidence.clearPreferredFullTextDocumentAction(form);
}
export async function archiveFullTextDocumentAction(  form: Parameters<typeof actionsDocumentsEvidence.archiveFullTextDocumentAction>[0]): Promise<Awaited<ReturnType<typeof actionsDocumentsEvidence.archiveFullTextDocumentAction>>> {
  return actionsDocumentsEvidence.archiveFullTextDocumentAction(form);
}
export async function extractDocumentTextAction(  form: Parameters<typeof actionsDocumentsEvidence.extractDocumentTextAction>[0]): Promise<Awaited<ReturnType<typeof actionsDocumentsEvidence.extractDocumentTextAction>>> {
  return actionsDocumentsEvidence.extractDocumentTextAction(form);
}
export async function recordExtractedEvidenceAction(  form: Parameters<typeof actionsDocumentsEvidence.recordExtractedEvidenceAction>[0]): Promise<Awaited<ReturnType<typeof actionsDocumentsEvidence.recordExtractedEvidenceAction>>> {
  return actionsDocumentsEvidence.recordExtractedEvidenceAction(form);
}
export async function appendEvidenceReviewDecisionAction(  form: Parameters<typeof actionsDocumentsEvidence.appendEvidenceReviewDecisionAction>[0]): Promise<Awaited<ReturnType<typeof actionsDocumentsEvidence.appendEvidenceReviewDecisionAction>>> {
  return actionsDocumentsEvidence.appendEvidenceReviewDecisionAction(form);
}
export async function appendEvidenceAnnotationAction(  form: Parameters<typeof actionsDocumentsEvidence.appendEvidenceAnnotationAction>[0]): Promise<Awaited<ReturnType<typeof actionsDocumentsEvidence.appendEvidenceAnnotationAction>>> {
  return actionsDocumentsEvidence.appendEvidenceAnnotationAction(form);
}
export async function createEvidenceLabelAction(  form: Parameters<typeof actionsDocumentsEvidence.createEvidenceLabelAction>[0]): Promise<Awaited<ReturnType<typeof actionsDocumentsEvidence.createEvidenceLabelAction>>> {
  return actionsDocumentsEvidence.createEvidenceLabelAction(form);
}
export async function archiveEvidenceLabelAction(  form: Parameters<typeof actionsDocumentsEvidence.archiveEvidenceLabelAction>[0]): Promise<Awaited<ReturnType<typeof actionsDocumentsEvidence.archiveEvidenceLabelAction>>> {
  return actionsDocumentsEvidence.archiveEvidenceLabelAction(form);
}
export async function assignEvidenceLabelAction(  form: Parameters<typeof actionsDocumentsEvidence.assignEvidenceLabelAction>[0]): Promise<Awaited<ReturnType<typeof actionsDocumentsEvidence.assignEvidenceLabelAction>>> {
  return actionsDocumentsEvidence.assignEvidenceLabelAction(form);
}
export async function removeEvidenceLabelAction(  form: Parameters<typeof actionsDocumentsEvidence.removeEvidenceLabelAction>[0]): Promise<Awaited<ReturnType<typeof actionsDocumentsEvidence.removeEvidenceLabelAction>>> {
  return actionsDocumentsEvidence.removeEvidenceLabelAction(form);
}
export async function beginDoiLookupAction(  form: Parameters<typeof actionsDoiIntake.beginDoiLookupAction>[0]): Promise<Awaited<ReturnType<typeof actionsDoiIntake.beginDoiLookupAction>>> {
  return actionsDoiIntake.beginDoiLookupAction(form);
}
export async function executeDoiLookupAction(  form: Parameters<typeof actionsDoiIntake.executeDoiLookupAction>[0]): Promise<Awaited<ReturnType<typeof actionsDoiIntake.executeDoiLookupAction>>> {
  return actionsDoiIntake.executeDoiLookupAction(form);
}
export async function createPaperFromDoiLookupAction(  form: Parameters<typeof actionsDoiIntake.createPaperFromDoiLookupAction>[0]): Promise<Awaited<ReturnType<typeof actionsDoiIntake.createPaperFromDoiLookupAction>>> {
  return actionsDoiIntake.createPaperFromDoiLookupAction(form);
}
export async function matchDoiLookupAction(  form: Parameters<typeof actionsDoiIntake.matchDoiLookupAction>[0]): Promise<Awaited<ReturnType<typeof actionsDoiIntake.matchDoiLookupAction>>> {
  return actionsDoiIntake.matchDoiLookupAction(form);
}
export async function clearDoiLookupResolutionAction(  form: Parameters<typeof actionsDoiIntake.clearDoiLookupResolutionAction>[0]): Promise<Awaited<ReturnType<typeof actionsDoiIntake.clearDoiLookupResolutionAction>>> {
  return actionsDoiIntake.clearDoiLookupResolutionAction(form);
}
export async function createEvidenceSetAction(  form: Parameters<typeof actionsEvidenceSets.createEvidenceSetAction>[0]): Promise<Awaited<ReturnType<typeof actionsEvidenceSets.createEvidenceSetAction>>> {
  return actionsEvidenceSets.createEvidenceSetAction(form);
}
export async function updateEvidenceSetMetadataAction(  form: Parameters<typeof actionsEvidenceSets.updateEvidenceSetMetadataAction>[0]): Promise<Awaited<ReturnType<typeof actionsEvidenceSets.updateEvidenceSetMetadataAction>>> {
  return actionsEvidenceSets.updateEvidenceSetMetadataAction(form);
}
export async function archiveEvidenceSetAction(  form: Parameters<typeof actionsEvidenceSets.archiveEvidenceSetAction>[0]): Promise<Awaited<ReturnType<typeof actionsEvidenceSets.archiveEvidenceSetAction>>> {
  return actionsEvidenceSets.archiveEvidenceSetAction(form);
}
export async function addEvidenceToSetAction(  form: Parameters<typeof actionsEvidenceSets.addEvidenceToSetAction>[0]): Promise<Awaited<ReturnType<typeof actionsEvidenceSets.addEvidenceToSetAction>>> {
  return actionsEvidenceSets.addEvidenceToSetAction(form);
}
export async function removeEvidenceFromSetAction(  form: Parameters<typeof actionsEvidenceSets.removeEvidenceFromSetAction>[0]): Promise<Awaited<ReturnType<typeof actionsEvidenceSets.removeEvidenceFromSetAction>>> {
  return actionsEvidenceSets.removeEvidenceFromSetAction(form);
}
export async function reorderEvidenceSetAction(  form: Parameters<typeof actionsEvidenceSets.reorderEvidenceSetAction>[0]): Promise<Awaited<ReturnType<typeof actionsEvidenceSets.reorderEvidenceSetAction>>> {
  return actionsEvidenceSets.reorderEvidenceSetAction(form);
}
export async function appendEvidenceSetAnnotationAction(  form: Parameters<typeof actionsEvidenceSets.appendEvidenceSetAnnotationAction>[0]): Promise<Awaited<ReturnType<typeof actionsEvidenceSets.appendEvidenceSetAnnotationAction>>> {
  return actionsEvidenceSets.appendEvidenceSetAnnotationAction(form);
}
export async function createExtractionFieldAction(  form: Parameters<typeof actionsExtraction.createExtractionFieldAction>[0]): Promise<Awaited<ReturnType<typeof actionsExtraction.createExtractionFieldAction>>> {
  return actionsExtraction.createExtractionFieldAction(form);
}
export async function archiveExtractionFieldAction(  form: Parameters<typeof actionsExtraction.archiveExtractionFieldAction>[0]): Promise<Awaited<ReturnType<typeof actionsExtraction.archiveExtractionFieldAction>>> {
  return actionsExtraction.archiveExtractionFieldAction(form);
}
export async function createExtractionOptionAction(  form: Parameters<typeof actionsExtraction.createExtractionOptionAction>[0]): Promise<Awaited<ReturnType<typeof actionsExtraction.createExtractionOptionAction>>> {
  return actionsExtraction.createExtractionOptionAction(form);
}
export async function archiveExtractionOptionAction(  form: Parameters<typeof actionsExtraction.archiveExtractionOptionAction>[0]): Promise<Awaited<ReturnType<typeof actionsExtraction.archiveExtractionOptionAction>>> {
  return actionsExtraction.archiveExtractionOptionAction(form);
}
export async function reviseExtractionValueAction(  form: Parameters<typeof actionsExtraction.reviseExtractionValueAction>[0]): Promise<Awaited<ReturnType<typeof actionsExtraction.reviseExtractionValueAction>>> {
  return actionsExtraction.reviseExtractionValueAction(form);
}
export async function linkExtractionEvidenceAction(  form: Parameters<typeof actionsExtraction.linkExtractionEvidenceAction>[0]): Promise<Awaited<ReturnType<typeof actionsExtraction.linkExtractionEvidenceAction>>> {
  return actionsExtraction.linkExtractionEvidenceAction(form);
}
export async function unlinkExtractionEvidenceAction(  form: Parameters<typeof actionsExtraction.unlinkExtractionEvidenceAction>[0]): Promise<Awaited<ReturnType<typeof actionsExtraction.unlinkExtractionEvidenceAction>>> {
  return actionsExtraction.unlinkExtractionEvidenceAction(form);
}
export async function createDefaultManuscriptAction(  form: Parameters<typeof actionsManuscript.createDefaultManuscriptAction>[0]): Promise<Awaited<ReturnType<typeof actionsManuscript.createDefaultManuscriptAction>>> {
  return actionsManuscript.createDefaultManuscriptAction(form);
}
export async function createManuscriptSectionAction(  form: Parameters<typeof actionsManuscript.createManuscriptSectionAction>[0]): Promise<Awaited<ReturnType<typeof actionsManuscript.createManuscriptSectionAction>>> {
  return actionsManuscript.createManuscriptSectionAction(form);
}
export async function renameManuscriptSectionAction(  form: Parameters<typeof actionsManuscript.renameManuscriptSectionAction>[0]): Promise<Awaited<ReturnType<typeof actionsManuscript.renameManuscriptSectionAction>>> {
  return actionsManuscript.renameManuscriptSectionAction(form);
}
export async function reorderManuscriptSectionsAction(  form: Parameters<typeof actionsManuscript.reorderManuscriptSectionsAction>[0]): Promise<Awaited<ReturnType<typeof actionsManuscript.reorderManuscriptSectionsAction>>> {
  return actionsManuscript.reorderManuscriptSectionsAction(form);
}
export async function archiveManuscriptSectionAction(  form: Parameters<typeof actionsManuscript.archiveManuscriptSectionAction>[0]): Promise<Awaited<ReturnType<typeof actionsManuscript.archiveManuscriptSectionAction>>> {
  return actionsManuscript.archiveManuscriptSectionAction(form);
}
export async function placeClaimRevisionAction(  form: Parameters<typeof actionsManuscript.placeClaimRevisionAction>[0]): Promise<Awaited<ReturnType<typeof actionsManuscript.placeClaimRevisionAction>>> {
  return actionsManuscript.placeClaimRevisionAction(form);
}
export async function replacePlacedClaimRevisionAction(  form: Parameters<typeof actionsManuscript.replacePlacedClaimRevisionAction>[0]): Promise<Awaited<ReturnType<typeof actionsManuscript.replacePlacedClaimRevisionAction>>> {
  return actionsManuscript.replacePlacedClaimRevisionAction(form);
}
export async function removeClaimPlacementAction(  form: Parameters<typeof actionsManuscript.removeClaimPlacementAction>[0]): Promise<Awaited<ReturnType<typeof actionsManuscript.removeClaimPlacementAction>>> {
  return actionsManuscript.removeClaimPlacementAction(form);
}
export async function createManuscriptProseBlockAction(  form: Parameters<typeof actionsManuscript.createManuscriptProseBlockAction>[0]): Promise<Awaited<ReturnType<typeof actionsManuscript.createManuscriptProseBlockAction>>> {
  return actionsManuscript.createManuscriptProseBlockAction(form);
}
export async function updateManuscriptProseBlockAction(  form: Parameters<typeof actionsManuscript.updateManuscriptProseBlockAction>[0]): Promise<Awaited<ReturnType<typeof actionsManuscript.updateManuscriptProseBlockAction>>> {
  return actionsManuscript.updateManuscriptProseBlockAction(form);
}
export async function removeManuscriptProseBlockAction(  form: Parameters<typeof actionsManuscript.removeManuscriptProseBlockAction>[0]): Promise<Awaited<ReturnType<typeof actionsManuscript.removeManuscriptProseBlockAction>>> {
  return actionsManuscript.removeManuscriptProseBlockAction(form);
}
export async function reorderManuscriptSectionItemsAction(  form: Parameters<typeof actionsManuscript.reorderManuscriptSectionItemsAction>[0]): Promise<Awaited<ReturnType<typeof actionsManuscript.reorderManuscriptSectionItemsAction>>> {
  return actionsManuscript.reorderManuscriptSectionItemsAction(form);
}
export async function setManuscriptCitationStyleAction(  form: Parameters<typeof actionsManuscript.setManuscriptCitationStyleAction>[0]): Promise<Awaited<ReturnType<typeof actionsManuscript.setManuscriptCitationStyleAction>>> {
  return actionsManuscript.setManuscriptCitationStyleAction(form);
}
export async function createManuscriptSnapshotAction(  form: Parameters<typeof actionsManuscript.createManuscriptSnapshotAction>[0]): Promise<Awaited<ReturnType<typeof actionsManuscript.createManuscriptSnapshotAction>>> {
  return actionsManuscript.createManuscriptSnapshotAction(form);
}
export async function openManuscriptReviewThreadAction(  form: Parameters<typeof actionsManuscript.openManuscriptReviewThreadAction>[0]): Promise<Awaited<ReturnType<typeof actionsManuscript.openManuscriptReviewThreadAction>>> {
  return actionsManuscript.openManuscriptReviewThreadAction(form);
}
export async function commentManuscriptReviewThreadAction(  form: Parameters<typeof actionsManuscript.commentManuscriptReviewThreadAction>[0]): Promise<Awaited<ReturnType<typeof actionsManuscript.commentManuscriptReviewThreadAction>>> {
  return actionsManuscript.commentManuscriptReviewThreadAction(form);
}
export async function resolveManuscriptReviewThreadAction(  form: Parameters<typeof actionsManuscript.resolveManuscriptReviewThreadAction>[0]): Promise<Awaited<ReturnType<typeof actionsManuscript.resolveManuscriptReviewThreadAction>>> {
  return actionsManuscript.resolveManuscriptReviewThreadAction(form);
}
export async function reopenManuscriptReviewThreadAction(  form: Parameters<typeof actionsManuscript.reopenManuscriptReviewThreadAction>[0]): Promise<Awaited<ReturnType<typeof actionsManuscript.reopenManuscriptReviewThreadAction>>> {
  return actionsManuscript.reopenManuscriptReviewThreadAction(form);
}
export async function inspectPdfIntakeAction(  form: Parameters<typeof actionsPdfIntake.inspectPdfIntakeAction>[0]): Promise<Awaited<ReturnType<typeof actionsPdfIntake.inspectPdfIntakeAction>>> {
  return actionsPdfIntake.inspectPdfIntakeAction(form);
}
export async function resolvePdfIntakeAction(  form: Parameters<typeof actionsPdfIntake.resolvePdfIntakeAction>[0]): Promise<Awaited<ReturnType<typeof actionsPdfIntake.resolvePdfIntakeAction>>> {
  return actionsPdfIntake.resolvePdfIntakeAction(form);
}
export async function createProjectAction(  form: Parameters<typeof actionsProjectsPapers.createProjectAction>[0]): Promise<Awaited<ReturnType<typeof actionsProjectsPapers.createProjectAction>>> {
  return actionsProjectsPapers.createProjectAction(form);
}
export async function addPaperAction(  _previousState: Parameters<typeof actionsProjectsPapers.addPaperAction>[0],   form: Parameters<typeof actionsProjectsPapers.addPaperAction>[1]): Promise<Awaited<ReturnType<typeof actionsProjectsPapers.addPaperAction>>> {
  return actionsProjectsPapers.addPaperAction(_previousState, form);
}
export async function createResearchQuestionAction(  form: Parameters<typeof actionsProtocolSearch.createResearchQuestionAction>[0]): Promise<Awaited<ReturnType<typeof actionsProtocolSearch.createResearchQuestionAction>>> {
  return actionsProtocolSearch.createResearchQuestionAction(form);
}
export async function createSearchSourceAction(  form: Parameters<typeof actionsProtocolSearch.createSearchSourceAction>[0]): Promise<Awaited<ReturnType<typeof actionsProtocolSearch.createSearchSourceAction>>> {
  return actionsProtocolSearch.createSearchSourceAction(form);
}
export async function createSearchStrategyAction(  form: Parameters<typeof actionsProtocolSearch.createSearchStrategyAction>[0]): Promise<Awaited<ReturnType<typeof actionsProtocolSearch.createSearchStrategyAction>>> {
  return actionsProtocolSearch.createSearchStrategyAction(form);
}
export async function createSearchRunAction(  form: Parameters<typeof actionsProtocolSearch.createSearchRunAction>[0]): Promise<Awaited<ReturnType<typeof actionsProtocolSearch.createSearchRunAction>>> {
  return actionsProtocolSearch.createSearchRunAction(form);
}
export async function createRetrievedRecordAction(  form: Parameters<typeof actionsProtocolSearch.createRetrievedRecordAction>[0]): Promise<Awaited<ReturnType<typeof actionsProtocolSearch.createRetrievedRecordAction>>> {
  return actionsProtocolSearch.createRetrievedRecordAction(form);
}
export async function createPaperFromRetrievedRecordAction(  form: Parameters<typeof actionsProtocolSearch.createPaperFromRetrievedRecordAction>[0]): Promise<Awaited<ReturnType<typeof actionsProtocolSearch.createPaperFromRetrievedRecordAction>>> {
  return actionsProtocolSearch.createPaperFromRetrievedRecordAction(form);
}
export async function linkRetrievedRecordToPaperAction(  form: Parameters<typeof actionsProtocolSearch.linkRetrievedRecordToPaperAction>[0]): Promise<Awaited<ReturnType<typeof actionsProtocolSearch.linkRetrievedRecordToPaperAction>>> {
  return actionsProtocolSearch.linkRetrievedRecordToPaperAction(form);
}
export async function unlinkRetrievedRecordFromPaperAction(  form: Parameters<typeof actionsProtocolSearch.unlinkRetrievedRecordFromPaperAction>[0]): Promise<Awaited<ReturnType<typeof actionsProtocolSearch.unlinkRetrievedRecordFromPaperAction>>> {
  return actionsProtocolSearch.unlinkRetrievedRecordFromPaperAction(form);
}
export async function relinkRetrievedRecordAction(  form: Parameters<typeof actionsProtocolSearch.relinkRetrievedRecordAction>[0]): Promise<Awaited<ReturnType<typeof actionsProtocolSearch.relinkRetrievedRecordAction>>> {
  return actionsProtocolSearch.relinkRetrievedRecordAction(form);
}
export async function confirmSameWorkAction(  form: Parameters<typeof actionsProtocolSearch.confirmSameWorkAction>[0]): Promise<Awaited<ReturnType<typeof actionsProtocolSearch.confirmSameWorkAction>>> {
  return actionsProtocolSearch.confirmSameWorkAction(form);
}
export async function confirmSameWorkAndResolveAction(  form: Parameters<typeof actionsProtocolSearch.confirmSameWorkAndResolveAction>[0]): Promise<Awaited<ReturnType<typeof actionsProtocolSearch.confirmSameWorkAndResolveAction>>> {
  return actionsProtocolSearch.confirmSameWorkAndResolveAction(form);
}
export async function decideDifferentWorkAction(  form: Parameters<typeof actionsProtocolSearch.decideDifferentWorkAction>[0]): Promise<Awaited<ReturnType<typeof actionsProtocolSearch.decideDifferentWorkAction>>> {
  return actionsProtocolSearch.decideDifferentWorkAction(form);
}
export async function correctDifferentWorkAndResolveAction(  form: Parameters<typeof actionsProtocolSearch.correctDifferentWorkAndResolveAction>[0]): Promise<Awaited<ReturnType<typeof actionsProtocolSearch.correctDifferentWorkAndResolveAction>>> {
  return actionsProtocolSearch.correctDifferentWorkAndResolveAction(form);
}
export async function linkExtractionFieldAction(  form: Parameters<typeof actionsResearchQuestion.linkExtractionFieldAction>[0]): Promise<Awaited<ReturnType<typeof actionsResearchQuestion.linkExtractionFieldAction>>> {
  return actionsResearchQuestion.linkExtractionFieldAction(form);
}
export async function unlinkExtractionFieldAction(  form: Parameters<typeof actionsResearchQuestion.unlinkExtractionFieldAction>[0]): Promise<Awaited<ReturnType<typeof actionsResearchQuestion.unlinkExtractionFieldAction>>> {
  return actionsResearchQuestion.unlinkExtractionFieldAction(form);
}
export async function linkEvidenceSetAction(  form: Parameters<typeof actionsResearchQuestion.linkEvidenceSetAction>[0]): Promise<Awaited<ReturnType<typeof actionsResearchQuestion.linkEvidenceSetAction>>> {
  return actionsResearchQuestion.linkEvidenceSetAction(form);
}
export async function unlinkEvidenceSetAction(  form: Parameters<typeof actionsResearchQuestion.unlinkEvidenceSetAction>[0]): Promise<Awaited<ReturnType<typeof actionsResearchQuestion.unlinkEvidenceSetAction>>> {
  return actionsResearchQuestion.unlinkEvidenceSetAction(form);
}
export async function linkSynthesisStatementAction(  form: Parameters<typeof actionsResearchQuestion.linkSynthesisStatementAction>[0]): Promise<Awaited<ReturnType<typeof actionsResearchQuestion.linkSynthesisStatementAction>>> {
  return actionsResearchQuestion.linkSynthesisStatementAction(form);
}
export async function unlinkSynthesisStatementAction(  form: Parameters<typeof actionsResearchQuestion.unlinkSynthesisStatementAction>[0]): Promise<Awaited<ReturnType<typeof actionsResearchQuestion.unlinkSynthesisStatementAction>>> {
  return actionsResearchQuestion.unlinkSynthesisStatementAction(form);
}
export async function linkClaimAction(  form: Parameters<typeof actionsResearchQuestion.linkClaimAction>[0]): Promise<Awaited<ReturnType<typeof actionsResearchQuestion.linkClaimAction>>> {
  return actionsResearchQuestion.linkClaimAction(form);
}
export async function unlinkClaimAction(  form: Parameters<typeof actionsResearchQuestion.unlinkClaimAction>[0]): Promise<Awaited<ReturnType<typeof actionsResearchQuestion.unlinkClaimAction>>> {
  return actionsResearchQuestion.unlinkClaimAction(form);
}
export async function appendResearchQuestionAnswerAction(  form: Parameters<typeof actionsResearchQuestion.appendResearchQuestionAnswerAction>[0]): Promise<Awaited<ReturnType<typeof actionsResearchQuestion.appendResearchQuestionAnswerAction>>> {
  return actionsResearchQuestion.appendResearchQuestionAnswerAction(form);
}
export async function applyResearchQuestionAnswerToSectionAction(  form: Parameters<typeof actionsResearchQuestion.applyResearchQuestionAnswerToSectionAction>[0]): Promise<Awaited<ReturnType<typeof actionsResearchQuestion.applyResearchQuestionAnswerToSectionAction>>> {
  return actionsResearchQuestion.applyResearchQuestionAnswerToSectionAction(form);
}
export async function createScreeningCriterionAction(  form: Parameters<typeof actionsScreening.createScreeningCriterionAction>[0]): Promise<Awaited<ReturnType<typeof actionsScreening.createScreeningCriterionAction>>> {
  return actionsScreening.createScreeningCriterionAction(form);
}
export async function archiveScreeningCriterionAction(  form: Parameters<typeof actionsScreening.archiveScreeningCriterionAction>[0]): Promise<Awaited<ReturnType<typeof actionsScreening.archiveScreeningCriterionAction>>> {
  return actionsScreening.archiveScreeningCriterionAction(form);
}
export async function recordScreeningDecisionAction(  form: Parameters<typeof actionsScreening.recordScreeningDecisionAction>[0]): Promise<Awaited<ReturnType<typeof actionsScreening.recordScreeningDecisionAction>>> {
  return actionsScreening.recordScreeningDecisionAction(form);
}
export async function createFullTextScreeningCriterionAction(  form: Parameters<typeof actionsScreening.createFullTextScreeningCriterionAction>[0]): Promise<Awaited<ReturnType<typeof actionsScreening.createFullTextScreeningCriterionAction>>> {
  return actionsScreening.createFullTextScreeningCriterionAction(form);
}
export async function archiveFullTextScreeningCriterionAction(  form: Parameters<typeof actionsScreening.archiveFullTextScreeningCriterionAction>[0]): Promise<Awaited<ReturnType<typeof actionsScreening.archiveFullTextScreeningCriterionAction>>> {
  return actionsScreening.archiveFullTextScreeningCriterionAction(form);
}
export async function recordFullTextScreeningDecisionAction(  form: Parameters<typeof actionsScreening.recordFullTextScreeningDecisionAction>[0]): Promise<Awaited<ReturnType<typeof actionsScreening.recordFullTextScreeningDecisionAction>>> {
  return actionsScreening.recordFullTextScreeningDecisionAction(form);
}
export async function recordFullTextRetrievalAttemptAction(  form: Parameters<typeof actionsScreening.recordFullTextRetrievalAttemptAction>[0]): Promise<Awaited<ReturnType<typeof actionsScreening.recordFullTextRetrievalAttemptAction>>> {
  return actionsScreening.recordFullTextRetrievalAttemptAction(form);
}
export async function createSynthesisStatementAction(  form: Parameters<typeof actionsSynthesis.createSynthesisStatementAction>[0]): Promise<Awaited<ReturnType<typeof actionsSynthesis.createSynthesisStatementAction>>> {
  return actionsSynthesis.createSynthesisStatementAction(form);
}
export async function reviseSynthesisStatementAction(  form: Parameters<typeof actionsSynthesis.reviseSynthesisStatementAction>[0]): Promise<Awaited<ReturnType<typeof actionsSynthesis.reviseSynthesisStatementAction>>> {
  return actionsSynthesis.reviseSynthesisStatementAction(form);
}
export async function withdrawSynthesisStatementAction(  form: Parameters<typeof actionsSynthesis.withdrawSynthesisStatementAction>[0]): Promise<Awaited<ReturnType<typeof actionsSynthesis.withdrawSynthesisStatementAction>>> {
  return actionsSynthesis.withdrawSynthesisStatementAction(form);
}
export async function createSynthesisPreparationAction(  form: Parameters<typeof actionsSynthesis.createSynthesisPreparationAction>[0]): Promise<Awaited<ReturnType<typeof actionsSynthesis.createSynthesisPreparationAction>>> {
  return actionsSynthesis.createSynthesisPreparationAction(form);
}
export async function updateSynthesisPreparationAction(  form: Parameters<typeof actionsSynthesis.updateSynthesisPreparationAction>[0]): Promise<Awaited<ReturnType<typeof actionsSynthesis.updateSynthesisPreparationAction>>> {
  return actionsSynthesis.updateSynthesisPreparationAction(form);
}
export async function replaceSynthesisPreparationSelectionsAction(  form: Parameters<typeof actionsSynthesis.replaceSynthesisPreparationSelectionsAction>[0]): Promise<Awaited<ReturnType<typeof actionsSynthesis.replaceSynthesisPreparationSelectionsAction>>> {
  return actionsSynthesis.replaceSynthesisPreparationSelectionsAction(form);
}
export async function abandonSynthesisPreparationAction(  form: Parameters<typeof actionsSynthesis.abandonSynthesisPreparationAction>[0]): Promise<Awaited<ReturnType<typeof actionsSynthesis.abandonSynthesisPreparationAction>>> {
  return actionsSynthesis.abandonSynthesisPreparationAction(form);
}
export async function finalizeSynthesisPreparationAction(  form: Parameters<typeof actionsSynthesis.finalizeSynthesisPreparationAction>[0]): Promise<Awaited<ReturnType<typeof actionsSynthesis.finalizeSynthesisPreparationAction>>> {
  return actionsSynthesis.finalizeSynthesisPreparationAction(form);
}
export async function appendSynthesisInterpretationAction(  form: Parameters<typeof actionsSynthesis.appendSynthesisInterpretationAction>[0]): Promise<Awaited<ReturnType<typeof actionsSynthesis.appendSynthesisInterpretationAction>>> {
  return actionsSynthesis.appendSynthesisInterpretationAction(form);
}
