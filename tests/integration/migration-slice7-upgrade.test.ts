import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview";
const TEST_DB_NAME = `slice7_upgrade_test_${Date.now()}`;
const TEST_DB_URL = BASE_URL.replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);
const drizzleDir = path.resolve(process.cwd(), "drizzle");

async function runStatements(client: postgres.Sql, content: string) {
  for (const statement of content.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) await client.unsafe(statement);
}

describe("Slice 8 additive upgrade from Slice 7", () => {
  let client: postgres.Sql;
  let projectId: string;
  let manuscriptId: string;
  let sectionId: string;
  let activePlacementIds: string[];
  let removedPlacementId: string;
  let manuscriptBefore: readonly unknown[];

  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1 });
    await admin.unsafe(`CREATE DATABASE "${TEST_DB_NAME}"`);
    await admin.end();
    client = postgres(TEST_DB_URL, { max: 1 });

    const journal = JSON.parse(fs.readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8"));
    for (const entry of journal.entries.filter((candidate: { idx: number }) => candidate.idx <= 5)) await runStatements(client, fs.readFileSync(path.join(drizzleDir, `${entry.tag}.sql`), "utf8"));

    [{ id: projectId }] = await client`insert into projects (title) values ('Slice 7 upgrade fixture') returning id`;
    const [{ id: paperId }] = await client`insert into papers (project_id, title) values (${projectId}, 'Upgrade paper') returning id`;
    const [{ id: evidenceId }] = await client`insert into evidence (project_id, paper_id, source_text, page_number) values (${projectId}, ${paperId}, 'Upgrade evidence', 1) returning id`;
    const [{ id: claimId }] = await client`insert into claims (project_id, claim_text) values (${projectId}, 'Upgrade claim') returning id`;
    await client`insert into claim_evidence (project_id, claim_id, evidence_id) values (${projectId}, ${claimId}, ${evidenceId})`;
    const [{ id: secondClaimId }] = await client`insert into claims (project_id, claim_text) values (${projectId}, 'Second upgrade claim') returning id`;
    await client`insert into claim_evidence (project_id, claim_id, evidence_id) values (${projectId}, ${secondClaimId}, ${evidenceId})`;
    const [{ id: removedClaimId }] = await client`insert into claims (project_id, claim_text) values (${projectId}, 'Removed upgrade claim') returning id`;
    await client`insert into claim_evidence (project_id, claim_id, evidence_id) values (${projectId}, ${removedClaimId}, ${evidenceId})`;

    await runStatements(client, fs.readFileSync(path.join(drizzleDir, "0006_claim_revisions.sql"), "utf8"));
    await runStatements(client, fs.readFileSync(path.join(drizzleDir, "0007_manuscript_workspace.sql"), "utf8"));

    [{ id: manuscriptId }] = await client`insert into manuscripts (project_id, title, is_default) values (${projectId}, 'Fixture manuscript', true) returning id`;
    [{ id: sectionId }] = await client`insert into manuscript_sections (project_id, manuscript_id, title, sort_order) values (${projectId}, ${manuscriptId}, 'Introduction', 0) returning id`;
    const [{ id: revisionId }] = await client`select id from claim_revisions where project_id=${projectId} and claim_id=${claimId}`;
    const [{ id: secondRevisionId }] = await client`select id from claim_revisions where project_id=${projectId} and claim_id=${secondClaimId}`;
    const [{ id: removedRevisionId }] = await client`select id from claim_revisions where project_id=${projectId} and claim_id=${removedClaimId}`;
    const [{ id: firstId }] = await client`insert into manuscript_claim_placements (project_id, manuscript_id, section_id, claim_id, claim_revision_id, sort_order) values (${projectId}, ${manuscriptId}, ${sectionId}, ${claimId}, ${revisionId}, 4) returning id`;
    const [{ id: secondId }] = await client`insert into manuscript_claim_placements (project_id, manuscript_id, section_id, claim_id, claim_revision_id, sort_order) values (${projectId}, ${manuscriptId}, ${sectionId}, ${secondClaimId}, ${secondRevisionId}, 1) returning id`;
    // This placement is historical before the Slice 7 boundary and must not be backfilled.
    const [{ id: removedId }] = await client`insert into manuscript_claim_placements (project_id, manuscript_id, section_id, claim_id, claim_revision_id, sort_order) values (${projectId}, ${manuscriptId}, ${sectionId}, ${removedClaimId}, ${removedRevisionId}, 9) returning id`;
    removedPlacementId = removedId;
    await client`update manuscript_claim_placements set removed_at=now() where id=${removedPlacementId}`;
    activePlacementIds = [firstId, secondId];
    const eventsBefore = await client`select placement_id, event_type, sequence from manuscript_claim_placement_events order by sequence`;
    manuscriptBefore = await client`select id, project_id, title, is_default, created_at, updated_at from manuscripts where id=${manuscriptId}`;

    await runStatements(client, fs.readFileSync(path.join(drizzleDir, "0008_manuscript_prose_blocks.sql"), "utf8"));
    await runStatements(client, fs.readFileSync(path.join(drizzleDir, "0009_citation_formatting.sql"), "utf8"));

    const activeItems = await client`select id, sort_order from manuscript_section_items where project_id=${projectId} order by sort_order, id`;
    expect(activeItems.map((row) => row.id)).toEqual([secondId, firstId]);
    expect(activeItems.map((row) => Number(row.sort_order))).toEqual([0, 1]);
    expect(await client`select id from manuscript_section_items where id=${removedPlacementId}`).toHaveLength(0);
    expect(await client`select placement_id, event_type, sequence from manuscript_claim_placement_events order by sequence`).toEqual(eventsBefore);
  });

  afterAll(async () => {
    if (client) await client.end();
    const admin = postgres(BASE_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE "${TEST_DB_NAME}" WITH (FORCE)`);
    await admin.end();
  });

  it("preserves active identities, historical removals, events, drops legacy ordering, and defaults style", async () => {
    const placements = await client`select id, claim_revision_id, removed_at from manuscript_claim_placements where project_id=${projectId} order by id`;
    expect(placements.filter((row) => activePlacementIds.includes(row.id)).map((row) => row.claim_revision_id)).toHaveLength(2);
    expect(placements.find((row) => row.id === removedPlacementId)?.removed_at).not.toBeNull();
    expect(await client`select column_name from information_schema.columns where table_name='manuscript_claim_placements' and column_name='sort_order'`).toHaveLength(0);
    expect(await client`select count(*)::int as count from manuscript_section_item_claims where project_id=${projectId}`).toEqual([{ count: 2 }]);
    expect(await client`select id, project_id, title, is_default, created_at, updated_at from manuscripts where id=${manuscriptId}`).toEqual(manuscriptBefore);
    expect(await client`select citation_style from manuscripts where id=${manuscriptId}`).toEqual([{ citation_style: "numeric" }]);
    await expect(client`update manuscripts set citation_style='csl' where id=${manuscriptId}`).rejects.toBeTruthy();
  });
});
