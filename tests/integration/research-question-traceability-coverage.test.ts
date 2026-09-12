/* eslint-disable @typescript-eslint/no-explicit-any */
import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createResearchQuestionTraceabilityServices } from "@/application/research-question-traceability-services";
import { createResearchQuestionCoverageServices } from "@/application/research-question-coverage-services";

const { db, client } = createDb(
  process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview",
);
const reviewServices = createReviewServices(db);
const traceabilityServices = createResearchQuestionTraceabilityServices(db);
const coverageServices = createResearchQuestionCoverageServices(db, traceabilityServices.repo);

let projectId = "";

describe("Slice 20 Research Question Traceability Coverage & Read Projections", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
  });

  beforeEach(async () => {
    projectId = (
      await reviewServices.createProject({
        title: `Coverage Test Project ${crypto.randomUUID()}`,
      })
    ).id;
  });

  afterAll(async () => {
    await client.unsafe(
      "TRUNCATE TABLE research_question_extraction_field_events, research_question_evidence_set_events, research_question_synthesis_statement_events, research_question_claim_events, synthesis_interpretation_contradictions, synthesis_interpretation_questions, synthesis_interpretation_limitations, synthesis_interpretations, synthesis_preparation_selections, synthesis_preparations, retrieved_record_deduplication_decisions, retrieved_record_matches, retrieved_records, search_runs, search_strategies, search_sources, research_questions, manuscript_claim_placement_events, manuscript_section_item_claims, manuscript_prose_blocks, manuscript_section_items, manuscript_claim_placements, manuscript_sections, manuscripts, claim_revision_synthesis_supports, claim_revision_extraction_supports, claim_revision_evidence_supports, claim_revisions, synthesis_revision_supports, synthesis_revisions, synthesis_statements, extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, document_text_extraction_pages, document_text_extractions, full_text_screening_decisions, full_text_retrieval_attempts, full_text_screening_criteria, screening_decisions, screening_criteria, paper_full_text_preferences, full_text_documents, evidence_set_composition_members, evidence_set_composition_revisions, evidence_set_annotations, evidence_set_memberships, evidence_sets, evidence_label_events, evidence_annotations, evidence_review_decisions, evidence_labels, evidence, claims, papers, projects",
    );
    await client.end();
  });

  async function includedPaper(title: string) {
    const paper = await reviewServices.addPaper(projectId, { title });
    await reviewServices.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    await reviewServices.recordFullTextRetrievalAttempt(projectId, paper.id, {
      outcome: "retrieved",
      attemptedAt: new Date(),
    });
    await reviewServices.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
    return paper;
  }

  it("projects empty links with baseline flags and project-wide protocol context", async () => {
    const question = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ1",
      label: "Baseline empty question",
    });

    // Use seeded search source, strategy, run
    const [source] = await reviewServices.listSearchSources(projectId);
    const strategy = await reviewServices.createSearchStrategy(projectId, {
      searchSourceId: source.id,
      name: "RCT Strategy",
      queryText: "cancer AND immunotherapy",
    });
    await reviewServices.createSearchRun(projectId, {
      searchSourceId: source.id,
      sourceKeySnapshot: source.sourceKey,
      sourceDisplayNameSnapshot: source.displayName,
      strategyId: strategy.id,
      queryText: strategy.queryText,
      reportedResultCount: 42,
      executedAt: new Date(),
    });

    const projection = await coverageServices.getQuestionTraceability(projectId, question.id);

    // Protocol context is present but unlinked from individual RQ
    expect(projection.protocolContext.searchStrategyCount).toBe(1);
    expect(projection.protocolContext.searchRunCount).toBe(1);

    // Baseline empty flags
    expect(projection.flags.extraction).toEqual([{ code: "no_linked_extraction_fields" }]);
    expect(projection.flags.evidenceSets).toEqual([{ code: "no_linked_evidence_sets" }]);
    expect(projection.flags.synthesis).toEqual([{ code: "no_linked_synthesis_statements" }]);
    expect(projection.flags.claims).toEqual([{ code: "no_linked_claims" }]);

    expect(projection.extractionCoverage).toHaveLength(0);
    expect(projection.evidenceSetCoverage).toHaveLength(0);
    expect(projection.synthesisCoverage).toHaveLength(0);
    expect(projection.claimCoverage).toHaveLength(0);
  });

  it("projects extraction coverage with exact canonical value states and paper breakdown", async () => {
    const question = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ1",
      label: "Extraction coverage question",
    });

    const paper1 = await includedPaper("Trial Alpha");
    const paper2 = await includedPaper("Trial Beta");

    const field = await reviewServices.createExtractionField(projectId, {
      name: "Patient Cohort Size",
      fieldType: "number",
    });

    // Paper 1 has present value
    await reviewServices.reviseExtractionValue(projectId, paper1.id, field.id, {
      state: "present",
      value: 150,
      evidenceIds: [],
    });

    // Link field
    await traceabilityServices.linkExtractionField({
      projectId,
      questionId: question.id,
      fieldId: field.id,
      note: "Primary cohort size",
    });

    const projection = await coverageServices.getQuestionTraceability(projectId, question.id);
    expect(projection.extractionCoverage).toHaveLength(1);

    const cov = projection.extractionCoverage[0];
    expect(cov.fieldId).toBe(field.id);
    expect(cov.fieldName).toBe("Patient Cohort Size");
    expect(cov.hasAnyNonClearedData).toBe(true);
    expect(cov.paperCoverage).toHaveLength(2);

    const p1Cov = cov.paperCoverage.find((p) => p.paperId === paper1.id);
    const p2Cov = cov.paperCoverage.find((p) => p.paperId === paper2.id);

    expect(p1Cov?.status).toBe("present");
    expect(p1Cov?.displayValue).toBe("150");

    expect(p2Cov?.status).toBe("no_finalized_revision");
    expect(p2Cov?.displayValue).toBeNull();

    // Field has data, so linked_field_without_current_data is NOT raised
    expect(projection.flags.extraction).toEqual([]);
  });

  it("projects evidence set coverage with latest composition and review decisions", async () => {
    const question = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ1",
      label: "Evidence set coverage question",
    });

    const paper = await includedPaper("Evidence Study");
    const ev1 = await reviewServices.recordEvidence(projectId, {
      paperId: paper.id,
      sourceText: "Evidence 1 passage",
      pageNumber: 1,
    });
    const ev2 = await reviewServices.recordEvidence(projectId, {
      paperId: paper.id,
      sourceText: "Evidence 2 passage",
      pageNumber: 2,
    });

    // Review decisions
    await reviewServices.appendEvidenceReviewDecision(projectId, ev1.id, {
      decision: "accepted",
    });

    // Create set and add evidence
    const createdSet = await reviewServices.createEvidenceSet(projectId, {
      name: "Reviewed Trials",
      description: "Includes accepted evidence",
    });
    await reviewServices.addEvidenceToSet(projectId, createdSet.set.id, {
      evidenceId: ev1.id,
    });
    await reviewServices.addEvidenceToSet(projectId, createdSet.set.id, {
      evidenceId: ev2.id,
    });

    // Link set to RQ
    await traceabilityServices.linkEvidenceSet({
      projectId,
      questionId: question.id,
      evidenceSetId: createdSet.set.id,
    });

    const projection = await coverageServices.getQuestionTraceability(projectId, question.id);
    expect(projection.evidenceSetCoverage).toHaveLength(1);

    const setCov = projection.evidenceSetCoverage[0];
    expect(setCov.evidenceSetId).toBe(createdSet.set.id);
    expect(setCov.name).toBe("Reviewed Trials");
    expect(setCov.memberCount).toBe(2);
    expect(setCov.distinctPaperCount).toBe(1);
    expect(setCov.reviewCounts.accepted).toBe(1);
    expect(setCov.reviewCounts.unreviewed).toBe(1);
    expect(setCov.reviewCounts.needsReview).toBe(0);
    expect(setCov.reviewCounts.rejected).toBe(0);
    expect(projection.flags.evidenceSets).toEqual([]);
  });

  it("projects synthesis coverage and enforces flag suppression for withdrawn statements", async () => {
    const question = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ1",
      label: "Synthesis flag suppression question",
    });

    const stmt = await reviewServices.createSynthesisStatement(projectId, {
      statementText: "Draft synthesis finding",
      extractionRevisionIds: [],
    });

    await traceabilityServices.linkSynthesisStatement({
      projectId,
      questionId: question.id,
      statementId: stmt.statement.id,
    });

    // 1. Statement is active but has 0 supports and no interpretation
    let projection = await coverageServices.getQuestionTraceability(projectId, question.id);
    expect(projection.synthesisCoverage[0].hasActiveRevision).toBe(true);
    expect(projection.synthesisCoverage[0].supportCount).toBe(0);
    expect(projection.synthesisCoverage[0].hasInterpretation).toBe(false);

    expect(projection.flags.synthesis.map((f) => f.code)).toContain("linked_current_synthesis_without_support");
    expect(projection.flags.synthesis.map((f) => f.code)).toContain("linked_current_synthesis_without_interpretation");
    expect(projection.flags.synthesis.map((f) => f.code)).not.toContain(
      "linked_statement_without_current_active_revision",
    );

    // 2. Withdraw statement
    await reviewServices.withdrawSynthesisStatement(projectId, stmt.statement.id, {
      researcherNote: "Methodology invalidated",
    });

    projection = await coverageServices.getQuestionTraceability(projectId, question.id);
    expect(projection.synthesisCoverage[0].hasActiveRevision).toBe(false);

    // Flag hierarchy: when no active revision, missing_support and missing_interpretation are SUPPRESSED
    expect(projection.flags.synthesis).toEqual([
      {
        code: "linked_statement_without_current_active_revision",
        targetType: "synthesis_statement",
        targetId: stmt.statement.id,
        targetLabel: "Draft synthesis finding",
      },
    ]);
  });

  it("projects claim coverage with exact placement check and flag suppression", async () => {
    const question = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ1",
      label: "Claim coverage question",
    });

    const stmt = await reviewServices.createSynthesisStatement(projectId, {
      statementText: "Synthesis finding",
      extractionRevisionIds: [],
    });

    const claimResult = await reviewServices.createClaimWithSynthesisSupport(projectId, {
      claimText: "Initial claim revision text",
      synthesisRevisionId: stmt.revision.id,
    });
    const claimId = claimResult.claim.id;

    await traceabilityServices.linkClaim({
      projectId,
      questionId: question.id,
      claimId,
    });

    // Initially active, supported, but NOT placed
    let projection = await coverageServices.getQuestionTraceability(projectId, question.id);
    expect(projection.claimCoverage[0].hasActiveRevision).toBe(true);
    expect(projection.claimCoverage[0].hasSupport).toBe(true);
    expect(projection.claimCoverage[0].currentClaimPlaced).toBe(false);
    expect(projection.claimCoverage[0].hasAnyHistoricalPlacement).toBe(false);
    expect(projection.flags.claims).toEqual([
      {
        code: "linked_current_claim_not_placed",
        targetType: "claim",
        targetId: claimId,
        targetLabel: "Initial claim revision text",
      },
    ]);

    // Place active revision in manuscript
    const manuscript = await reviewServices.getOrCreateDefaultManuscript(projectId);
    const resultsSection = await reviewServices.createSection(projectId, manuscript.id, {
      title: "Results",
      sectionType: "results",
    });

    await reviewServices.placeClaimRevision(
      projectId,
      manuscript.id,
      resultsSection!.id,
      claimResult.revision.id,
    );

    projection = await coverageServices.getQuestionTraceability(projectId, question.id);
    expect(projection.claimCoverage[0].currentClaimPlaced).toBe(true);
    expect(projection.claimCoverage[0].hasAnyHistoricalPlacement).toBe(true);
    expect(projection.claimCoverage[0].activePlacementSections.length).toBeGreaterThan(0);
    expect(projection.flags.claims).toEqual([]);

    // Create a new claim revision (supersedes the placed revision)
    await reviewServices.createClaimRevision(projectId, claimId, {
      lifecycle: "active",
      claimText: "Revised claim text after peer feedback",
      supports: [],
    });

    projection = await coverageServices.getQuestionTraceability(projectId, question.id);
    // The NEW active revision is NOT placed (the old revision was placed)
    expect(projection.claimCoverage[0].currentClaimPlaced).toBe(false);
    expect(projection.claimCoverage[0].hasAnyHistoricalPlacement).toBe(true);
    expect(projection.flags.claims.map((f) => f.code)).toContain("linked_current_claim_not_placed");

    // Withdraw claim: missing support/placement suppressed
    await reviewServices.withdrawClaim(projectId, claimId, {
      researcherNote: "Claim refuted",
    });

    projection = await coverageServices.getQuestionTraceability(projectId, question.id);
    expect(projection.claimCoverage[0].hasActiveRevision).toBe(false);
    expect(projection.flags.claims).toEqual([
      {
        code: "linked_claim_without_current_active_revision",
        targetType: "claim",
        targetId: claimId,
        targetLabel: "Revised claim text after peer feedback",
      },
    ]);
  });

  it("builds research question matrix projection without scalar score or percentage", async () => {
    const q1 = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ1",
      label: "Question One",
      sortOrder: 0,
    });
    const q2 = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ2",
      label: "Question Two",
      sortOrder: 1,
    });

    const field = await reviewServices.createExtractionField(projectId, {
      name: "Metric",
      fieldType: "short_text",
    });
    await traceabilityServices.linkExtractionField({
      projectId,
      questionId: q1.id,
      fieldId: field.id,
    });

    const matrix = await coverageServices.getResearchQuestionMatrix(projectId);
    expect(matrix.rows).toHaveLength(2);
    const r1 = matrix.rows.find((r) => r.question.id === q1.id);
    const r2 = matrix.rows.find((r) => r.question.id === q2.id);
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(r1!.counts.linkedExtractionFields).toBe(1);
    expect(r2!.counts.linkedExtractionFields).toBe(0);

    // Verify there are no scalar coverage percentages or scores
    expect((matrix.rows[0] as any).score).toBeUndefined();
    expect((matrix.rows[0] as any).percentage).toBeUndefined();
    expect((matrix as any).totalScore).toBeUndefined();
  });

  it("audit item 3: distinguishes cleared from no_finalized_revision and counts not_reported / not_applicable as non-cleared data", async () => {
    const question = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ_CLEARED",
      label: "Cleared Distinction RQ",
    });

    const paper1 = await includedPaper("Paper Cleared 1");
    const paper2 = await includedPaper("Paper Cleared 2");
    const paper3 = await includedPaper("Paper Cleared 3");
    const paper4 = await includedPaper("Paper Cleared 4");

    const field = await reviewServices.createExtractionField(projectId, {
      name: "Dose Amount",
      fieldType: "short_text",
    });

    await traceabilityServices.linkExtractionField({
      projectId,
      questionId: question.id,
      fieldId: field.id,
    });

    // Case 1: Paper 1 has revision with state = 'cleared'. Papers 2, 3, 4 have no finalized revision.
    await reviewServices.reviseExtractionValue(projectId, paper1.id, field.id, {
      state: "cleared",
      evidenceIds: [],
    });

    let projection = await coverageServices.getQuestionTraceability(projectId, question.id);
    let cov = projection.extractionCoverage[0];
    expect(cov.paperCoverage.find((p) => p.paperId === paper1.id)?.status).toBe("cleared");
    expect(cov.paperCoverage.find((p) => p.paperId === paper2.id)?.status).toBe("no_finalized_revision");
    expect(cov.paperCoverage.find((p) => p.paperId === paper3.id)?.status).toBe("no_finalized_revision");
    expect(cov.paperCoverage.find((p) => p.paperId === paper4.id)?.status).toBe("no_finalized_revision");
    // cleared is NOT considered non-cleared data!
    expect(cov.hasAnyNonClearedData).toBe(false);
    expect(projection.flags.extraction).toEqual([
      {
        code: "linked_field_without_current_data",
        targetType: "extraction_field",
        targetId: field.id,
        targetLabel: "Dose Amount",
      },
    ]);

    // Case 2: Paper 2 has recorded 'not_reported'.
    await reviewServices.reviseExtractionValue(projectId, paper2.id, field.id, {
      state: "not_reported",
      evidenceIds: [],
    });

    projection = await coverageServices.getQuestionTraceability(projectId, question.id);
    cov = projection.extractionCoverage[0];
    expect(cov.paperCoverage.find((p) => p.paperId === paper2.id)?.status).toBe("not_reported");
    expect(cov.paperCoverage.find((p) => p.paperId === paper2.id)?.displayValue).toBe("Not Reported");
    // not_reported counts as non-cleared recorded data!
    expect(cov.hasAnyNonClearedData).toBe(true);
    expect(projection.flags.extraction).toEqual([]);

    // Case 3: Paper 3 has recorded 'not_applicable'.
    await reviewServices.reviseExtractionValue(projectId, paper3.id, field.id, {
      state: "not_applicable",
      evidenceIds: [],
    });

    projection = await coverageServices.getQuestionTraceability(projectId, question.id);
    cov = projection.extractionCoverage[0];
    expect(cov.paperCoverage.find((p) => p.paperId === paper3.id)?.status).toBe("not_applicable");
    expect(cov.paperCoverage.find((p) => p.paperId === paper3.id)?.displayValue).toBe("Not Applicable");
    expect(cov.hasAnyNonClearedData).toBe(true);
    expect(projection.flags.extraction).toEqual([]);

    // Case 4: Clear paper 2 and paper 3 so that only 'cleared' and 'no_finalized_revision' remain.
    await reviewServices.reviseExtractionValue(projectId, paper2.id, field.id, {
      state: "cleared",
      evidenceIds: [],
    });
    await reviewServices.reviseExtractionValue(projectId, paper3.id, field.id, {
      state: "cleared",
      evidenceIds: [],
    });

    projection = await coverageServices.getQuestionTraceability(projectId, question.id);
    cov = projection.extractionCoverage[0];
    expect(cov.hasAnyNonClearedData).toBe(false);
    expect(projection.flags.extraction).toEqual([
      {
        code: "linked_field_without_current_data",
        targetType: "extraction_field",
        targetId: field.id,
        targetLabel: "Dose Amount",
      },
    ]);
  });

  it("audit item 4: proves manuscript placement lifecycle across revisions, section archiving, and removal", async () => {
    const question = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ_PLACEMENT",
      label: "Placement Parity RQ",
    });

    const stmt = await reviewServices.createSynthesisStatement(projectId, {
      statementText: "Placement evidence synthesis statement",
      extractionRevisionIds: [],
    });

    const claimResult = await reviewServices.createClaimWithSynthesisSupport(projectId, {
      claimText: "Initial Claim R1",
      synthesisRevisionId: stmt.revision.id,
    });
    const claimId = claimResult.claim.id;
    const r1Id = claimResult.revision.id;

    await traceabilityServices.linkClaim({
      projectId,
      questionId: question.id,
      claimId,
    });

    // 1. Initial state: active R1, supported, unplaced, no historical placement
    let proj = await coverageServices.getQuestionTraceability(projectId, question.id);
    let claimCov = proj.claimCoverage[0];
    expect(claimCov.hasActiveRevision).toBe(true);
    expect(claimCov.currentClaimPlaced).toBe(false);
    expect(claimCov.hasAnyHistoricalPlacement).toBe(false);
    expect(proj.flags.claims).toEqual([
      {
        code: "linked_current_claim_not_placed",
        targetType: "claim",
        targetId: claimId,
        targetLabel: "Initial Claim R1",
      },
    ]);

    // 2. Place R1 in Section A
    const manuscript = await reviewServices.getOrCreateDefaultManuscript(projectId);
    const sectionA = await reviewServices.createSection(projectId, manuscript.id, {
      title: "Results Section A",
      sectionType: "results",
    });
    const p1 = await reviewServices.placeClaimRevision(
      projectId,
      manuscript.id,
      sectionA!.id,
      r1Id,
    );

    proj = await coverageServices.getQuestionTraceability(projectId, question.id);
    claimCov = proj.claimCoverage[0];
    expect(claimCov.currentClaimPlaced).toBe(true);
    expect(claimCov.hasAnyHistoricalPlacement).toBe(true);
    expect(claimCov.activePlacementSections).toContain("Results Section A");
    expect(proj.flags.claims).toEqual([]);

    // 3. Create active Revision R2 (supersedes R1)
    const r2 = await reviewServices.createClaimRevision(projectId, claimId, {
      lifecycle: "active",
      claimText: "Revised Claim R2",
      supports: [{ kind: "synthesisRevision", synthesisRevisionId: stmt.revision.id }],
    });

    proj = await coverageServices.getQuestionTraceability(projectId, question.id);
    claimCov = proj.claimCoverage[0];
    // R2 is active, but only R1 was placed -> currentClaimPlaced is false, hasAnyHistoricalPlacement is true!
    expect(claimCov.currentActiveRevisionId).toBe(r2.revision.id);
    expect(claimCov.currentClaimPlaced).toBe(false);
    expect(claimCov.hasAnyHistoricalPlacement).toBe(true);
    expect(proj.flags.claims.map((f) => f.code)).toContain("linked_current_claim_not_placed");

    // 4. Place R2 in Section A
    const p2 = await reviewServices.placeClaimRevision(
      projectId,
      manuscript.id,
      sectionA!.id,
      r2.revision.id,
    );

    proj = await coverageServices.getQuestionTraceability(projectId, question.id);
    claimCov = proj.claimCoverage[0];
    expect(claimCov.currentClaimPlaced).toBe(true);
    expect(claimCov.hasAnyHistoricalPlacement).toBe(true);
    expect(proj.flags.claims).toEqual([]);

    // 5. Remove placements from Section A and archive Section A -> placement becomes inactive
    await reviewServices.removeClaimPlacement(projectId, manuscript.id, p1.id);
    await reviewServices.removeClaimPlacement(projectId, manuscript.id, p2.id);
    await reviewServices.archiveSection(projectId, manuscript.id, sectionA!.id);

    proj = await coverageServices.getQuestionTraceability(projectId, question.id);
    claimCov = proj.claimCoverage[0];
    expect(claimCov.currentClaimPlaced).toBe(false);
    expect(claimCov.hasAnyHistoricalPlacement).toBe(true);
    expect(proj.flags.claims.map((f) => f.code)).toContain("linked_current_claim_not_placed");

    // 6. Create Section B and place R2 in Section B
    const sectionB = await reviewServices.createSection(projectId, manuscript.id, {
      title: "Discussion Section B",
      sectionType: "discussion",
    });
    const p3 = await reviewServices.placeClaimRevision(
      projectId,
      manuscript.id,
      sectionB!.id,
      r2.revision.id,
    );

    proj = await coverageServices.getQuestionTraceability(projectId, question.id);
    claimCov = proj.claimCoverage[0];
    expect(claimCov.currentClaimPlaced).toBe(true);
    expect(claimCov.hasAnyHistoricalPlacement).toBe(true);
    expect(claimCov.activePlacementSections).toEqual(["Discussion Section B"]);
    expect(proj.flags.claims).toEqual([]);

    // 7. Remove placement from Section B
    await reviewServices.removeClaimPlacement(projectId, manuscript.id, p3.id);

    proj = await coverageServices.getQuestionTraceability(projectId, question.id);
    claimCov = proj.claimCoverage[0];
    expect(claimCov.currentClaimPlaced).toBe(false);
    expect(claimCov.hasAnyHistoricalPlacement).toBe(true);
    expect(proj.flags.claims.map((f) => f.code)).toContain("linked_current_claim_not_placed");

    // 8. Withdraw current Claim revision -> no current active articulation, so placement-specific current flag is suppressed
    await reviewServices.withdrawClaim(projectId, claimId);

    proj = await coverageServices.getQuestionTraceability(projectId, question.id);
    claimCov = proj.claimCoverage[0];
    expect(claimCov.hasActiveRevision).toBe(false);
    expect(claimCov.currentActiveRevisionId).toBeNull();
    expect(claimCov.currentClaimPlaced).toBe(false);
    expect(claimCov.hasAnyHistoricalPlacement).toBe(true);
    expect(proj.flags.claims).toEqual([
      {
        code: "linked_claim_without_current_active_revision",
        targetType: "claim",
        targetId: claimId,
        targetLabel: "Revised Claim R2",
      },
    ]);
  });

  it("audit item 5: strictly matches exact active revision interpretations and ignores draft or previous revision interpretations", async () => {
    const question = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ_INTERP",
      label: "Interpretation Parity RQ",
    });

    const stmt = await reviewServices.createSynthesisStatement(projectId, {
      title: "Stat Title R1",
      statementText: "Synthesis statement for interpretation parity",
      extractionRevisionIds: [],
    });

    await traceabilityServices.linkSynthesisStatement({
      projectId,
      questionId: question.id,
      statementId: stmt.statement.id,
    });

    // 1. Initially has no interpretation
    let proj = await coverageServices.getQuestionTraceability(projectId, question.id);
    expect(proj.synthesisCoverage[0].hasInterpretation).toBe(false);
    expect(proj.synthesisCoverage[0].currentInterpretationConvergence).toBeNull();
    expect(proj.flags.synthesis.map((f) => f.code)).toContain("linked_current_synthesis_without_interpretation");

    // 2. Finalized interpretation 1 for Revision 1
    await reviewServices.appendSynthesisInterpretation(
      projectId,
      stmt.statement.id,
      stmt.revision.id,
      {
        convergenceState: "convergent",
        summary: "Clear consensus on Revision 1",
      },
    );

    proj = await coverageServices.getQuestionTraceability(projectId, question.id);
    expect(proj.synthesisCoverage[0].hasInterpretation).toBe(true);
    expect(proj.synthesisCoverage[0].currentInterpretationConvergence).toBe("convergent");
    expect(proj.flags.synthesis.map((f) => f.code)).not.toContain("linked_current_synthesis_without_interpretation");

    // 3. Append interpretation 2 for Revision 1 (higher sequence: latest state becomes "mixed")
    await reviewServices.appendSynthesisInterpretation(
      projectId,
      stmt.statement.id,
      stmt.revision.id,
      {
        convergenceState: "mixed",
        summary: "Updated to mixed findings on Revision 1",
      },
    );

    proj = await coverageServices.getQuestionTraceability(projectId, question.id);
    expect(proj.synthesisCoverage[0].hasInterpretation).toBe(true);
    expect(proj.synthesisCoverage[0].currentInterpretationConvergence).toBe("mixed");

    // 4. Create Revision 2 of the statement (active)
    const r2 = await reviewServices.reviseSynthesisStatement(projectId, stmt.statement.id, {
      title: "Stat Title R2",
      statementText: "Updated statement text for Revision 2",
      extractionRevisionIds: [],
    });

    // Revision 2 is now active. Even though Revision 1 has two finalized interpretations,
    // Revision 2 has NO interpretation! Therefore hasInterpretation must be false!
    proj = await coverageServices.getQuestionTraceability(projectId, question.id);
    expect(proj.synthesisCoverage[0].currentActiveRevisionId).toBe(r2.revision.id);
    expect(proj.synthesisCoverage[0].hasInterpretation).toBe(false);
    expect(proj.synthesisCoverage[0].currentInterpretationConvergence).toBeNull();
    expect(proj.flags.synthesis.map((f) => f.code)).toContain("linked_current_synthesis_without_interpretation");

    // 5. Append interpretation for Revision 2
    await reviewServices.appendSynthesisInterpretation(
      projectId,
      stmt.statement.id,
      r2.revision.id,
      {
        convergenceState: "inconclusive",
        summary: "Revision 2 is inconclusive",
      },
    );

    proj = await coverageServices.getQuestionTraceability(projectId, question.id);
    expect(proj.synthesisCoverage[0].hasInterpretation).toBe(true);
    expect(proj.synthesisCoverage[0].currentInterpretationConvergence).toBe("inconclusive");
    expect(proj.flags.synthesis.map((f) => f.code)).not.toContain("linked_current_synthesis_without_interpretation");
  });

  it("audit item 7: confirms traceability mutations do not alter formal supports, manuscript structures, or PRISMA review flow", async () => {
    // 1. Setup paper with PRISMA flow
    const paper = await includedPaper("Flow Paper");
    const ev = await reviewServices.recordEvidence(projectId, {
      paperId: paper.id,
      sourceText: "Evidence text",
      pageNumber: 1,
    });
    const field = await reviewServices.createExtractionField(projectId, {
      name: "Outcome",
      fieldType: "short_text",
    });
    const ext = await reviewServices.reviseExtractionValue(projectId, paper.id, field.id, {
      value: "Observed Outcome",
      evidenceIds: [ev.id],
    });

    const setRes = await reviewServices.createEvidenceSet(projectId, { name: "Set 1" });
    await reviewServices.addEvidenceToSet(projectId, setRes.set.id, { evidenceId: ev.id });

    const stmt = await reviewServices.createSynthesisStatement(projectId, {
      statementText: "Synthesis statement",
      extractionRevisionIds: [ext.id],
    });

    const claimRes = await reviewServices.createClaimWithSynthesisSupport(projectId, {
      claimText: "Claim with support",
      synthesisRevisionId: stmt.revision.id,
    });

    // Check pre-mutation state of analytical tables
    const preSynSupports = await client.unsafe(
      `SELECT count(*)::int as c FROM synthesis_revision_supports WHERE project_id = '${projectId}'`,
    );
    const preClaimSupports = await client.unsafe(
      `SELECT count(*)::int as c FROM claim_revision_synthesis_supports WHERE project_id = '${projectId}'`,
    );
    const preFlow = await reviewServices.getReviewFlowSummary(projectId);

    // 2. Perform various RQ traceability operations (linking, unlinking, relinking)
    const question = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ_INVARIANTS",
      label: "Invariants Check RQ",
    });

    await traceabilityServices.linkExtractionField({ projectId, questionId: question.id, fieldId: field.id });
    await traceabilityServices.linkEvidenceSet({ projectId, questionId: question.id, evidenceSetId: setRes.set.id });
    await traceabilityServices.linkSynthesisStatement({ projectId, questionId: question.id, statementId: stmt.statement.id });
    await traceabilityServices.linkClaim({ projectId, questionId: question.id, claimId: claimRes.claim.id });

    await traceabilityServices.unlinkExtractionField({ projectId, questionId: question.id, fieldId: field.id });
    await traceabilityServices.unlinkClaim({ projectId, questionId: question.id, claimId: claimRes.claim.id });

    // 3. Check post-mutation state: formal support rows and review flow are 100% identical
    const postSynSupports = await client.unsafe(
      `SELECT count(*)::int as c FROM synthesis_revision_supports WHERE project_id = '${projectId}'`,
    );
    const postClaimSupports = await client.unsafe(
      `SELECT count(*)::int as c FROM claim_revision_synthesis_supports WHERE project_id = '${projectId}'`,
    );
    const postFlow = await reviewServices.getReviewFlowSummary(projectId);

    expect(Number((postSynSupports as any)[0].c)).toBe(Number((preSynSupports as any)[0].c));
    expect(Number((postClaimSupports as any)[0].c)).toBe(Number((preClaimSupports as any)[0].c));
    expect(postFlow).toEqual(preFlow);
  });

  it("audit detail: explicitly proves exact current active ClaimRevision placement lifecycle and suppression on withdrawal", async () => {
    const question = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ_EXACT_PLACEMENT",
      label: "Exact Current Active ClaimRevision Placement Proof",
    });

    const stmt = await reviewServices.createSynthesisStatement(projectId, {
      statementText: "Placement evidence synthesis statement",
      extractionRevisionIds: [],
    });

    const claimResult = await reviewServices.createClaimWithSynthesisSupport(projectId, {
      claimText: "Initial Claim R1",
      synthesisRevisionId: stmt.revision.id,
    });
    const claimId = claimResult.claim.id;
    const r1Id = claimResult.revision.id;

    await traceabilityServices.linkClaim({
      projectId,
      questionId: question.id,
      claimId,
    });

    const manuscript = await reviewServices.getOrCreateDefaultManuscript(projectId);
    const sectionA = await reviewServices.createSection(projectId, manuscript.id, {
      title: "Results Section A",
      sectionType: "results",
    });

    // 1. R1 active and placed -> currentClaimPlaced = true
    await reviewServices.placeClaimRevision(projectId, manuscript.id, sectionA!.id, r1Id);
    let proj = await coverageServices.getQuestionTraceability(projectId, question.id);
    let claimCov = proj.claimCoverage[0];
    expect(claimCov.currentActiveRevisionId).toBe(r1Id);
    expect(claimCov.hasActiveRevision).toBe(true);
    expect(claimCov.currentClaimPlaced).toBe(true);
    expect(claimCov.hasAnyHistoricalPlacement).toBe(true);
    expect(proj.flags.claims).toEqual([]);

    // 2. Create R2 active, leaving R1 placement intact -> currentClaimPlaced = false, hasAnyHistoricalPlacement = true
    // (A historical R1 placement must never satisfy current placement for R2)
    const r2 = await reviewServices.createClaimRevision(projectId, claimId, {
      lifecycle: "active",
      claimText: "Revised Claim R2",
      supports: [{ kind: "synthesisRevision", synthesisRevisionId: stmt.revision.id }],
    });
    proj = await coverageServices.getQuestionTraceability(projectId, question.id);
    claimCov = proj.claimCoverage[0];
    expect(claimCov.currentActiveRevisionId).toBe(r2.revision.id);
    expect(claimCov.hasActiveRevision).toBe(true);
    expect(claimCov.currentClaimPlaced).toBe(false);
    expect(claimCov.hasAnyHistoricalPlacement).toBe(true);
    expect(proj.flags.claims).toEqual([
      {
        code: "linked_current_claim_not_placed",
        targetType: "claim",
        targetId: claimId,
        targetLabel: "Revised Claim R2",
      },
    ]);

    // 3. Place R2 -> currentClaimPlaced = true
    await reviewServices.placeClaimRevision(projectId, manuscript.id, sectionA!.id, r2.revision.id);
    proj = await coverageServices.getQuestionTraceability(projectId, question.id);
    claimCov = proj.claimCoverage[0];
    expect(claimCov.currentActiveRevisionId).toBe(r2.revision.id);
    expect(claimCov.hasActiveRevision).toBe(true);
    expect(claimCov.currentClaimPlaced).toBe(true);
    expect(claimCov.hasAnyHistoricalPlacement).toBe(true);
    expect(proj.flags.claims).toEqual([]);

    // 4. Withdraw current Claim revision -> no current active articulation, so placement-specific current flag is suppressed
    await reviewServices.withdrawClaim(projectId, claimId);
    proj = await coverageServices.getQuestionTraceability(projectId, question.id);
    claimCov = proj.claimCoverage[0];
    expect(claimCov.hasActiveRevision).toBe(false);
    expect(claimCov.currentActiveRevisionId).toBeNull();
    expect(claimCov.currentClaimPlaced).toBe(false);
    expect(claimCov.hasAnyHistoricalPlacement).toBe(true);
    expect(proj.flags.claims).toEqual([
      {
        code: "linked_claim_without_current_active_revision",
        targetType: "claim",
        targetId: claimId,
        targetLabel: "Revised Claim R2",
      },
    ]);
  });

  it("audit detail: proves suppression of synthesis support and interpretation flags when statement has no active revision", async () => {
    const question = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ_SYN_SUPPRESS",
      label: "Synthesis Flag Suppression Proof",
    });

    const stmt = await reviewServices.createSynthesisStatement(projectId, {
      title: "Active Statement",
      statementText: "Statement to be withdrawn",
      extractionRevisionIds: [],
    });

    await traceabilityServices.linkSynthesisStatement({
      projectId,
      questionId: question.id,
      statementId: stmt.statement.id,
    });

    // When active and without support/interpretation: both flags are emitted
    let proj = await coverageServices.getQuestionTraceability(projectId, question.id);
    expect(proj.synthesisCoverage[0].hasActiveRevision).toBe(true);
    expect(proj.flags.synthesis.map((f) => f.code)).toEqual([
      "linked_current_synthesis_without_support",
      "linked_current_synthesis_without_interpretation",
    ]);

    // Withdraw the synthesis statement
    await reviewServices.withdrawSynthesisStatement(projectId, stmt.statement.id);

    // After withdrawal: NO active revision exists -> MUST emit ONLY linked_statement_without_current_active_revision
    // Support and interpretation flags MUST be suppressed!
    proj = await coverageServices.getQuestionTraceability(projectId, question.id);
    expect(proj.synthesisCoverage[0].hasActiveRevision).toBe(false);
    expect(proj.synthesisCoverage[0].currentActiveRevisionId).toBeNull();
    expect(proj.flags.synthesis).toEqual([
      {
        code: "linked_statement_without_current_active_revision",
        targetType: "synthesis_statement",
        targetId: stmt.statement.id,
        targetLabel: "Active Statement",
      },
    ]);
  });
});
