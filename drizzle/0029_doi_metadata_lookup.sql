CREATE TABLE "bibliographic_metadata_fetch_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fetch_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"http_attempt_count" integer NOT NULL,
	"last_http_status" integer,
	"response_content_type" text,
	"response_byte_size" integer,
	"response_sha256" text,
	"source_snapshot" jsonb,
	"provider_doi" text,
	"proposed_title" text,
	"proposed_publication_year" integer,
	"proposed_venue" text,
	"provider_type" text,
	"provider_publisher" text,
	"provider_url" text,
	"authors_state" text DEFAULT 'absent' NOT NULL,
	"reported_author_count" integer,
	"mapping_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"diagnostic_code" text,
	"diagnostic_message" text,
	"provider_request_id" text,
	"observed_rate_limit_per_second" integer,
	"observed_concurrency_limit" integer,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone NOT NULL,
	CONSTRAINT "bibliographic_metadata_fetch_results_fetch_id_unique" UNIQUE("fetch_id"),
	CONSTRAINT "bibliographic_metadata_fetch_results_outcome_valid" CHECK ("bibliographic_metadata_fetch_results"."outcome" in ('succeeded', 'not_found', 'provider_unavailable', 'rate_limited', 'invalid_response', 'provider_mismatch', 'failed')),
	CONSTRAINT "bibliographic_metadata_fetch_results_attempt_count_valid" CHECK ("bibliographic_metadata_fetch_results"."http_attempt_count" >= 0 and "bibliographic_metadata_fetch_results"."http_attempt_count" <= 3),
	CONSTRAINT "bibliographic_metadata_fetch_results_http_status_valid" CHECK ("bibliographic_metadata_fetch_results"."last_http_status" is null or ("bibliographic_metadata_fetch_results"."last_http_status" >= 100 and "bibliographic_metadata_fetch_results"."last_http_status" <= 599)),
	CONSTRAINT "bibliographic_metadata_fetch_results_response_evidence_shape" CHECK ((("bibliographic_metadata_fetch_results"."response_byte_size" is null and "bibliographic_metadata_fetch_results"."response_sha256" is null) or ("bibliographic_metadata_fetch_results"."response_byte_size" > 0 and "bibliographic_metadata_fetch_results"."response_byte_size" <= 2097152 and "bibliographic_metadata_fetch_results"."response_sha256" ~ '^[0-9a-f]{64}$'))),
	CONSTRAINT "bibliographic_metadata_fetch_results_authors_state_valid" CHECK ("bibliographic_metadata_fetch_results"."authors_state" in ('valid', 'invalid', 'absent')),
	CONSTRAINT "bibliographic_metadata_fetch_results_reported_author_count_valid" CHECK ("bibliographic_metadata_fetch_results"."reported_author_count" is null or ("bibliographic_metadata_fetch_results"."reported_author_count" >= 0 and "bibliographic_metadata_fetch_results"."reported_author_count" <= 10000)),
	CONSTRAINT "bibliographic_metadata_fetch_results_year_valid" CHECK ("bibliographic_metadata_fetch_results"."proposed_publication_year" is null or ("bibliographic_metadata_fetch_results"."proposed_publication_year" >= 1000 and "bibliographic_metadata_fetch_results"."proposed_publication_year" <= 3000)),
	CONSTRAINT "bibliographic_metadata_fetch_results_title_shape" CHECK ("bibliographic_metadata_fetch_results"."proposed_title" is null or (btrim("bibliographic_metadata_fetch_results"."proposed_title") <> '' and char_length("bibliographic_metadata_fetch_results"."proposed_title") <= 1000)),
	CONSTRAINT "bibliographic_metadata_fetch_results_venue_shape" CHECK ("bibliographic_metadata_fetch_results"."proposed_venue" is null or (btrim("bibliographic_metadata_fetch_results"."proposed_venue") <> '' and char_length("bibliographic_metadata_fetch_results"."proposed_venue") <= 1000)),
	CONSTRAINT "bibliographic_metadata_fetch_results_provider_type_shape" CHECK ("bibliographic_metadata_fetch_results"."provider_type" is null or (btrim("bibliographic_metadata_fetch_results"."provider_type") <> '' and char_length("bibliographic_metadata_fetch_results"."provider_type") <= 200)),
	CONSTRAINT "bibliographic_metadata_fetch_results_publisher_shape" CHECK ("bibliographic_metadata_fetch_results"."provider_publisher" is null or (btrim("bibliographic_metadata_fetch_results"."provider_publisher") <> '' and char_length("bibliographic_metadata_fetch_results"."provider_publisher") <= 1000)),
	CONSTRAINT "bibliographic_metadata_fetch_results_provider_url_shape" CHECK ("bibliographic_metadata_fetch_results"."provider_url" is null or (char_length("bibliographic_metadata_fetch_results"."provider_url") <= 2048 and "bibliographic_metadata_fetch_results"."provider_url" ~ '^https?://')),
	CONSTRAINT "bibliographic_metadata_fetch_results_diagnostic_code_shape" CHECK ("bibliographic_metadata_fetch_results"."diagnostic_code" is null or (btrim("bibliographic_metadata_fetch_results"."diagnostic_code") <> '' and char_length("bibliographic_metadata_fetch_results"."diagnostic_code") <= 80)),
	CONSTRAINT "bibliographic_metadata_fetch_results_diagnostic_message_shape" CHECK ("bibliographic_metadata_fetch_results"."diagnostic_message" is null or char_length("bibliographic_metadata_fetch_results"."diagnostic_message") <= 2000),
	CONSTRAINT "bibliographic_metadata_fetch_results_provider_request_id_shape" CHECK ("bibliographic_metadata_fetch_results"."provider_request_id" is null or (btrim("bibliographic_metadata_fetch_results"."provider_request_id") <> '' and char_length("bibliographic_metadata_fetch_results"."provider_request_id") <= 200)),
	CONSTRAINT "bibliographic_metadata_fetch_results_duration_valid" CHECK ("bibliographic_metadata_fetch_results"."duration_ms" is null or ("bibliographic_metadata_fetch_results"."duration_ms" >= 0 and "bibliographic_metadata_fetch_results"."duration_ms" <= 600000)),
	CONSTRAINT "bibliographic_metadata_fetch_results_finalized_shape" CHECK ("bibliographic_metadata_fetch_results"."finalized_at" >= "bibliographic_metadata_fetch_results"."created_at")
);
--> statement-breakpoint
CREATE TABLE "bibliographic_metadata_fetches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"normalized_doi" text NOT NULL,
	"provider_contract_version" text NOT NULL,
	"provider_mapping_version" text NOT NULL,
	"cache_key" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"execution_identity" text NOT NULL,
	"rate_limit_per_second" integer NOT NULL,
	"concurrency_limit" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bibliographic_metadata_fetches_provider_shape" CHECK (char_length("bibliographic_metadata_fetches"."provider") <= 100 and btrim("bibliographic_metadata_fetches"."provider") <> ''),
	CONSTRAINT "bibliographic_metadata_fetches_doi_shape" CHECK (char_length("bibliographic_metadata_fetches"."normalized_doi") <= 1000 and btrim("bibliographic_metadata_fetches"."normalized_doi") <> '' and "bibliographic_metadata_fetches"."normalized_doi" !~ '[\u0000-\u001f\u007f]'),
	CONSTRAINT "bibliographic_metadata_fetches_contract_shape" CHECK (char_length("bibliographic_metadata_fetches"."provider_contract_version") <= 100 and btrim("bibliographic_metadata_fetches"."provider_contract_version") <> ''),
	CONSTRAINT "bibliographic_metadata_fetches_mapping_shape" CHECK (char_length("bibliographic_metadata_fetches"."provider_mapping_version") <= 100 and btrim("bibliographic_metadata_fetches"."provider_mapping_version") <> ''),
	CONSTRAINT "bibliographic_metadata_fetches_cache_key_shape" CHECK (char_length("bibliographic_metadata_fetches"."cache_key") <= 2500 and btrim("bibliographic_metadata_fetches"."cache_key") <> ''),
	CONSTRAINT "bibliographic_metadata_fetches_execution_identity_shape" CHECK (char_length("bibliographic_metadata_fetches"."execution_identity") <= 200 and btrim("bibliographic_metadata_fetches"."execution_identity") <> ''),
	CONSTRAINT "bibliographic_metadata_fetches_deadline_shape" CHECK ("bibliographic_metadata_fetches"."deadline_at" > "bibliographic_metadata_fetches"."started_at"),
	CONSTRAINT "bibliographic_metadata_fetches_schedule_shape" CHECK ("bibliographic_metadata_fetches"."rate_limit_per_second" > 0 and "bibliographic_metadata_fetches"."rate_limit_per_second" <= 1000 and "bibliographic_metadata_fetches"."concurrency_limit" > 0 and "bibliographic_metadata_fetches"."concurrency_limit" <= 100)
);
--> statement-breakpoint
CREATE TABLE "bibliographic_metadata_http_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fetch_id" uuid NOT NULL,
	"attempt_ordinal" integer NOT NULL,
	"request_url" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"status" text DEFAULT 'started' NOT NULL,
	"http_status" integer,
	"outcome_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bibliographic_metadata_http_attempts_fetch_attempt_unique" UNIQUE("fetch_id","attempt_ordinal"),
	CONSTRAINT "bibliographic_metadata_http_attempts_ordinal_valid" CHECK ("bibliographic_metadata_http_attempts"."attempt_ordinal" >= 1 and "bibliographic_metadata_http_attempts"."attempt_ordinal" <= 3),
	CONSTRAINT "bibliographic_metadata_http_attempts_url_shape" CHECK (char_length("bibliographic_metadata_http_attempts"."request_url") <= 4096 and "bibliographic_metadata_http_attempts"."request_url" ~ '^https://api\.crossref\.org/' and "bibliographic_metadata_http_attempts"."request_url" !~ '[?&]mailto='),
	CONSTRAINT "bibliographic_metadata_http_attempts_status_valid" CHECK ("bibliographic_metadata_http_attempts"."status" in ('started', 'succeeded', 'failed')),
	CONSTRAINT "bibliographic_metadata_http_attempts_http_status_valid" CHECK ("bibliographic_metadata_http_attempts"."http_status" is null or ("bibliographic_metadata_http_attempts"."http_status" >= 100 and "bibliographic_metadata_http_attempts"."http_status" <= 599)),
	CONSTRAINT "bibliographic_metadata_http_attempts_lifecycle_shape" CHECK (("bibliographic_metadata_http_attempts"."status" = 'started' and "bibliographic_metadata_http_attempts"."completed_at" is null) or ("bibliographic_metadata_http_attempts"."status" in ('succeeded', 'failed') and "bibliographic_metadata_http_attempts"."completed_at" is not null)),
	CONSTRAINT "bibliographic_metadata_http_attempts_outcome_code_shape" CHECK ("bibliographic_metadata_http_attempts"."outcome_code" is null or (btrim("bibliographic_metadata_http_attempts"."outcome_code") <> '' and char_length("bibliographic_metadata_http_attempts"."outcome_code") <= 80))
);
--> statement-breakpoint
CREATE TABLE "bibliographic_metadata_result_authors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"result_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"given_name" text,
	"family_name" text,
	"literal_name" text,
	"suffix" text,
	"orcid" text,
	"display_name" text NOT NULL,
	"provider_sequence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bibliographic_metadata_result_authors_result_id_id_unique" UNIQUE("result_id","id"),
	CONSTRAINT "bibliographic_metadata_result_authors_result_ordinal_unique" UNIQUE("result_id","ordinal"),
	CONSTRAINT "bibliographic_metadata_result_authors_ordinal_valid" CHECK ("bibliographic_metadata_result_authors"."ordinal" >= 1 and "bibliographic_metadata_result_authors"."ordinal" <= 200),
	CONSTRAINT "bibliographic_metadata_result_authors_given_name_shape" CHECK ("bibliographic_metadata_result_authors"."given_name" is null or (btrim("bibliographic_metadata_result_authors"."given_name") <> '' and char_length("bibliographic_metadata_result_authors"."given_name") <= 500)),
	CONSTRAINT "bibliographic_metadata_result_authors_family_name_shape" CHECK ("bibliographic_metadata_result_authors"."family_name" is null or (btrim("bibliographic_metadata_result_authors"."family_name") <> '' and char_length("bibliographic_metadata_result_authors"."family_name") <= 500)),
	CONSTRAINT "bibliographic_metadata_result_authors_literal_name_shape" CHECK ("bibliographic_metadata_result_authors"."literal_name" is null or (btrim("bibliographic_metadata_result_authors"."literal_name") <> '' and char_length("bibliographic_metadata_result_authors"."literal_name") <= 500)),
	CONSTRAINT "bibliographic_metadata_result_authors_suffix_shape" CHECK ("bibliographic_metadata_result_authors"."suffix" is null or (btrim("bibliographic_metadata_result_authors"."suffix") <> '' and char_length("bibliographic_metadata_result_authors"."suffix") <= 500)),
	CONSTRAINT "bibliographic_metadata_result_authors_orcid_shape" CHECK ("bibliographic_metadata_result_authors"."orcid" is null or (btrim("bibliographic_metadata_result_authors"."orcid") <> '' and char_length("bibliographic_metadata_result_authors"."orcid") <= 200)),
	CONSTRAINT "bibliographic_metadata_result_authors_display_name_shape" CHECK (btrim("bibliographic_metadata_result_authors"."display_name") <> '' and char_length("bibliographic_metadata_result_authors"."display_name") <= 500),
	CONSTRAINT "bibliographic_metadata_result_authors_provider_sequence_shape" CHECK ("bibliographic_metadata_result_authors"."provider_sequence" is null or (btrim("bibliographic_metadata_result_authors"."provider_sequence") <> '' and char_length("bibliographic_metadata_result_authors"."provider_sequence") <= 32)),
	CONSTRAINT "bibliographic_metadata_result_authors_name_shape" CHECK (("bibliographic_metadata_result_authors"."literal_name" is not null and "bibliographic_metadata_result_authors"."given_name" is null and "bibliographic_metadata_result_authors"."family_name" is null) or ("bibliographic_metadata_result_authors"."literal_name" is null and ("bibliographic_metadata_result_authors"."given_name" is not null or "bibliographic_metadata_result_authors"."family_name" is not null)))
);
--> statement-breakpoint
CREATE TABLE "doi_lookup_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "doi_lookup_dispatches_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"fetch_id" uuid NOT NULL,
	"dispatch_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doi_lookup_dispatches_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "doi_lookup_dispatches_kind_valid" CHECK ("doi_lookup_dispatches"."dispatch_kind" in ('network_owner', 'network_shared', 'cache_reuse'))
);
--> statement-breakpoint
CREATE TABLE "doi_lookup_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"submitted_doi" text NOT NULL,
	"normalized_doi" text NOT NULL,
	"provider" text NOT NULL,
	"provider_contract_version" text NOT NULL,
	"provider_mapping_version" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doi_lookup_requests_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "doi_lookup_requests_project_id_idempotency_key_unique" UNIQUE("project_id","idempotency_key"),
	CONSTRAINT "doi_lookup_requests_submitted_doi_shape" CHECK (char_length("doi_lookup_requests"."submitted_doi") <= 1000 and btrim("doi_lookup_requests"."submitted_doi") <> '' and "doi_lookup_requests"."submitted_doi" !~ '[\u0000-\u001f\u007f]'),
	CONSTRAINT "doi_lookup_requests_normalized_doi_shape" CHECK (char_length("doi_lookup_requests"."normalized_doi") <= 1000 and btrim("doi_lookup_requests"."normalized_doi") <> '' and "doi_lookup_requests"."normalized_doi" !~ '[\u0000-\u001f\u007f]'),
	CONSTRAINT "doi_lookup_requests_provider_shape" CHECK (char_length("doi_lookup_requests"."provider") <= 100 and btrim("doi_lookup_requests"."provider") <> ''),
	CONSTRAINT "doi_lookup_requests_contract_version_shape" CHECK (char_length("doi_lookup_requests"."provider_contract_version") <= 100 and btrim("doi_lookup_requests"."provider_contract_version") <> ''),
	CONSTRAINT "doi_lookup_requests_mapping_version_shape" CHECK (char_length("doi_lookup_requests"."provider_mapping_version") <= 100 and btrim("doi_lookup_requests"."provider_mapping_version") <> ''),
	CONSTRAINT "doi_lookup_requests_idempotency_key_shape" CHECK (char_length("doi_lookup_requests"."idempotency_key") <= 200 and btrim("doi_lookup_requests"."idempotency_key") <> '')
);
--> statement-breakpoint
CREATE TABLE "doi_lookup_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "doi_lookup_resolutions_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"resolution_kind" text NOT NULL,
	"paper_id" uuid,
	"expected_previous_resolution_id" uuid,
	"creation_payload" jsonb,
	"candidate_context" jsonb,
	"preview_fingerprint" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doi_lookup_resolutions_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "doi_lookup_resolutions_kind_valid" CHECK ("doi_lookup_resolutions"."resolution_kind" in ('created_paper', 'matched_paper', 'cleared')),
	CONSTRAINT "doi_lookup_resolutions_paper_shape" CHECK ((("doi_lookup_resolutions"."resolution_kind" in ('created_paper', 'matched_paper') and "doi_lookup_resolutions"."paper_id" is not null) or ("doi_lookup_resolutions"."resolution_kind" = 'cleared' and "doi_lookup_resolutions"."paper_id" is null))),
	CONSTRAINT "doi_lookup_resolutions_creation_payload_shape" CHECK ((("doi_lookup_resolutions"."resolution_kind" = 'created_paper' and "doi_lookup_resolutions"."creation_payload" is not null) or ("doi_lookup_resolutions"."resolution_kind" <> 'created_paper' and "doi_lookup_resolutions"."creation_payload" is null))),
	CONSTRAINT "doi_lookup_resolutions_preview_fingerprint_shape" CHECK ("doi_lookup_resolutions"."preview_fingerprint" is null or ("doi_lookup_resolutions"."preview_fingerprint" ~ '^[0-9a-f]{64}$' and char_length("doi_lookup_resolutions"."preview_fingerprint") = 64)),
	CONSTRAINT "doi_lookup_resolutions_note_shape" CHECK ("doi_lookup_resolutions"."note" is null or (btrim("doi_lookup_resolutions"."note") <> '' and char_length("doi_lookup_resolutions"."note") <= 2000))
);
--> statement-breakpoint
ALTER TABLE "bibliographic_metadata_fetch_results" ADD CONSTRAINT "bibliographic_metadata_fetch_results_fetch_fk" FOREIGN KEY ("fetch_id") REFERENCES "public"."bibliographic_metadata_fetches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bibliographic_metadata_http_attempts" ADD CONSTRAINT "bibliographic_metadata_http_attempts_fetch_fk" FOREIGN KEY ("fetch_id") REFERENCES "public"."bibliographic_metadata_fetches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bibliographic_metadata_result_authors" ADD CONSTRAINT "bibliographic_metadata_result_authors_result_fk" FOREIGN KEY ("result_id") REFERENCES "public"."bibliographic_metadata_fetch_results"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doi_lookup_dispatches" ADD CONSTRAINT "doi_lookup_dispatches_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doi_lookup_dispatches" ADD CONSTRAINT "doi_lookup_dispatches_request_fk" FOREIGN KEY ("project_id","request_id") REFERENCES "public"."doi_lookup_requests"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doi_lookup_dispatches" ADD CONSTRAINT "doi_lookup_dispatches_fetch_fk" FOREIGN KEY ("fetch_id") REFERENCES "public"."bibliographic_metadata_fetches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doi_lookup_requests" ADD CONSTRAINT "doi_lookup_requests_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doi_lookup_resolutions" ADD CONSTRAINT "doi_lookup_resolutions_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doi_lookup_resolutions" ADD CONSTRAINT "doi_lookup_resolutions_request_fk" FOREIGN KEY ("project_id","request_id") REFERENCES "public"."doi_lookup_requests"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doi_lookup_resolutions" ADD CONSTRAINT "doi_lookup_resolutions_result_fk" FOREIGN KEY ("result_id") REFERENCES "public"."bibliographic_metadata_fetch_results"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doi_lookup_resolutions" ADD CONSTRAINT "doi_lookup_resolutions_paper_fk" FOREIGN KEY ("project_id","paper_id") REFERENCES "public"."papers"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doi_lookup_resolutions" ADD CONSTRAINT "doi_lookup_resolutions_expected_previous_fk" FOREIGN KEY ("project_id","expected_previous_resolution_id") REFERENCES "public"."doi_lookup_resolutions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bibliographic_metadata_fetch_results_finalized_at_id_idx" ON "bibliographic_metadata_fetch_results" USING btree ("finalized_at","id");--> statement-breakpoint
CREATE INDEX "bibliographic_metadata_fetch_results_outcome_finalized_at_idx" ON "bibliographic_metadata_fetch_results" USING btree ("outcome","finalized_at","id");--> statement-breakpoint
CREATE INDEX "bibliographic_metadata_fetches_cache_identity_idx" ON "bibliographic_metadata_fetches" USING btree ("provider","normalized_doi","provider_contract_version","provider_mapping_version");--> statement-breakpoint
CREATE INDEX "bibliographic_metadata_fetches_cache_key_idx" ON "bibliographic_metadata_fetches" USING btree ("cache_key");--> statement-breakpoint
CREATE INDEX "bibliographic_metadata_fetches_provider_started_at_idx" ON "bibliographic_metadata_fetches" USING btree ("provider","started_at");--> statement-breakpoint
CREATE INDEX "bibliographic_metadata_http_attempts_fetch_started_at_idx" ON "bibliographic_metadata_http_attempts" USING btree ("fetch_id","started_at");--> statement-breakpoint
CREATE INDEX "bibliographic_metadata_http_attempts_started_at_status_idx" ON "bibliographic_metadata_http_attempts" USING btree ("started_at","status");--> statement-breakpoint
CREATE INDEX "doi_lookup_dispatches_project_request_sequence_idx" ON "doi_lookup_dispatches" USING btree ("project_id","request_id","sequence");--> statement-breakpoint
CREATE INDEX "doi_lookup_dispatches_fetch_sequence_idx" ON "doi_lookup_dispatches" USING btree ("fetch_id","sequence");--> statement-breakpoint
CREATE INDEX "doi_lookup_requests_project_created_at_idx" ON "doi_lookup_requests" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "doi_lookup_requests_project_normalized_doi_idx" ON "doi_lookup_requests" USING btree ("project_id","normalized_doi");--> statement-breakpoint
CREATE INDEX "doi_lookup_resolutions_project_request_sequence_idx" ON "doi_lookup_resolutions" USING btree ("project_id","request_id","sequence");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION doi_lookup_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55006';
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION doi_lookup_attempt_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.fetch_id <> NEW.fetch_id
    OR OLD.attempt_ordinal <> NEW.attempt_ordinal
    OR OLD.request_url <> NEW.request_url
    OR OLD.started_at <> NEW.started_at
    OR OLD.created_at <> NEW.created_at
    OR OLD.status <> 'started'
    OR OLD.completed_at IS NOT NULL
    OR NEW.status NOT IN ('succeeded', 'failed')
    OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'HTTP attempt lifecycle permits only one started-to-terminal transition' USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION doi_lookup_dispatch_consistency_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  request_row record;
  fetch_row record;
BEGIN
  SELECT project_id, provider, normalized_doi, provider_contract_version, provider_mapping_version
    INTO request_row
    FROM doi_lookup_requests
   WHERE project_id = NEW.project_id AND id = NEW.request_id;
  SELECT provider, normalized_doi, provider_contract_version, provider_mapping_version
    INTO fetch_row
    FROM bibliographic_metadata_fetches
   WHERE id = NEW.fetch_id;
  IF request_row IS NULL OR fetch_row IS NULL
    OR request_row.provider <> fetch_row.provider
    OR request_row.normalized_doi <> fetch_row.normalized_doi
    OR request_row.provider_contract_version <> fetch_row.provider_contract_version
    OR request_row.provider_mapping_version <> fetch_row.provider_mapping_version THEN
    RAISE EXCEPTION 'DOI dispatch request and fetch identities must match' USING ERRCODE = '23514';
  END IF;
  IF NEW.dispatch_kind = 'cache_reuse'
    AND NOT EXISTS (
      SELECT 1 FROM bibliographic_metadata_fetch_results r
       WHERE r.fetch_id = NEW.fetch_id AND r.outcome = 'succeeded'
    ) THEN
    RAISE EXCEPTION 'Cache reuse requires a succeeded fetch result' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION doi_lookup_result_snapshot_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  forbidden text[] := ARRAY['abstract', 'reference', 'references', 'unknown', 'raw'];
  key_name text;
BEGIN
  IF NEW.source_snapshot IS NOT NULL THEN
    FOR key_name IN SELECT jsonb_object_keys(NEW.source_snapshot) LOOP
      IF key_name = ANY(forbidden) THEN
        RAISE EXCEPTION 'Provider source snapshot contains a forbidden field: %', key_name USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;
  IF NEW.outcome <> 'succeeded' AND EXISTS (SELECT 1 FROM bibliographic_metadata_result_authors a WHERE a.result_id = NEW.id) THEN
    RAISE EXCEPTION 'Only succeeded results may have mapped authors' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION doi_lookup_resolution_consistency_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  request_row record;
  result_row record;
  latest_id uuid;
BEGIN
  SELECT project_id, provider, normalized_doi, provider_contract_version, provider_mapping_version
    INTO request_row
    FROM doi_lookup_requests
   WHERE project_id = NEW.project_id AND id = NEW.request_id;
  SELECT f.provider, f.normalized_doi, f.provider_contract_version, f.provider_mapping_version, r.outcome
    INTO result_row
    FROM bibliographic_metadata_fetch_results r
    JOIN bibliographic_metadata_fetches f ON f.id = r.fetch_id
   WHERE r.id = NEW.result_id;
  SELECT id INTO latest_id
    FROM doi_lookup_resolutions
   WHERE project_id = NEW.project_id AND request_id = NEW.request_id
   ORDER BY sequence DESC
   LIMIT 1;
  IF request_row IS NULL OR result_row IS NULL
    OR result_row.outcome <> 'succeeded'
    OR request_row.provider <> result_row.provider
    OR request_row.normalized_doi <> result_row.normalized_doi
    OR request_row.provider_contract_version <> result_row.provider_contract_version
    OR request_row.provider_mapping_version <> result_row.provider_mapping_version
    OR (latest_id IS NULL AND NEW.expected_previous_resolution_id IS NOT NULL)
    OR (latest_id IS NOT NULL AND NEW.expected_previous_resolution_id IS DISTINCT FROM latest_id) THEN
    RAISE EXCEPTION 'DOI resolution must reference the current successful result and exact predecessor' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER doi_lookup_requests_append_only
  BEFORE UPDATE OR DELETE ON doi_lookup_requests
  FOR EACH ROW EXECUTE FUNCTION doi_lookup_reject_mutation();
CREATE TRIGGER bibliographic_metadata_fetches_append_only
  BEFORE UPDATE OR DELETE ON bibliographic_metadata_fetches
  FOR EACH ROW EXECUTE FUNCTION doi_lookup_reject_mutation();
CREATE TRIGGER doi_lookup_dispatches_append_only
  BEFORE UPDATE OR DELETE ON doi_lookup_dispatches
  FOR EACH ROW EXECUTE FUNCTION doi_lookup_reject_mutation();
CREATE TRIGGER bibliographic_metadata_fetch_results_append_only
  BEFORE UPDATE OR DELETE ON bibliographic_metadata_fetch_results
  FOR EACH ROW EXECUTE FUNCTION doi_lookup_reject_mutation();
CREATE TRIGGER bibliographic_metadata_result_authors_append_only
  BEFORE UPDATE OR DELETE ON bibliographic_metadata_result_authors
  FOR EACH ROW EXECUTE FUNCTION doi_lookup_reject_mutation();
CREATE TRIGGER doi_lookup_resolutions_append_only
  BEFORE UPDATE OR DELETE ON doi_lookup_resolutions
  FOR EACH ROW EXECUTE FUNCTION doi_lookup_reject_mutation();
CREATE TRIGGER bibliographic_metadata_http_attempts_no_delete
  BEFORE DELETE ON bibliographic_metadata_http_attempts
  FOR EACH ROW EXECUTE FUNCTION doi_lookup_reject_mutation();
CREATE TRIGGER bibliographic_metadata_http_attempts_lifecycle
  BEFORE UPDATE ON bibliographic_metadata_http_attempts
  FOR EACH ROW EXECUTE FUNCTION doi_lookup_attempt_lifecycle_guard();
CREATE TRIGGER doi_lookup_dispatch_consistency
  BEFORE INSERT ON doi_lookup_dispatches
  FOR EACH ROW EXECUTE FUNCTION doi_lookup_dispatch_consistency_guard();
CREATE TRIGGER doi_lookup_result_snapshot_consistency
  BEFORE INSERT ON bibliographic_metadata_fetch_results
  FOR EACH ROW EXECUTE FUNCTION doi_lookup_result_snapshot_guard();
CREATE TRIGGER doi_lookup_resolution_consistency
  BEFORE INSERT ON doi_lookup_resolutions
  FOR EACH ROW EXECUTE FUNCTION doi_lookup_resolution_consistency_guard();
