import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReviewServices } from "@/application/services";
import { createDb, type Database } from "@/db/client";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview";
const TEST_DB_NAME = `slice4_upgrade_test_${Date.now()}`;
const TEST_DB_URL = BASE_URL.replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);

async function runStatements(client: postgres.Sql, sqlContent: string) {
  const statements = sqlContent
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    await client.unsafe(stmt);
  }
}

describe("Slice 4 database upgrade to Slice 5 ClaimRevisions", () => {
  let testClient: postgres.Sql;
  let testDb: Database;
  let services: ReturnType<typeof createReviewServices>;
  const drizzleDir = path.resolve(process.cwd(), "drizzle");

  // Representative data trackers
  let alphaId: string;
  let betaId: string;
  let paper1Id: string;
  let paper2Id: string;
  let paper3Id: string;
  let paperBetaId: string;
  let ev1Id: string;
  let ev2Id: string;
  let ev3Id: string;
  let ev4Id: string;
  let evBetaId: string;
  let claimAId: string;
  let claimBId: string;
  let claimCId: string;
  let claimDId: string;
  let claimEId: string;
  let claimBeta1Id: string;
  let claimBeta2Id: string;

  const preMigrationStates = new Map<string, {
    id: string;
    projectId: string;
    claimText: string;
    supportStatus: "supported" | "unsupported";
    evidenceIds: string[];
  }>();

  let legacyClaims: { id: string; project_id: string; claim_text: string; created_at: Date; updated_at: Date }[] = [];
  let legacyLinks: { project_id: string; claim_id: string; evidence_id: string; created_at: Date }[] = [];

  beforeAll(async () => {
    const adminClient = postgres(BASE_URL, { max: 1 });
    await adminClient.unsafe(`CREATE DATABASE "${TEST_DB_NAME}"`);
    await adminClient.end();

    const created = createDb(TEST_DB_URL);
    testClient = created.client;
    testDb = created.db;
    services = createReviewServices(testDb);

    // 1. Apply baseline migrations 0000 - 0005
    const journal = JSON.parse(fs.readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8"));
    const slice4Entries = journal.entries.filter((e: { idx: number }) => e.idx <= 5);

    for (const entry of slice4Entries) {
      const filePath = path.join(drizzleDir, `${entry.tag}.sql`);
      const content = fs.readFileSync(filePath, "utf8");
      await runStatements(testClient, content);
    }

    // 2. Seed representative Slice 4 dataset
    const [projectAlpha] = await testClient`
      INSERT INTO projects (id, title, description)
      VALUES (gen_random_uuid(), 'Alpha Systematic Review', 'Primary review project')
      RETURNING id
    `;
    alphaId = projectAlpha.id;

    const [projectBeta] = await testClient`
      INSERT INTO projects (id, title, description)
      VALUES (gen_random_uuid(), 'Beta Secondary Study', 'Isolation verification project')
      RETURNING id
    `;
    betaId = projectBeta.id;

    const [alphaExclusionCriterion] = await testClient`
      INSERT INTO screening_criteria (id, project_id, type, text)
      VALUES (gen_random_uuid(), ${alphaId}, 'exclusion', 'Historical paper out of modern review scope')
      RETURNING id
    `;

    const [p1] = await testClient`
      INSERT INTO papers (id, project_id, title, authors, publication_year, venue)
      VALUES (gen_random_uuid(), ${alphaId}, 'Deep Learning for Information Extraction', ARRAY['Smith J.', 'Doe A.'], 2023, 'ACL')
      RETURNING id
    `;
    paper1Id = p1.id;

    const [p2] = await testClient`
      INSERT INTO papers (id, project_id, title, authors, publication_year, venue)
      VALUES (gen_random_uuid(), ${alphaId}, 'Empirical Evaluation of LLM Reasoning', ARRAY['Alice B.', 'Bob C.'], 2024, 'NeurIPS')
      RETURNING id
    `;
    paper2Id = p2.id;

    const [p3] = await testClient`
      INSERT INTO papers (id, project_id, title, authors, publication_year, venue)
      VALUES (gen_random_uuid(), ${alphaId}, 'Survey on Historical Text Analytics', ARRAY['Historian E.'], 2021, 'JASIST')
      RETURNING id
    `;
    paper3Id = p3.id;

    await testClient`
      INSERT INTO screening_decisions (project_id, paper_id, stage, decision)
      VALUES 
        (${alphaId}, ${paper1Id}, 'title_abstract', 'include'),
        (${alphaId}, ${paper2Id}, 'title_abstract', 'include')
    `;
    await testClient`
      INSERT INTO screening_decisions (project_id, paper_id, stage, decision, exclusion_criterion_id, exclusion_criterion_type)
      VALUES (${alphaId}, ${paper3Id}, 'title_abstract', 'exclude', ${alphaExclusionCriterion.id}, 'exclusion')
    `;

    const [e1] = await testClient`
      INSERT INTO evidence (id, project_id, paper_id, source_text, page_number)
      VALUES (gen_random_uuid(), ${alphaId}, ${paper1Id}, 'Neural models reached 94.2% precision on benchmark.', 4)
      RETURNING id
    `;
    ev1Id = e1.id;

    const [e2] = await testClient`
      INSERT INTO evidence (id, project_id, paper_id, source_text, page_number)
      VALUES (gen_random_uuid(), ${alphaId}, ${paper1Id}, 'Ablation shows 5.1% degradation without attention.', 7)
      RETURNING id
    `;
    ev2Id = e2.id;

    const [e3] = await testClient`
      INSERT INTO evidence (id, project_id, paper_id, source_text, page_number)
      VALUES (gen_random_uuid(), ${alphaId}, ${paper2Id}, 'Chain-of-thought prompting reduces hallucination by 32%.', 11)
      RETURNING id
    `;
    ev3Id = e3.id;

    const [e4] = await testClient`
      INSERT INTO evidence (id, project_id, paper_id, source_text, page_number)
      VALUES (gen_random_uuid(), ${alphaId}, ${paper3Id}, 'Historical corpus exhibited orthographic variance.', 2)
      RETURNING id
    `;
    ev4Id = e4.id;

    // Claims in Slice 4
    const [cA] = await testClient`
      INSERT INTO claims (id, project_id, claim_text, created_at, updated_at)
      VALUES (gen_random_uuid(), ${alphaId}, 'Claim A: General assertion without source backing', now() - interval '3 hours', now() - interval '3 hours')
      RETURNING id
    `;
    claimAId = cA.id;

    const [cB] = await testClient`
      INSERT INTO claims (id, project_id, claim_text, created_at, updated_at)
      VALUES (gen_random_uuid(), ${alphaId}, 'Claim B: Singly-supported by Paper 1 precision finding', now() - interval '2 hours', now() - interval '2 hours')
      RETURNING id
    `;
    claimBId = cB.id;

    const [cC] = await testClient`
      INSERT INTO claims (id, project_id, claim_text, created_at, updated_at)
      VALUES (gen_random_uuid(), ${alphaId}, 'Claim C: Multi-evidence single-paper backing on Paper 1', now() - interval '1 hour', now() - interval '1 hour')
      RETURNING id
    `;
    claimCId = cC.id;

    const [cD] = await testClient`
      INSERT INTO claims (id, project_id, claim_text, created_at, updated_at)
      VALUES (gen_random_uuid(), ${alphaId}, 'Claim D: Cross-paper evidence backing (Paper 1 & Paper 2)', now() - interval '45 minutes', now() - interval '45 minutes')
      RETURNING id
    `;
    claimDId = cD.id;

    const [cE] = await testClient`
      INSERT INTO claims (id, project_id, claim_text, created_at, updated_at)
      VALUES (gen_random_uuid(), ${alphaId}, 'Claim E: Backed by direct evidence from an excluded paper', now() - interval '30 minutes', now() - interval '30 minutes')
      RETURNING id
    `;
    claimEId = cE.id;

    // Legacy claim_evidence
    await testClient`INSERT INTO claim_evidence (project_id, claim_id, evidence_id, created_at) VALUES (${alphaId}, ${claimBId}, ${ev1Id}, now() - interval '110 minutes')`;
    await testClient`INSERT INTO claim_evidence (project_id, claim_id, evidence_id, created_at) VALUES (${alphaId}, ${claimCId}, ${ev1Id}, now() - interval '55 minutes')`;
    await testClient`INSERT INTO claim_evidence (project_id, claim_id, evidence_id, created_at) VALUES (${alphaId}, ${claimCId}, ${ev2Id}, now() - interval '50 minutes')`;
    await testClient`INSERT INTO claim_evidence (project_id, claim_id, evidence_id, created_at) VALUES (${alphaId}, ${claimDId}, ${ev1Id}, now() - interval '40 minutes')`;
    await testClient`INSERT INTO claim_evidence (project_id, claim_id, evidence_id, created_at) VALUES (${alphaId}, ${claimDId}, ${ev3Id}, now() - interval '35 minutes')`;
    await testClient`INSERT INTO claim_evidence (project_id, claim_id, evidence_id, created_at) VALUES (${alphaId}, ${claimEId}, ${ev4Id}, now() - interval '25 minutes')`;

    // Project Beta isolation
    const [pBeta] = await testClient`
      INSERT INTO papers (id, project_id, title, authors, publication_year)
      VALUES (gen_random_uuid(), ${betaId}, 'Beta Paper on Extraction Invariants', ARRAY['Beta Lead'], 2024)
      RETURNING id
    `;
    paperBetaId = pBeta.id;

    await testClient`INSERT INTO screening_decisions (project_id, paper_id, stage, decision) VALUES (${betaId}, ${paperBetaId}, 'title_abstract', 'include')`;

    const [eBeta] = await testClient`
      INSERT INTO evidence (id, project_id, paper_id, source_text, page_number)
      VALUES (gen_random_uuid(), ${betaId}, ${paperBetaId}, 'Beta tenant benchmark data.', 1)
      RETURNING id
    `;
    evBetaId = eBeta.id;

    const [cBeta1] = await testClient`
      INSERT INTO claims (id, project_id, claim_text, created_at, updated_at)
      VALUES (gen_random_uuid(), ${betaId}, 'Claim Beta 1: Supported within Beta tenant', now(), now())
      RETURNING id
    `;
    claimBeta1Id = cBeta1.id;

    const [cBeta2] = await testClient`
      INSERT INTO claims (id, project_id, claim_text, created_at, updated_at)
      VALUES (gen_random_uuid(), ${betaId}, 'Claim Beta 2: Unsupported within Beta tenant', now(), now())
      RETURNING id
    `;
    claimBeta2Id = cBeta2.id;

    await testClient`INSERT INTO claim_evidence (project_id, claim_id, evidence_id, created_at) VALUES (${betaId}, ${claimBeta1Id}, ${evBetaId}, now())`;

    // Record pre-migration state
    legacyClaims = await testClient`SELECT * FROM claims ORDER BY created_at ASC`;
    legacyLinks = await testClient`SELECT * FROM claim_evidence ORDER BY claim_id, evidence_id`;

    for (const c of legacyClaims) {
      const links = legacyLinks.filter((l) => l.claim_id === c.id);
      preMigrationStates.set(c.id, {
        id: c.id,
        projectId: c.project_id,
        claimText: c.claim_text,
        supportStatus: links.length > 0 ? "supported" : "unsupported",
        evidenceIds: links.map((l) => l.evidence_id).sort(),
      });
    }

    // Apply migration 0006
    const migration0006Sql = fs.readFileSync(path.join(drizzleDir, "0006_claim_revisions.sql"), "utf8");
    await runStatements(testClient, migration0006Sql);
  });

  afterAll(async () => {
    if (testClient) await testClient.end();
    const cleanupClient = postgres(BASE_URL, { max: 1 });
    await cleanupClient.unsafe(`DROP DATABASE "${TEST_DB_NAME}" WITH (FORCE)`);
    await cleanupClient.end();
  });

  it("1. every legacy claims row produced exactly one finalized ClaimRevision", async () => {
    const claims = await testClient`SELECT id, project_id FROM claims`;
    const revisions = await testClient`SELECT * FROM claim_revisions`;

    expect(claims.length).toBe(legacyClaims.length);
    expect(revisions.length).toBe(legacyClaims.length);

    for (const legacy of legacyClaims) {
      const matching = revisions.filter((r) => r.claim_id === legacy.id && r.project_id === legacy.project_id);
      expect(matching.length).toBe(1);
      const rev = matching[0];
      expect(rev.state).toBe("active");
      expect(rev.finalized_at).not.toBeNull();
      expect(rev.claim_text).toBe(legacy.claim_text);
      expect(new Date(rev.created_at).getTime()).toBe(new Date(legacy.created_at).getTime());
    }

    const duplicates = await testClient`
      SELECT project_id, claim_id FROM claim_revisions GROUP BY project_id, claim_id HAVING count(*) <> 1
    `;
    expect(duplicates.length).toBe(0);
  });

  it("2. every legacy claim_evidence row produced exactly one direct Evidence support row", async () => {
    const supports = await testClient`SELECT * FROM claim_revision_evidence_supports`;
    const revisions = await testClient`SELECT id, claim_id, project_id FROM claim_revisions`;

    expect(supports.length).toBe(legacyLinks.length);

    for (const link of legacyLinks) {
      const claimRev = revisions.find((r) => r.claim_id === link.claim_id && r.project_id === link.project_id);
      expect(claimRev).toBeDefined();

      const matched = supports.filter(
        (s) => s.project_id === link.project_id && s.claim_revision_id === claimRev!.id && s.evidence_id === link.evidence_id
      );
      expect(matched.length).toBe(1);
      expect(new Date(matched[0].created_at).getTime()).toBe(new Date(link.created_at).getTime());
    }
  });

  it("3. no orphan ClaimRevision/support rows exist", async () => {
    const [orphanRevisions] = await testClient`
      SELECT count(*) as count FROM claim_revisions r
      WHERE NOT EXISTS (SELECT 1 FROM claims c WHERE c.project_id = r.project_id AND c.id = r.claim_id)
    `;
    expect(Number(orphanRevisions.count)).toBe(0);

    const [orphanSupportsRev] = await testClient`
      SELECT count(*) as count FROM claim_revision_evidence_supports s
      WHERE NOT EXISTS (SELECT 1 FROM claim_revisions r WHERE r.project_id = s.project_id AND r.id = s.claim_revision_id)
    `;
    expect(Number(orphanSupportsRev.count)).toBe(0);

    const [orphanSupportsEv] = await testClient`
      SELECT count(*) as count FROM claim_revision_evidence_supports s
      WHERE NOT EXISTS (SELECT 1 FROM evidence e WHERE e.project_id = s.project_id AND e.id = s.evidence_id)
    `;
    expect(Number(orphanSupportsEv.count)).toBe(0);

    const [extractionSupports] = await testClient`SELECT count(*) as count FROM claim_revision_extraction_supports`;
    expect(Number(extractionSupports.count)).toBe(0);

    const [synthesisSupports] = await testClient`SELECT count(*) as count FROM claim_revision_synthesis_supports`;
    expect(Number(synthesisSupports.count)).toBe(0);
  });

  it("4. old claim_evidence and mutable claims.claim_text are removed only after the backfill assertions", async () => {
    // Structural assertion ordering in 0006_claim_revisions.sql
    const migrationSql = fs.readFileSync(path.join(drizzleDir, "0006_claim_revisions.sql"), "utf8");
    const doBlockIdx = migrationSql.indexOf("DO $$");
    const dropTableIdx = migrationSql.indexOf('DROP TABLE "claim_evidence"');
    const dropColIdx = migrationSql.indexOf('ALTER TABLE "claims" DROP COLUMN "claim_text"');

    expect(doBlockIdx).toBeGreaterThan(0);
    expect(dropTableIdx).toBeGreaterThan(doBlockIdx);
    expect(dropColIdx).toBeGreaterThan(dropTableIdx);

    // Contraction confirmation on upgraded database
    const [tableCheck] = await testClient`
      SELECT count(*) as count FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'claim_evidence'
    `;
    expect(Number(tableCheck.count)).toBe(0);

    const [colClaimText] = await testClient`
      SELECT count(*) as count FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'claims' AND column_name = 'claim_text'
    `;
    expect(Number(colClaimText.count)).toBe(0);

    const [colUpdatedAt] = await testClient`
      SELECT count(*) as count FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'claims' AND column_name = 'updated_at'
    `;
    expect(Number(colUpdatedAt.count)).toBe(0);

    const cols = await testClient`
      SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'claims' ORDER BY ordinal_position
    `;
    expect(cols.map((c) => c.column_name)).toEqual(["id", "project_id", "created_at"]);
  });

  it("5. migrated supported/unsupported Claim behavior matches pre-migration observable state", async () => {
    for (const [claimId, preState] of preMigrationStates.entries()) {
      const current = await services.getCurrentClaim(preState.projectId, claimId);
      const provenance = await services.getClaimProvenance(preState.projectId, claimId);

      expect(current.claim.claimText).toBe(preState.claimText);
      expect(current.currentRevision.claimText).toBe(preState.claimText);
      expect(current.currentRevision.supportStatus).toBe(preState.supportStatus);
      expect(provenance.supportStatus).toBe(preState.supportStatus);

      const currentEvIds = current.currentRevision.supports.evidence.map((s) => s.evidenceId).sort();
      const provenanceEvIds = provenance.evidence.map((e) => e.evidence.id).sort();
      expect(currentEvIds).toEqual(preState.evidenceIds);
      expect(provenanceEvIds).toEqual(preState.evidenceIds);
    }

    const alphaClaims = await services.listClaims(alphaId);
    expect(alphaClaims.length).toBe(5);
    for (const claim of alphaClaims) {
      const pre = preMigrationStates.get(claim.id)!;
      expect(claim.supportStatus).toBe(pre.supportStatus);
      expect(claim.claimText).toBe(pre.claimText);
    }
  });

  it("6. citation candidates for migrated direct-Evidence claims resolve correctly", async () => {
    // Claim A (unsupported)
    const claimA = await services.getCurrentClaim(alphaId, claimAId);
    expect(claimA.currentRevision.citationCandidateCount).toBe(0);
    expect(claimA.currentRevision.citationCandidates).toHaveLength(0);

    // Claim B (singly-supported by ev1 on Paper 1)
    const claimB = await services.getCurrentClaim(alphaId, claimBId);
    expect(claimB.currentRevision.citationCandidateCount).toBe(1);
    expect(claimB.currentRevision.citationCandidates[0].paper.id).toBe(paper1Id);
    expect(claimB.currentRevision.citationCandidates[0].pathCount).toBe(1);
    expect(claimB.currentRevision.citationCandidates[0].supportKinds).toEqual(["evidence"]);
    expect(claimB.currentRevision.citationCandidates[0].paths).toEqual([`evidence:${ev1Id}`]);

    // Claim C (ev1 and ev2 both on Paper 1 -> deduplicated by Paper ID)
    const claimC = await services.getCurrentClaim(alphaId, claimCId);
    expect(claimC.currentRevision.citationCandidateCount).toBe(1);
    expect(claimC.currentRevision.distinctPaperCount).toBe(1);
    expect(claimC.currentRevision.citationCandidates[0].paper.id).toBe(paper1Id);
    expect(claimC.currentRevision.citationCandidates[0].pathCount).toBe(2);
    expect(claimC.currentRevision.citationCandidates[0].paths).toContain(`evidence:${ev1Id}`);
    expect(claimC.currentRevision.citationCandidates[0].paths).toContain(`evidence:${ev2Id}`);

    // Claim D (ev1 on Paper 1, ev3 on Paper 2)
    const claimD = await services.getCurrentClaim(alphaId, claimDId);
    expect(claimD.currentRevision.citationCandidateCount).toBe(2);
    const paperIdsInD = claimD.currentRevision.citationCandidates.map((c) => c.paper.id).sort();
    expect(paperIdsInD).toEqual([paper1Id, paper2Id].sort());

    // Claim E (ev4 on excluded Paper 3)
    const claimE = await services.getCurrentClaim(alphaId, claimEId);
    expect(claimE.currentRevision.citationCandidateCount).toBe(1);
    expect(claimE.currentRevision.citationCandidates[0].paper.id).toBe(paper3Id);

    // Tenant Beta
    const beta1 = await services.getCurrentClaim(betaId, claimBeta1Id);
    expect(beta1.currentRevision.citationCandidateCount).toBe(1);
    expect(beta1.currentRevision.citationCandidates[0].paper.id).toBe(paperBetaId);

    const beta2 = await services.getCurrentClaim(betaId, claimBeta2Id);
    expect(beta2.currentRevision.citationCandidateCount).toBe(0);
  });
});
