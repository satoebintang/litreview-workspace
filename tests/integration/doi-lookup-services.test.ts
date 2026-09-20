import "dotenv/config";
import crypto from "node:crypto";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { describe, expect, it } from "vitest";
import { createPostgresDoiLookupServices } from "@/application/doi-lookup-services";
import {
  BIBLIOGRAPHIC_METADATA_LOOKUP_CONTRACT_VERSION,
  CROSSREF_WORK_MAPPING_VERSION,
  type BibliographicMetadataLookupAttemptAccounting,
  type BibliographicMetadataLookupResult,
} from "@/application/bibliographic-metadata-lookup-provider";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";

function success(doi: string, startedAt: Date): BibliographicMetadataLookupResult {
  const finalizedAt = new Date(startedAt.getTime() + 1);
  return {
    kind: "success",
    proposal: {
      requestedDoi: doi,
      returnedDoi: doi,
      title: "A bounded DOI result",
      authors: ["Ada Lovelace"],
      authorDetails: [{ given: "Ada", family: "Lovelace", literal: null, suffix: null, orcid: null, displayName: "Ada Lovelace", providerSequence: null }],
      publicationYear: 2024,
      venue: "Journal",
      providerType: "journal-article",
      publisher: "Publisher",
      url: `https://doi.org/${doi}`,
      sourceSnapshot: {
        DOI: doi,
        title: ["A bounded DOI result"],
        author: [{ given: "Ada", family: "Lovelace" }],
        authorCount: 1,
        published: { "date-parts": [[2024]] },
        "published-print": null,
        "published-online": null,
        issued: null,
        "container-title": ["Journal"],
        type: "journal-article",
        publisher: "Publisher",
        URL: `https://doi.org/${doi}`,
      },
      warnings: [],
    },
    evidence: {
      provider: "crossref",
      endpoint: "https://api.crossref.org/v1/works/10.1000/example",
      httpStatus: 200,
      contentType: "application/json",
      responseByteSize: 100,
      responseSha256: "0".repeat(64),
      observedRateLimitPerSecond: null,
      observedConcurrencyLimit: null,
      attemptCount: 1,
      startedAt,
      finalizedAt,
    },
  };
}

describe("PostgreSQL DOI lookup lifecycle", () => {
  it("accounts every outbound attempt, reuses exact cache identity, and selects the earliest late success", async () => {
    const databaseName = `slice30_doi_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = postgres(BASE_URL, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const database = createDb(`${BASE_URL.replace(/\/[^/]+$/, "")}/${databaseName}`);
    try {
      await migrate(database.db, { migrationsFolder: "./drizzle" });
      const review = createReviewServices(database.db);
      const project = await review.createProject({ title: "DOI lookup lifecycle", researchQuestion: "What is known?" });
      let providerCalls = 0;
      const providerFactory = (accounting: BibliographicMetadataLookupAttemptAccounting) => ({
        provider: "crossref",
        contractVersion: BIBLIOGRAPHIC_METADATA_LOOKUP_CONTRACT_VERSION,
        mappingVersion: CROSSREF_WORK_MAPPING_VERSION,
        lookup: async ({ doi }: { doi: string }) => {
          providerCalls += 1;
          const startedAt = new Date();
          const lease = await accounting.begin({ provider: "crossref", doi, url: `https://api.crossref.org/v1/works/${doi}`, attempt: 1, redirect: 0, startedAt });
          await lease.release({ status: "succeeded", httpStatus: 200, outcomeCode: "fixture" });
          return success(doi, startedAt);
        },
      });
      const services = createPostgresDoiLookupServices(database.db, providerFactory, { sleep: async () => undefined });

      const first = await services.beginDoiLookup({ projectId: project.id, submittedDoi: "doi:10.1000/example", idempotencyKey: "first" });
      const firstDone = await services.executeDoiLookup(first.request.id, project.id);
      expect(firstDone.state).toBe("succeeded");
      expect(firstDone.result?.authors).toEqual([expect.objectContaining({ displayName: "Ada Lovelace" })]);
      expect(providerCalls).toBe(1);
      const firstAttempt = await database.client`select request_url, attempt_ordinal, status, http_status from bibliographic_metadata_http_attempts`;
      expect(firstAttempt).toEqual([expect.objectContaining({ request_url: "https://api.crossref.org/v1/works/10.1000/example", attempt_ordinal: 1, status: "succeeded", http_status: 200 })]);
      const rawColumns = await database.client`select column_name from information_schema.columns where table_name='bibliographic_metadata_fetch_results' and column_name like 'source_evidence%'`;
      expect(rawColumns).toHaveLength(0);

      const second = await services.beginDoiLookup({ projectId: project.id, submittedDoi: "10.1000/example", idempotencyKey: "second" });
      const secondDone = await services.executeDoiLookup(second.request.id, project.id);
      expect(secondDone.state).toBe("succeeded");
      expect(providerCalls).toBe(1);
      expect((await database.client`select dispatch_kind from doi_lookup_dispatches where request_id=${second.request.id}::uuid order by sequence desc`)[0].dispatch_kind).toBe("cache_reuse");

      const raceDoi = "10.1000/late-race";
      const fetchB = crypto.randomUUID();
      const fetchA = crypto.randomUUID();
      await database.client`
        insert into bibliographic_metadata_fetches (id,provider,normalized_doi,provider_contract_version,provider_mapping_version,cache_key,started_at,deadline_at,execution_identity,rate_limit_per_second,concurrency_limit)
        values (${fetchB}::uuid,'crossref',${raceDoi},${BIBLIOGRAPHIC_METADATA_LOOKUP_CONTRACT_VERSION},${CROSSREF_WORK_MAPPING_VERSION},${`crossref|${raceDoi}|${BIBLIOGRAPHIC_METADATA_LOOKUP_CONTRACT_VERSION}|${CROSSREF_WORK_MAPPING_VERSION}`},now()-interval '3 seconds',now()+interval '1 minute','late-b',10,3),
               (${fetchA}::uuid,'crossref',${raceDoi},${BIBLIOGRAPHIC_METADATA_LOOKUP_CONTRACT_VERSION},${CROSSREF_WORK_MAPPING_VERSION},${`crossref|${raceDoi}|${BIBLIOGRAPHIC_METADATA_LOOKUP_CONTRACT_VERSION}|${CROSSREF_WORK_MAPPING_VERSION}`},now()-interval '2 seconds',now()+interval '1 minute','late-a',10,3)
      `;
      const hash = "1".repeat(64);
      await database.client`
        insert into bibliographic_metadata_fetch_results (fetch_id,outcome,http_attempt_count,response_byte_size,response_sha256,source_snapshot,provider_doi,proposed_title,proposed_publication_year,finalized_at,created_at)
        values (${fetchB}::uuid,'succeeded',1,1,${hash},${JSON.stringify({ DOI: raceDoi, title: ["B"], author: null, authorCount: null, published: null, "published-print": null, "published-online": null, issued: null, "container-title": [], type: null, publisher: null, URL: null })}::jsonb,${raceDoi},'B',2024,now()-interval '1 second',now()-interval '2 seconds'),
               (${fetchA}::uuid,'succeeded',1,1,${hash},${JSON.stringify({ DOI: raceDoi, title: ["A"], author: null, authorCount: null, published: null, "published-print": null, "published-online": null, issued: null, "container-title": [], type: null, publisher: null, URL: null })}::jsonb,${raceDoi},'A',2024,now(),now()-interval '1 second')
      `;
      const race = await services.beginDoiLookup({ projectId: project.id, submittedDoi: raceDoi, idempotencyKey: "late-race" });
      const raceDone = await services.executeDoiLookup(race.request.id, project.id);
      expect(raceDone.result?.proposedTitle).toBe("B");
      expect(providerCalls).toBe(1);
      expect((await database.client`select count(*)::integer as count from bibliographic_metadata_fetch_results where fetch_id in (${fetchA}::uuid,${fetchB}::uuid)`)[0].count).toBe(2);

      await expect(database.client`update doi_lookup_requests set submitted_doi='mutated' where id=${first.request.id}::uuid`).rejects.toThrow();
    } finally {
      await database.client.end();
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end();
    }
  }, 120_000);
});
