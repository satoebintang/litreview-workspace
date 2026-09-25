import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import type { DocumentStorage } from "@/infrastructure/document-storage";
import {
  createProjectPaperServices,
} from "./review-services/project-paper-services";
import { createEvidenceServices } from "./review-services/evidence-services";
import { createScreeningServices } from "./review-services/screening-services";
import { createExtractionServices } from "./review-services/extraction-services";
import { createSynthesisServices } from "./review-services/synthesis-services";
import { createClaimServices } from "./review-services/claim-services";
import {
  createRequireClaim,
  createRequireCriterion,
  createRequireEvidence,
  createRequireExtractionField,
  createRequirePaper,
  createRequireProject,
} from "./review-services/shared";
import {
  ClaimRepository,
  ClaimRevisionRepository,
  ClaimRevisionSupportRepository,
  EvidenceRepository,
  ExtractionFieldRepository,
  ExtractionOptionRepository,
  ExtractionRevisionEvidenceRepository,
  ExtractionRevisionRepository,
  ExtractionValueRepository,
  FullTextRetrievalAttemptRepository,
  FullTextScreeningCriterionRepository,
  FullTextScreeningDecisionRepository,
  PaperRepository,
  PaperReviewRepository,
  ProjectRepository,
  ScreeningCriterionRepository,
  ScreeningDecisionRepository,
  SynthesisRevisionRepository,
  SynthesisRevisionSupportRepository,
  SynthesisStatementRepository,
} from "./repositories";
import { createManuscriptServices } from "./manuscript-services";
import { createManuscriptProseHistoryServices } from "./manuscript-prose-history-services";
import { createManuscriptReviewServices } from "./manuscript-review-services";
import { createManuscriptSnapshotServices } from "./manuscript-snapshot-services";
import { createAcquisitionServices } from "./acquisition-services";
import { createProjectWorkspaceReadServices } from "./project-workspace-read-services";
import { createDeduplicationServices } from "./deduplication-services";
import { createReviewReportingServices } from "./review-reporting";
import { createFullTextDocumentServices, type FullTextDocumentServices } from "./full-text-document-services";
import {
  createDocumentTextExtractionServices,
  type DocumentTextExtractionParser,
  type DocumentTextExtractionServices,
} from "./document-text-extraction-services";
import { createEvidenceCurationServices } from "./evidence-curation-services";
import { createEvidenceSetServices } from "./evidence-set-services";
import { createSynthesisPreparationServices } from "./synthesis-preparation-services";
import { createSynthesisInterpretationServices } from "./synthesis-interpretation-services";
import {
  createResearchQuestionTraceabilityServices,
  type ResearchQuestionTraceabilityServices,
} from "./research-question-traceability-services";
import {
  createResearchQuestionCoverageServices,
  type ResearchQuestionCoverageServices,
} from "./research-question-coverage-services";
import type { DbOrTx } from "./research-question-traceability-repository";
import {
  createResearchQuestionAnswerReadServices,
  type ResearchQuestionAnswerReadServices,
} from "./research-question-answer-read-services";
import {
  createResearchQuestionAnswerWriteServices,
  type ResearchQuestionAnswerWriteServices,
  type AnswerClaimRevisionResolution,
  type AnswerSynthesisRevisionResolution,
} from "./research-question-answer-write-services";
import {
  createResearchQuestionAnswerManuscriptServices,
  type ResearchQuestionAnswerManuscriptServices,
} from "./research-question-answer-manuscript-services";
import { createBibliographicImportServices, type BibliographicParser, type BibliographicImportServices } from "./bibliographic-import-services";
import { createPdfIntakeServices, type PdfIntakeStorage, type PdfMetadataInspector } from "./pdf-intake-services";
import { createCriticalAppraisalServices } from "./critical-appraisal-services";

export function createReviewServices(db: Database, options: {
  documentStorage?: DocumentStorage;
  pdfIntakeStorage?: PdfIntakeStorage;
  pdfMetadataInspector?: PdfMetadataInspector;
  maxDocumentBytes?: number;
  documentTextExtractor?: DocumentTextExtractionParser;
  bibliographicParser?: BibliographicParser;
} = {}) {
  const projectRepo = new ProjectRepository(db);
  const paperRepo = new PaperRepository(db);
  const evidenceRepo = new EvidenceRepository(db);
  const claimRepo = new ClaimRepository(db);
  const criterionRepo = new ScreeningCriterionRepository(db);
  const decisionRepo = new ScreeningDecisionRepository(db);
  const extractionFieldRepo = new ExtractionFieldRepository(db);
  const extractionOptionRepo = new ExtractionOptionRepository(db);
  const extractionValueRepo = new ExtractionValueRepository(db);
  const extractionRevisionRepo = new ExtractionRevisionRepository(db);
  const extractionEvidenceRepo = new ExtractionRevisionEvidenceRepository(db);
  const synthesisStatementRepo = new SynthesisStatementRepository(db);
  const synthesisRevisionRepo = new SynthesisRevisionRepository(db);
  const synthesisSupportRepo = new SynthesisRevisionSupportRepository(db);
  const claimRevisionRepo = new ClaimRevisionRepository(db);
  const claimRevisionSupportRepo = new ClaimRevisionSupportRepository(db);
  const fullTextCriterionRepo = new FullTextScreeningCriterionRepository(db);
  const fullTextDecisionRepo = new FullTextScreeningDecisionRepository(db);
  const paperReviewRepo = new PaperReviewRepository(db);
  const fullTextRetrievalRepo = new FullTextRetrievalAttemptRepository(db);
  const bibliographicImportServices: BibliographicImportServices | null = options.bibliographicParser
    ? createBibliographicImportServices(db, { parser: options.bibliographicParser })
    : null;

  const requireProject = createRequireProject(projectRepo);
  const requirePaper = createRequirePaper(requireProject, paperRepo);
  const requireEvidence = createRequireEvidence(requireProject, evidenceRepo);
  const requireClaim = createRequireClaim(requireProject, claimRepo);
  const requireCriterion = createRequireCriterion(requireProject, criterionRepo);
  const requireExtractionField = createRequireExtractionField(requireProject, extractionFieldRepo);

  const synthesisProvenanceReceiver: { services?: Pick<ReturnType<typeof createSynthesisServices>, "getSynthesisProvenance"> } = {};
  let synthesisInterpretationServicesInstance: ReturnType<typeof createSynthesisInterpretationServices> | null = null;
  function getSynthesisInterpretationServices() {
    if (!synthesisInterpretationServicesInstance) {
      synthesisInterpretationServicesInstance = createSynthesisInterpretationServices(db, {
        requireProject,
        getSynthesisProvenance: (projectId, statementId, revisionId) => synthesisProvenanceReceiver.services!.getSynthesisProvenance(projectId, statementId, revisionId),
      });
    }
    return synthesisInterpretationServicesInstance;
  }

  const projectPaperServices = createProjectPaperServices({ db, projectRepo, paperRepo, decisionRepo, evidenceRepo, requireProject, requirePaper });
  const evidenceServices = createEvidenceServices({ db, evidenceRepo, requireProject, requirePaper, requireEvidence });
  const screeningServices = createScreeningServices({
    db, criterionRepo, decisionRepo, paperRepo, paperReviewRepo, fullTextCriterionRepo, fullTextDecisionRepo, fullTextRetrievalRepo,
    requireProject, requirePaper, requireCriterion,
  });
  const extractionServices = createExtractionServices({
    db, projectRepo, paperRepo, paperReviewRepo, decisionRepo, extractionFieldRepo, extractionOptionRepo, extractionValueRepo,
    extractionRevisionRepo, extractionEvidenceRepo, synthesisSupportRepo,
    requireProject, requirePaper, requireExtractionField,
  });
  const synthesisServices = createSynthesisServices({
    db, paperRepo, synthesisStatementRepo, synthesisRevisionRepo, synthesisSupportRepo, requireProject,
  });
  const claimServices = createClaimServices({
    db, paperRepo, evidenceRepo, claimRevisionRepo, claimRevisionSupportRepo, synthesisRevisionRepo, synthesisSupportRepo,
    requireProject, requireClaim, requireEvidence, getSynthesisInterpretationServices,
  });
  const services = Object.assign(
    {},
    projectPaperServices,
    evidenceServices,
    screeningServices,
    extractionServices,
    synthesisServices,
    claimServices,
  ) as typeof projectPaperServices &
    typeof evidenceServices &
    typeof screeningServices &
    typeof extractionServices &
    typeof synthesisServices &
    typeof claimServices;
  // Keep the explicit interpretation callback pointed at the same object that
  // is extended by the later Object.assign composition stages.
  synthesisProvenanceReceiver.services = services;
  const deduplicationServices = createDeduplicationServices(db);
  const manuscriptServices = createManuscriptServices(db);
  const manuscriptProseHistoryServices = createManuscriptProseHistoryServices(db);
  const manuscriptReviewServices = createManuscriptReviewServices(db);
  const manuscriptSnapshotServices = createManuscriptSnapshotServices(db, manuscriptServices.loadManuscriptProjection);
  const acquisitionServices = createAcquisitionServices(db);
  const projectWorkspaceReadServices = createProjectWorkspaceReadServices(db);
  const documentServices: FullTextDocumentServices = createFullTextDocumentServices(db, options.documentStorage, options.maxDocumentBytes);
  const baseServices = Object.assign(services, manuscriptServices, manuscriptProseHistoryServices, manuscriptReviewServices, manuscriptSnapshotServices, acquisitionServices, deduplicationServices, documentServices as unknown as Record<string, unknown>) as typeof services & typeof manuscriptServices & typeof manuscriptProseHistoryServices & typeof manuscriptReviewServices & typeof manuscriptSnapshotServices & typeof acquisitionServices & typeof deduplicationServices & FullTextDocumentServices;
  const textExtractionParser: DocumentTextExtractionParser = options.documentTextExtractor ?? {
    extractorKey: "unconfigured",
    extractorVersion: "unconfigured",
    algorithmVersion: "unconfigured",
    async extract() {
      throw new DomainError("STORAGE_ERROR", "PDF text extraction is not configured");
    },
  };
  const textExtractionServices: DocumentTextExtractionServices = createDocumentTextExtractionServices(db, {
    storage: options.documentStorage,
    parser: textExtractionParser,
    maxBytes: options.maxDocumentBytes,
  });
  const pdfIntakeServices = createPdfIntakeServices(db, {
    intakeStorage: options.pdfIntakeStorage,
    documentStorage: options.documentStorage,
    metadataInspector: options.pdfMetadataInspector,
    maxBytes: options.maxDocumentBytes,
  });
  const reportingServices = createReviewReportingServices(db, deduplicationServices);
  const curationServices = createEvidenceCurationServices(db, { requireProject, requireEvidence });
  const criticalAppraisalServices = createCriticalAppraisalServices(db, { requireProject, requirePaper, requireEvidence });
  const evidenceSetServices = createEvidenceSetServices(db, { requireProject, requireEvidence });
  const synthesisPreparationServices = createSynthesisPreparationServices(db, {
    requireProject,
    paperRepo,
    synthesisStatementRepo,
    synthesisRevisionRepo,
    synthesisSupportRepo,
    extractionFieldRepo,
  });
  const synthesisInterpretationServices = getSynthesisInterpretationServices();
  const traceabilityServices = createResearchQuestionTraceabilityServices(db);
  const coverageServices = createResearchQuestionCoverageServices(db, traceabilityServices.repo);

  // Slice 21 Answer composition deliberately delegates support semantics to
  // the released Claim/Synthesis resolvers above.  The transaction argument
  // is used to resolve the exact submitted identity; stable-parent locks are
  // held before these adapters call the canonical read models, so a newer
  // revision cannot silently float the submitted context.
  const resolveAnswerClaimRevision = async (
    projectId: string,
    revisionId: string,
    tx: DbOrTx,
  ): Promise<AnswerClaimRevisionResolution | null> => {
    const rows = await tx.execute(sql`
      select id, project_id, claim_id
      from claim_revisions
      where project_id = ${projectId} and id = ${revisionId}
      limit 1
    `) as unknown as Record<string, unknown>[];
    const row = rows[0];
    if (!row) return null;
    const claimId = String(row.claim_id);
    const exact = await services.getClaimRevision(projectId, claimId, revisionId);
    let current: Awaited<ReturnType<typeof services.getCurrentClaim>> | null = null;
    try {
      current = await services.getCurrentClaim(projectId, claimId);
    } catch (error) {
      if (!(error instanceof DomainError && error.code === "NOT_FOUND")) throw error;
    }
    return {
      projectId: exact.revision.projectId,
      claimId,
      revisionId: exact.revision.id,
      sequence: exact.revision.sequence,
      state: exact.revision.lifecycle,
      finalizedAt: exact.revision.finalizedAt,
      currentRevisionId: current?.currentRevision.id ?? null,
      currentRevisionSequence: current?.currentRevision.sequence ?? null,
      currentRevisionState: current?.currentRevision.lifecycle ?? null,
      isCurrentRevision: current?.currentRevision.id === exact.revision.id,
      supportStatus: exact.revision.supportStatus,
      supportCount: exact.revision.totalSupportCount,
    };
  };

  const resolveAnswerSynthesisRevision = async (
    projectId: string,
    revisionId: string,
    tx: DbOrTx,
  ): Promise<AnswerSynthesisRevisionResolution | null> => {
    const rows = await tx.execute(sql`
      select id, project_id, synthesis_statement_id
      from synthesis_revisions
      where project_id = ${projectId} and id = ${revisionId}
      limit 1
    `) as unknown as Record<string, unknown>[];
    const row = rows[0];
    if (!row) return null;
    const statementId = String(row.synthesis_statement_id);
    const exact = await services.getSynthesisProvenance(projectId, statementId, revisionId);
    const current = await services.getCurrentSynthesis(projectId, statementId);
    return {
      projectId: exact.projectId,
      synthesisStatementId: statementId,
      revisionId: exact.id,
      sequence: exact.sequence,
      state: exact.state,
      finalizedAt: exact.finalizedAt,
      currentRevisionId: current?.id ?? null,
      currentRevisionSequence: current?.sequence ?? null,
      currentRevisionState: current?.state ?? null,
      isCurrentRevision: current?.id === exact.id,
      supportStatus: exact.supportStatus,
      supportCount: exact.supportingRevisionCount,
    };
  };

  const answerWriteServices: ResearchQuestionAnswerWriteServices = createResearchQuestionAnswerWriteServices(db, {
    traceabilityRepository: traceabilityServices.repo,
    claimRevisionResolver: resolveAnswerClaimRevision,
    synthesisRevisionResolver: resolveAnswerSynthesisRevision,
  });
  const answerReadServices: ResearchQuestionAnswerReadServices = createResearchQuestionAnswerReadServices(db, {
    getCurrentLinksForQuestion: (projectId, questionId) => traceabilityServices.repo.listCurrentLinksForQuestion(projectId, questionId),
    getCurrentLinksForProject: (projectId, questionIds) => traceabilityServices.repo.listCurrentLinksForProject(projectId, questionIds),
    getCurrentClaim: (projectId, claimId) => services.getCurrentClaim(projectId, claimId),
    getClaimRevision: (projectId, claimId, revisionId) => services.getClaimRevision(projectId, claimId, revisionId),
    getCurrentSynthesis: (projectId, statementId) => services.getCurrentSynthesis(projectId, statementId),
    getSynthesisProvenance: (projectId, statementId, revisionId) => services.getSynthesisProvenance(projectId, statementId, revisionId),
  });
  const answerManuscriptServices: ResearchQuestionAnswerManuscriptServices = createResearchQuestionAnswerManuscriptServices(db, {
    getAnswerSnapshot: answerReadServices.getResearchQuestionAnswerSnapshot,
    resolveClaimRevision: resolveAnswerClaimRevision,
  });
  return Object.assign(
    baseServices,
    textExtractionServices,
    pdfIntakeServices,
    reportingServices,
    curationServices,
    criticalAppraisalServices,
    evidenceSetServices,
    synthesisPreparationServices,
    synthesisInterpretationServices,
    traceabilityServices,
    coverageServices,
    answerWriteServices,
    answerReadServices,
    answerManuscriptServices,
    projectWorkspaceReadServices,
    ...(bibliographicImportServices ? [bibliographicImportServices] : []),
  ) as typeof baseServices &
    typeof reportingServices &
    DocumentTextExtractionServices &
    typeof pdfIntakeServices &
    typeof curationServices &
    typeof criticalAppraisalServices &
    typeof evidenceSetServices &
    typeof synthesisPreparationServices &
    typeof synthesisInterpretationServices &
    ResearchQuestionTraceabilityServices &
    ResearchQuestionCoverageServices &
    ResearchQuestionAnswerWriteServices &
    ResearchQuestionAnswerReadServices &
    ResearchQuestionAnswerManuscriptServices &
    ReturnType<typeof createProjectWorkspaceReadServices> &
    Partial<BibliographicImportServices>;
}

export { createSynthesisInterpretationServices, createResearchQuestionTraceabilityServices, createResearchQuestionCoverageServices };
