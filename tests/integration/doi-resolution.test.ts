import "dotenv/config";
import crypto from "node:crypto";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDoiResolutionServices } from "@/application/doi-resolution-services";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const DATABASE_NAME = `litreview_doi_resolution_${crypto.randomUUID().replaceAll("-", "")}`;
const DATABASE_URL = `${BASE_URL.replace(/\/[^/]+$/, "")}/${DATABASE_NAME}`;

describe("DOI researcher resolution", () => {
  let db: ReturnType<typeof createDb>["db"];
  let client: ReturnType<typeof createDb>["client"];
  let projectId: string;
  let otherProjectId: string;
  let review: ReturnType<typeof createReviewServices>;
  let resolutions: ReturnType<typeof createDoiResolutionServices>;

  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1, prepare: false });
    await admin.unsafe(`create database "${DATABASE_NAME}"`);
    await admin.end();
    const created = createDb(DATABASE_URL);
    db = created.db;
    client = created.client;
    await migrate(db, { migrationsFolder: "./drizzle" });
    review = createReviewServices(db);
    projectId = (await review.createProject({ title: "DOI resolution", researchQuestion: "What is known?" })).id;
    otherProjectId = (await review.createProject({ title: "Other project", researchQuestion: "What is known?" })).id;
    resolutions = createDoiResolutionServices(db);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    const admin = postgres(BASE_URL, { max: 1, prepare: false });
    await admin.unsafe(`drop database if exists "${DATABASE_NAME}" with (force)`);
    await admin.end();
  });

  async function seedLookup(input: { projectId?: string; doi?: string; outcome?: string; title?: string | null }) {
    const owner = input.projectId ?? projectId;
    const doi = input.doi ?? `10.1000/${crypto.randomUUID()}`;
    const requestId = crypto.randomUUID();
    const fetchId = crypto.randomUUID();
    const resultId = crypto.randomUUID();
    const dispatchId = crypto.randomUUID();
    const proposedTitle = input.title === undefined ? "A DOI result" : input.title;
    await client`
      insert into doi_lookup_requests
        (id, project_id, submitted_doi, normalized_doi, provider, provider_contract_version, provider_mapping_version, idempotency_key)
      values
        (${requestId}::uuid, ${owner}::uuid, ${doi}, ${doi.toLowerCase()}, 'crossref', 'doi-metadata-v1', 'bounded-provider-snapshot-v1', ${crypto.randomUUID()})
    `;
    await client`
      insert into bibliographic_metadata_fetches
        (id, provider, normalized_doi, provider_contract_version, provider_mapping_version, cache_key,
         started_at, deadline_at, execution_identity, rate_limit_per_second, concurrency_limit)
      values
        (${fetchId}::uuid, 'crossref', ${doi.toLowerCase()}, 'doi-metadata-v1', 'bounded-provider-snapshot-v1', ${`crossref:${doi.toLowerCase()}`},
         now(), now() + interval '1 minute', 'test', 10, 3)
    `;
    await client`
      insert into bibliographic_metadata_fetch_results
        (id, fetch_id, outcome, http_attempt_count, proposed_title, proposed_publication_year,
         proposed_venue, provider_doi, finalized_at)
      values
        (${resultId}::uuid, ${fetchId}::uuid, ${input.outcome ?? "succeeded"}, 1,
         ${proposedTitle}, 2024, 'Journal', ${doi.toLowerCase()}, now())
    `;
    await client`
      insert into bibliographic_metadata_result_authors
        (id, result_id, ordinal, given_name, family_name, display_name)
      values
        (${crypto.randomUUID()}::uuid, ${resultId}::uuid, 1, 'Ada', 'Lovelace', 'Ada Lovelace')
    `;
    await client`
      insert into doi_lookup_dispatches (id, project_id, request_id, fetch_id, dispatch_kind)
      values (${dispatchId}::uuid, ${owner}::uuid, ${requestId}::uuid, ${fetchId}::uuid, 'network_owner')
    `;
    return { owner, requestId, resultId, fetchId };
  }

  it("creates through writePaper only after the exact candidate preview is acknowledged", async () => {
    const existing = await review.addPaper(projectId, { title: "A DOI result", authors: ["Ada Lovelace"], publicationYear: 2024, venue: "Journal", doi: "10.1000/existing" });
    const lookup = await seedLookup({ doi: "10.1000/existing" });
    const preview = await resolutions.previewResolution(projectId, lookup.requestId, { resultId: lookup.resultId, action: "created_paper" });
    expect(preview.candidates).toEqual([expect.objectContaining({ paperId: existing.id, reason: "doi", rank: 1 })]);
    await expect(resolutions.resolveResolution(projectId, lookup.requestId, {
      resultId: lookup.resultId,
      action: "created_paper",
      expectedPreviousResolutionId: null,
      previewFingerprint: preview.fingerprint,
    })).rejects.toMatchObject({ code: "DUPLICATE_REVIEW_REQUIRED" });

    const resolved = await resolutions.resolveResolution(projectId, lookup.requestId, {
      resultId: lookup.resultId,
      action: "created_paper",
      expectedPreviousResolutionId: null,
      previewFingerprint: preview.fingerprint,
      acknowledgedCandidateIds: [existing.id],
    });
    expect(resolved.resolutionKind).toBe("created_paper");
    expect(resolved.paperId).not.toBe(existing.id);
    expect(resolved.candidateContext).toEqual(expect.arrayContaining([expect.objectContaining({ paperId: existing.id, selected: false })]));
    expect((await review.listPapers(projectId)).filter((paper) => paper.doi === "10.1000/existing")).toHaveLength(2);
  });

  it("rejects a stale create fingerprint after the candidate set changes", async () => {
    const lookup = await seedLookup({ doi: "10.1000/stale" });
    const preview = await resolutions.previewResolution(projectId, lookup.requestId, { resultId: lookup.resultId, action: "created_paper" });
    await client`
      insert into papers (id, project_id, title, authors, publication_year, doi)
      values (${crypto.randomUUID()}::uuid, ${projectId}::uuid, 'A DOI result', ${["Ada Lovelace"]}, 2024, '10.1000/stale')
    `;
    await expect(resolutions.resolveResolution(projectId, lookup.requestId, {
      resultId: lookup.resultId,
      action: "created_paper",
      expectedPreviousResolutionId: null,
      previewFingerprint: preview.fingerprint,
      distinctPaperAcknowledged: true,
    })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
  });

  it("matches without mutating the selected Paper and appends an explicit clear", async () => {
    const existing = await review.addPaper(projectId, { title: "Match me", authors: ["Original Author"], publicationYear: 2024, doi: "10.1000/match" });
    const lookup = await seedLookup({ doi: "10.1000/match", title: "Match me" });
    const preview = await resolutions.previewResolution(projectId, lookup.requestId, { resultId: lookup.resultId, action: "matched_paper", paperId: existing.id });
    const matched = await resolutions.resolveResolution(projectId, lookup.requestId, {
      resultId: lookup.resultId,
      action: "matched_paper",
      paperId: existing.id,
      expectedPreviousResolutionId: null,
      previewFingerprint: preview.fingerprint,
    });
    expect(matched.paperId).toBe(existing.id);
    expect((await review.listPapers(projectId)).find((paper) => paper.id === existing.id)).toMatchObject({ title: "Match me", authors: ["Original Author"] });

    const cleared = await resolutions.resolveResolution(projectId, lookup.requestId, {
      resultId: lookup.resultId,
      action: "cleared",
      expectedPreviousResolutionId: matched.id,
      note: "Researcher cleared the provisional identity",
    });
    expect(cleared.resolutionKind).toBe("cleared");
    expect(cleared.paperId).toBeNull();
    expect((await resolutions.currentResolution(projectId, lookup.requestId))?.resolutionKind).toBe("cleared");
  });

  it("retains an exact DOI candidate when the provider title is unavailable", async () => {
    const existing = await review.addPaper(projectId, { title: "Canonical title", authors: ["Original Author"], publicationYear: 2024, doi: "10.1000/title-unavailable" });
    const lookup = await seedLookup({ doi: "10.1000/title-unavailable", title: null });
    const preview = await resolutions.previewResolution(projectId, lookup.requestId, { resultId: lookup.resultId, action: "matched_paper", paperId: existing.id });
    expect(preview.candidates).toEqual([expect.objectContaining({ paperId: existing.id, reason: "doi", rank: 1 })]);
  });

  it("requires an exact succeeded result and rejects cross-project or mismatched linkage", async () => {
    const failed = await seedLookup({ outcome: "not_found" });
    await expect(resolutions.previewResolution(projectId, failed.requestId, { resultId: failed.resultId, action: "cleared" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const first = await seedLookup({ title: "First" });
    const second = await seedLookup({ title: "Second" });
    await expect(resolutions.previewResolution(projectId, first.requestId, { resultId: second.resultId, action: "cleared" })).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
    await expect(resolutions.previewResolution(otherProjectId, first.requestId, { resultId: first.resultId, action: "cleared" })).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
  });
});
