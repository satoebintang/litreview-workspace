CREATE TABLE "ai_extraction_decision_evidence" (
	"project_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"grounding_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"evidence_mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_extraction_decision_evidence_project_id_decision_id_grounding_id_pk" PRIMARY KEY("project_id","decision_id","grounding_id"),
	CONSTRAINT "ai_extraction_decision_evidence_project_decision_evidence_unique" UNIQUE("project_id","decision_id","evidence_id"),
	CONSTRAINT "ai_extraction_decision_evidence_mode_valid" CHECK ("ai_extraction_decision_evidence"."evidence_mode" in ('fresh', 'reused'))
);
--> statement-breakpoint
CREATE TABLE "ai_extraction_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"acceptance_mode" text,
	"expected_current_extraction_revision_id" uuid,
	"preceding_extraction_revision_id" uuid,
	"resulting_extraction_revision_id" uuid,
	"value_state" text,
	"text_value" text,
	"number_value" numeric(30, 10),
	"boolean_value" boolean,
	"option_id" uuid,
	"researcher_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_extraction_decisions_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "ai_extraction_decisions_project_request_unique" UNIQUE("project_id","request_id"),
	CONSTRAINT "ai_extraction_decisions_decision_valid" CHECK ("ai_extraction_decisions"."decision" in ('accepted', 'rejected')),
	CONSTRAINT "ai_extraction_decisions_acceptance_mode_valid" CHECK ("ai_extraction_decisions"."acceptance_mode" is null or "ai_extraction_decisions"."acceptance_mode" in ('accept', 'edit_and_accept')),
	CONSTRAINT "ai_extraction_decisions_state_valid" CHECK ("ai_extraction_decisions"."value_state" is null or "ai_extraction_decisions"."value_state" in ('present', 'not_reported', 'not_applicable', 'cleared')),
	CONSTRAINT "ai_extraction_decisions_decision_shape" CHECK ((
      ("ai_extraction_decisions"."decision" = 'rejected' and "ai_extraction_decisions"."acceptance_mode" is null and "ai_extraction_decisions"."resulting_extraction_revision_id" is null and "ai_extraction_decisions"."value_state" is null and "ai_extraction_decisions"."text_value" is null and "ai_extraction_decisions"."number_value" is null and "ai_extraction_decisions"."boolean_value" is null and "ai_extraction_decisions"."option_id" is null)
      or ("ai_extraction_decisions"."decision" = 'accepted' and "ai_extraction_decisions"."acceptance_mode" is not null and "ai_extraction_decisions"."resulting_extraction_revision_id" is not null and "ai_extraction_decisions"."value_state" is not null)
    )),
	CONSTRAINT "ai_extraction_decisions_note_bound" CHECK ("ai_extraction_decisions"."researcher_note" is null or (btrim("ai_extraction_decisions"."researcher_note") <> '' and char_length("ai_extraction_decisions"."researcher_note") <= 20000))
);
--> statement-breakpoint
CREATE TABLE "ai_extraction_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_extraction_dispatches_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "ai_extraction_dispatches_project_request_unique" UNIQUE("project_id","request_id"),
	CONSTRAINT "ai_extraction_dispatches_deadline_order" CHECK ("ai_extraction_dispatches"."deadline_at" > "ai_extraction_dispatches"."started_at")
);
--> statement-breakpoint
CREATE TABLE "ai_extraction_request_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"full_text_document_id" uuid NOT NULL,
	"document_text_extraction_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"page_ordinal" integer NOT NULL,
	"text_sha256" text NOT NULL,
	"character_count" integer NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_extraction_request_pages_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "ai_extraction_request_pages_request_page_unique" UNIQUE("project_id","request_id","page_number"),
	CONSTRAINT "ai_extraction_request_pages_request_ordinal_unique" UNIQUE("project_id","request_id","page_ordinal"),
	CONSTRAINT "ai_extraction_request_pages_page_number_valid" CHECK ("ai_extraction_request_pages"."page_number" > 0 and "ai_extraction_request_pages"."page_number" <= 2000),
	CONSTRAINT "ai_extraction_request_pages_ordinal_valid" CHECK ("ai_extraction_request_pages"."page_ordinal" >= 0 and "ai_extraction_request_pages"."page_ordinal" < 40),
	CONSTRAINT "ai_extraction_request_pages_hash_shape" CHECK ("ai_extraction_request_pages"."text_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ai_extraction_request_pages_count_bounds" CHECK ("ai_extraction_request_pages"."character_count" > 0 and "ai_extraction_request_pages"."character_count" <= 500000 and "ai_extraction_request_pages"."byte_size" > 0 and "ai_extraction_request_pages"."byte_size" <= 2000000)
);
--> statement-breakpoint
CREATE TABLE "ai_extraction_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"extraction_field_id" uuid NOT NULL,
	"full_text_document_id" uuid NOT NULL,
	"document_text_extraction_id" uuid NOT NULL,
	"baseline_extraction_revision_id" uuid,
	"idempotency_key" uuid NOT NULL,
	"intent_hash" text NOT NULL,
	"field_name_snapshot" text NOT NULL,
	"field_description_snapshot" text,
	"field_type" text NOT NULL,
	"option_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" text NOT NULL,
	"configured_model" text NOT NULL,
	"configured_reasoning_effort" text NOT NULL,
	"prompt_version" text NOT NULL,
	"response_schema_version" text NOT NULL,
	"grounding_resolver_version" text NOT NULL,
	"context_selection_version" text NOT NULL,
	"source_character_count" integer NOT NULL,
	"source_byte_size" integer NOT NULL,
	"page_manifest_hash" text NOT NULL,
	"external_transmission_acknowledged" boolean NOT NULL,
	"disclosure_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_extraction_requests_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "ai_extraction_requests_project_id_idempotency_key_unique" UNIQUE("project_id","idempotency_key"),
	CONSTRAINT "ai_extraction_requests_project_paper_field_id_unique" UNIQUE("project_id","paper_id","extraction_field_id","id"),
	CONSTRAINT "ai_extraction_requests_field_type_valid" CHECK ("ai_extraction_requests"."field_type" in ('short_text', 'long_text', 'number', 'boolean', 'single_select')),
	CONSTRAINT "ai_extraction_requests_provider_nonblank" CHECK (btrim("ai_extraction_requests"."provider") <> ''),
	CONSTRAINT "ai_extraction_requests_model_nonblank" CHECK (btrim("ai_extraction_requests"."configured_model") <> ''),
	CONSTRAINT "ai_extraction_requests_version_shape" CHECK (btrim("ai_extraction_requests"."prompt_version") <> '' and btrim("ai_extraction_requests"."response_schema_version") <> '' and btrim("ai_extraction_requests"."grounding_resolver_version") <> '' and btrim("ai_extraction_requests"."context_selection_version") <> ''),
	CONSTRAINT "ai_extraction_requests_hash_shape" CHECK ("ai_extraction_requests"."intent_hash" ~ '^[0-9a-f]{64}$' and "ai_extraction_requests"."page_manifest_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ai_extraction_requests_source_bounds" CHECK ("ai_extraction_requests"."source_character_count" >= 0 and "ai_extraction_requests"."source_character_count" <= 80000 and "ai_extraction_requests"."source_byte_size" >= 0 and "ai_extraction_requests"."source_byte_size" <= 327680),
	CONSTRAINT "ai_extraction_requests_transmission_acknowledged" CHECK ("ai_extraction_requests"."external_transmission_acknowledged" = true)
);
--> statement-breakpoint
CREATE TABLE "ai_extraction_result_groundings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"locator_quote" text NOT NULL,
	"locator_prefix" text,
	"locator_suffix" text,
	"source_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_extraction_result_groundings_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "ai_extraction_result_groundings_result_page_start_end_unique" UNIQUE("project_id","result_id","page_number","start_offset","end_offset"),
	CONSTRAINT "ai_extraction_result_groundings_page_positive" CHECK ("ai_extraction_result_groundings"."page_number" > 0),
	CONSTRAINT "ai_extraction_result_groundings_offset_shape" CHECK ("ai_extraction_result_groundings"."start_offset" >= 0 and "ai_extraction_result_groundings"."end_offset" > "ai_extraction_result_groundings"."start_offset" and "ai_extraction_result_groundings"."end_offset" - "ai_extraction_result_groundings"."start_offset" <= 4000),
	CONSTRAINT "ai_extraction_result_groundings_quote_nonblank" CHECK (btrim("ai_extraction_result_groundings"."locator_quote") <> '' and char_length("ai_extraction_result_groundings"."locator_quote") <= 4000),
	CONSTRAINT "ai_extraction_result_groundings_context_bounds" CHECK (("ai_extraction_result_groundings"."locator_prefix" is null or char_length("ai_extraction_result_groundings"."locator_prefix") <= 120) and ("ai_extraction_result_groundings"."locator_suffix" is null or char_length("ai_extraction_result_groundings"."locator_suffix") <= 120)),
	CONSTRAINT "ai_extraction_result_groundings_source_text_bound" CHECK (char_length("ai_extraction_result_groundings"."source_text") <= 4000)
);
--> statement-breakpoint
CREATE TABLE "ai_extraction_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"provider_diagnostic" text NOT NULL,
	"error_code" text,
	"candidate_state" text,
	"text_value" text,
	"number_value" numeric(30, 10),
	"boolean_value" boolean,
	"option_id" uuid,
	"explanation" text,
	"provider_request_id" text,
	"configured_model" text NOT NULL,
	"returned_model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_extraction_results_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "ai_extraction_results_project_request_unique" UNIQUE("project_id","request_id"),
	CONSTRAINT "ai_extraction_results_project_request_id_unique" UNIQUE("project_id","request_id","id"),
	CONSTRAINT "ai_extraction_results_outcome_valid" CHECK ("ai_extraction_results"."outcome" in ('succeeded', 'no_candidate', 'provider_unavailable', 'failed', 'invalid_output', 'unresolvable_grounding', 'outcome_unknown')),
	CONSTRAINT "ai_extraction_results_provider_diagnostic_valid" CHECK ("ai_extraction_results"."provider_diagnostic" in ('success', 'refusal', 'incomplete', 'schema_invalid', 'transport_error', 'api_error', 'unknown')),
	CONSTRAINT "ai_extraction_results_candidate_state_valid" CHECK ("ai_extraction_results"."candidate_state" is null or "ai_extraction_results"."candidate_state" in ('present', 'not_reported', 'not_applicable')),
	CONSTRAINT "ai_extraction_results_candidate_value_shape" CHECK ((
      ("ai_extraction_results"."candidate_state" is null and "ai_extraction_results"."text_value" is null and "ai_extraction_results"."number_value" is null and "ai_extraction_results"."boolean_value" is null and "ai_extraction_results"."option_id" is null)
      or ("ai_extraction_results"."candidate_state" <> 'present' and "ai_extraction_results"."text_value" is null and "ai_extraction_results"."number_value" is null and "ai_extraction_results"."boolean_value" is null and "ai_extraction_results"."option_id" is null)
      or ("ai_extraction_results"."candidate_state" = 'present' and (
        ("ai_extraction_results"."text_value" is not null and "ai_extraction_results"."number_value" is null and "ai_extraction_results"."boolean_value" is null and "ai_extraction_results"."option_id" is null)
        or ("ai_extraction_results"."text_value" is null and "ai_extraction_results"."number_value" is not null and "ai_extraction_results"."boolean_value" is null and "ai_extraction_results"."option_id" is null)
        or ("ai_extraction_results"."text_value" is null and "ai_extraction_results"."number_value" is null and "ai_extraction_results"."boolean_value" is not null and "ai_extraction_results"."option_id" is null)
        or ("ai_extraction_results"."text_value" is null and "ai_extraction_results"."number_value" is null and "ai_extraction_results"."boolean_value" is null and "ai_extraction_results"."option_id" is not null)
      ))
    )),
	CONSTRAINT "ai_extraction_results_terminal_shape" CHECK ("ai_extraction_results"."finalized_at" is not null),
	CONSTRAINT "ai_extraction_results_bounded_text" CHECK ("ai_extraction_results"."text_value" is null or char_length("ai_extraction_results"."text_value") <= 10000),
	CONSTRAINT "ai_extraction_results_bounded_explanation" CHECK ("ai_extraction_results"."explanation" is null or char_length("ai_extraction_results"."explanation") <= 10000),
	CONSTRAINT "ai_extraction_results_bounded_error" CHECK ("ai_extraction_results"."error_code" is null or (btrim("ai_extraction_results"."error_code") <> '' and char_length("ai_extraction_results"."error_code") <= 200)),
	CONSTRAINT "ai_extraction_results_usage_bounds" CHECK (("ai_extraction_results"."input_tokens" is null or "ai_extraction_results"."input_tokens" >= 0) and ("ai_extraction_results"."output_tokens" is null or "ai_extraction_results"."output_tokens" >= 0) and ("ai_extraction_results"."duration_ms" is null or "ai_extraction_results"."duration_ms" >= 0))
);
ALTER TABLE "ai_extraction_decision_evidence" ADD CONSTRAINT "ai_extraction_decision_evidence_decision_fk" FOREIGN KEY ("project_id","decision_id") REFERENCES "public"."ai_extraction_decisions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_decision_evidence" ADD CONSTRAINT "ai_extraction_decision_evidence_grounding_fk" FOREIGN KEY ("project_id","grounding_id") REFERENCES "public"."ai_extraction_result_groundings"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_decision_evidence" ADD CONSTRAINT "ai_extraction_decision_evidence_evidence_fk" FOREIGN KEY ("project_id","evidence_id") REFERENCES "public"."evidence"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_decisions" ADD CONSTRAINT "ai_extraction_decisions_request_fk" FOREIGN KEY ("project_id","request_id") REFERENCES "public"."ai_extraction_requests"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_decisions" ADD CONSTRAINT "ai_extraction_decisions_expected_revision_fk" FOREIGN KEY ("project_id","expected_current_extraction_revision_id") REFERENCES "public"."extraction_value_revisions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_decisions" ADD CONSTRAINT "ai_extraction_decisions_preceding_revision_fk" FOREIGN KEY ("project_id","preceding_extraction_revision_id") REFERENCES "public"."extraction_value_revisions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_decisions" ADD CONSTRAINT "ai_extraction_decisions_resulting_revision_fk" FOREIGN KEY ("project_id","resulting_extraction_revision_id") REFERENCES "public"."extraction_value_revisions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_decisions" ADD CONSTRAINT "ai_extraction_decisions_option_fk" FOREIGN KEY ("project_id","option_id") REFERENCES "public"."extraction_options"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_dispatches" ADD CONSTRAINT "ai_extraction_dispatches_request_fk" FOREIGN KEY ("project_id","request_id") REFERENCES "public"."ai_extraction_requests"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_request_pages" ADD CONSTRAINT "ai_extraction_request_pages_request_fk" FOREIGN KEY ("project_id","request_id") REFERENCES "public"."ai_extraction_requests"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_request_pages" ADD CONSTRAINT "ai_extraction_request_pages_source_page_fk" FOREIGN KEY ("project_id","paper_id","document_text_extraction_id","page_number") REFERENCES "public"."document_text_extraction_pages"("project_id","paper_id","document_text_extraction_id","page_number") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_request_pages" ADD CONSTRAINT "ai_extraction_request_pages_source_page_id_fk" FOREIGN KEY ("project_id","page_id") REFERENCES "public"."document_text_extraction_pages"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_requests" ADD CONSTRAINT "ai_extraction_requests_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_requests" ADD CONSTRAINT "ai_extraction_requests_paper_fk" FOREIGN KEY ("project_id","paper_id") REFERENCES "public"."papers"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_requests" ADD CONSTRAINT "ai_extraction_requests_field_fk" FOREIGN KEY ("project_id","extraction_field_id") REFERENCES "public"."extraction_fields"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_requests" ADD CONSTRAINT "ai_extraction_requests_document_fk" FOREIGN KEY ("project_id","paper_id","full_text_document_id") REFERENCES "public"."full_text_documents"("project_id","paper_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_requests" ADD CONSTRAINT "ai_extraction_requests_extraction_fk" FOREIGN KEY ("project_id","paper_id","document_text_extraction_id") REFERENCES "public"."document_text_extractions"("project_id","paper_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_requests" ADD CONSTRAINT "ai_extraction_requests_baseline_revision_fk" FOREIGN KEY ("project_id","baseline_extraction_revision_id") REFERENCES "public"."extraction_value_revisions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_result_groundings" ADD CONSTRAINT "ai_extraction_result_groundings_request_fk" FOREIGN KEY ("project_id","request_id") REFERENCES "public"."ai_extraction_requests"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_result_groundings" ADD CONSTRAINT "ai_extraction_result_groundings_result_fk" FOREIGN KEY ("project_id","request_id","result_id") REFERENCES "public"."ai_extraction_results"("project_id","request_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_result_groundings" ADD CONSTRAINT "ai_extraction_result_groundings_page_fk" FOREIGN KEY ("project_id","page_id") REFERENCES "public"."document_text_extraction_pages"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_results" ADD CONSTRAINT "ai_extraction_results_request_fk" FOREIGN KEY ("project_id","request_id") REFERENCES "public"."ai_extraction_requests"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_results" ADD CONSTRAINT "ai_extraction_results_option_fk" FOREIGN KEY ("project_id","option_id") REFERENCES "public"."extraction_options"("project_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- AI suggestion rows are immutable audit history. Expiry is represented by a
-- terminal result row, never by mutating a request or dispatch status.
CREATE OR REPLACE FUNCTION prevent_ai_extraction_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AI extraction suggestion history is append-only' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ai_extraction_requests_append_only
BEFORE UPDATE OR DELETE ON ai_extraction_requests
FOR EACH ROW EXECUTE FUNCTION prevent_ai_extraction_history_mutation();
--> statement-breakpoint
CREATE TRIGGER ai_extraction_request_pages_append_only
BEFORE UPDATE OR DELETE ON ai_extraction_request_pages
FOR EACH ROW EXECUTE FUNCTION prevent_ai_extraction_history_mutation();
--> statement-breakpoint
CREATE TRIGGER ai_extraction_dispatches_append_only
BEFORE UPDATE OR DELETE ON ai_extraction_dispatches
FOR EACH ROW EXECUTE FUNCTION prevent_ai_extraction_history_mutation();
--> statement-breakpoint
CREATE TRIGGER ai_extraction_results_append_only
BEFORE UPDATE OR DELETE ON ai_extraction_results
FOR EACH ROW EXECUTE FUNCTION prevent_ai_extraction_history_mutation();
--> statement-breakpoint
CREATE TRIGGER ai_extraction_result_groundings_append_only
BEFORE UPDATE OR DELETE ON ai_extraction_result_groundings
FOR EACH ROW EXECUTE FUNCTION prevent_ai_extraction_history_mutation();
--> statement-breakpoint
CREATE TRIGGER ai_extraction_decisions_append_only
BEFORE UPDATE OR DELETE ON ai_extraction_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_ai_extraction_history_mutation();
--> statement-breakpoint
CREATE TRIGGER ai_extraction_decision_evidence_append_only
BEFORE UPDATE OR DELETE ON ai_extraction_decision_evidence
FOR EACH ROW EXECUTE FUNCTION prevent_ai_extraction_history_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_ai_extraction_decision_context()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  request_paper_id uuid;
  request_field_id uuid;
  request_document_id uuid;
  request_extraction_id uuid;
  result_outcome text;
  request_field_type text;
  request_field_name text;
  request_field_description text;
  request_field_archived_at timestamptz;
  current_field_name text;
  current_field_description text;
  current_field_type text;
  request_document_archived_at timestamptz;
  request_extraction_status text;
  revision_paper_id uuid;
  revision_field_id uuid;
  revision_field_type text;
  revision_state text;
BEGIN
  SELECT paper_id, extraction_field_id, full_text_document_id, document_text_extraction_id
    INTO request_paper_id, request_field_id, request_document_id, request_extraction_id
  FROM ai_extraction_requests
  WHERE project_id = NEW.project_id AND id = NEW.request_id;
  IF NEW.decision = 'rejected' THEN
    IF NOT EXISTS (SELECT 1 FROM ai_extraction_results WHERE project_id = NEW.project_id AND request_id = NEW.request_id) THEN
      RAISE EXCEPTION 'AI rejection requires a terminal provider result' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT outcome INTO result_outcome
  FROM ai_extraction_results
  WHERE project_id = NEW.project_id AND request_id = NEW.request_id;
  IF result_outcome IS DISTINCT FROM 'succeeded' THEN
    RAISE EXCEPTION 'AI acceptance requires a successful provider result' USING ERRCODE = '23514';
  END IF;
  SELECT archived_at INTO request_document_archived_at
  FROM full_text_documents
  WHERE project_id = NEW.project_id AND paper_id = request_paper_id AND id = request_document_id;
  IF NOT FOUND OR request_document_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'AI acceptance requires an active frozen source document' USING ERRCODE = '23514';
  END IF;
  SELECT status INTO request_extraction_status
  FROM document_text_extractions
  WHERE project_id = NEW.project_id AND paper_id = request_paper_id AND id = request_extraction_id;
  IF NOT FOUND OR request_extraction_status NOT IN ('succeeded', 'partial') THEN
    RAISE EXCEPTION 'AI acceptance requires an eligible frozen text extraction' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM ai_extraction_request_pages request_page
    JOIN document_text_extraction_pages source_page
      ON source_page.project_id = request_page.project_id
     AND source_page.id = request_page.page_id
    WHERE request_page.project_id = NEW.project_id
      AND request_page.request_id = NEW.request_id
      AND (source_page.status <> 'succeeded' OR source_page.character_count <= 0 OR source_page.text IS NULL)
  ) THEN
    RAISE EXCEPTION 'AI acceptance requires successful frozen source pages' USING ERRCODE = '23514';
  END IF;
  SELECT field_type, field_name_snapshot, field_description_snapshot
    INTO request_field_type, request_field_name, request_field_description
  FROM ai_extraction_requests
  WHERE project_id = NEW.project_id AND id = NEW.request_id;
  SELECT name, description, field_type, archived_at
    INTO current_field_name, current_field_description, current_field_type, request_field_archived_at
  FROM extraction_fields
  WHERE project_id = NEW.project_id AND id = request_field_id;
  IF NOT FOUND OR request_field_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'AI acceptance requires an active frozen extraction field' USING ERRCODE = '23514';
  END IF;
  IF current_field_type IS DISTINCT FROM request_field_type THEN
    RAISE EXCEPTION 'AI acceptance field type does not match the frozen request' USING ERRCODE = '23514';
  END IF;
  IF current_field_name IS DISTINCT FROM request_field_name OR current_field_description IS DISTINCT FROM request_field_description THEN
    RAISE EXCEPTION 'AI acceptance field definition does not match the frozen request' USING ERRCODE = '23514';
  END IF;
  SELECT paper_id, field_id, field_type, value_state
    INTO revision_paper_id, revision_field_id, revision_field_type, revision_state
  FROM extraction_value_revisions
  WHERE project_id = NEW.project_id AND id = NEW.resulting_extraction_revision_id AND finalized_at IS NOT NULL;
  IF revision_paper_id IS DISTINCT FROM request_paper_id OR revision_field_id IS DISTINCT FROM request_field_id OR revision_field_type IS DISTINCT FROM request_field_type OR revision_state IS DISTINCT FROM NEW.value_state THEN
    RAISE EXCEPTION 'AI acceptance revision does not match the frozen request field' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ai_extraction_decisions_context_guard
BEFORE INSERT ON ai_extraction_decisions
FOR EACH ROW EXECUTE FUNCTION validate_ai_extraction_decision_context();
--> statement-breakpoint

-- Serialize unresolved requests on the same Paper lock used by the
-- application service. This protects direct SQL writers from racing the
-- one-unresolved-request-per-Paper/Field invariant.
CREATE OR REPLACE FUNCTION prevent_duplicate_unresolved_ai_extraction_request()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM papers WHERE project_id = NEW.project_id AND id = NEW.paper_id FOR UPDATE;
  IF EXISTS (
    SELECT 1
    FROM ai_extraction_requests r
    WHERE r.project_id = NEW.project_id
      AND r.paper_id = NEW.paper_id
      AND r.extraction_field_id = NEW.extraction_field_id
      AND NOT EXISTS (
        SELECT 1 FROM ai_extraction_results result
        WHERE result.project_id = r.project_id AND result.request_id = r.id
      )
  ) THEN
    RAISE EXCEPTION 'An unresolved AI extraction request already exists for this Paper and field' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ai_extraction_requests_unresolved_guard
BEFORE INSERT ON ai_extraction_requests
FOR EACH ROW EXECUTE FUNCTION prevent_duplicate_unresolved_ai_extraction_request();
--> statement-breakpoint

-- A frozen request page manifest must remain attached to the exact request
-- document and extraction identity. Composite foreign keys protect each
-- source row independently; this trigger protects the cross-row relationship.
CREATE OR REPLACE FUNCTION validate_ai_extraction_request_page_manifest()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  request_paper_id uuid;
  request_document_id uuid;
  request_extraction_id uuid;
  persisted_page_paper_id uuid;
  persisted_page_extraction_id uuid;
  persisted_page_status text;
  persisted_page_text text;
BEGIN
  SELECT paper_id, full_text_document_id, document_text_extraction_id
    INTO request_paper_id, request_document_id, request_extraction_id
  FROM ai_extraction_requests
  WHERE project_id = NEW.project_id AND id = NEW.request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI request page must reference an existing request' USING ERRCODE = '23503';
  END IF;
  IF NEW.paper_id IS DISTINCT FROM request_paper_id
    OR NEW.full_text_document_id IS DISTINCT FROM request_document_id
    OR NEW.document_text_extraction_id IS DISTINCT FROM request_extraction_id THEN
    RAISE EXCEPTION 'AI request page does not match the frozen request source identity' USING ERRCODE = '23514';
  END IF;
  SELECT paper_id, document_text_extraction_id, status, text
    INTO persisted_page_paper_id, persisted_page_extraction_id, persisted_page_status, persisted_page_text
  FROM document_text_extraction_pages
  WHERE project_id = NEW.project_id
    AND id = NEW.page_id
    AND page_number = NEW.page_number;
  IF persisted_page_paper_id IS DISTINCT FROM NEW.paper_id
    OR persisted_page_extraction_id IS DISTINCT FROM NEW.document_text_extraction_id
    OR persisted_page_status IS DISTINCT FROM 'succeeded'
    OR persisted_page_text IS NULL
    OR NEW.character_count IS DISTINCT FROM char_length(persisted_page_text)
    OR NEW.byte_size IS DISTINCT FROM octet_length(persisted_page_text)
    OR NEW.text_sha256 IS DISTINCT FROM encode(sha256(convert_to(persisted_page_text, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'AI request page manifest must describe the exact successful persisted page' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ai_extraction_request_pages_manifest_guard
BEFORE INSERT ON ai_extraction_request_pages
FOR EACH ROW EXECUTE FUNCTION validate_ai_extraction_request_page_manifest();
--> statement-breakpoint

-- Every canonical extraction revision, including direct SQL, participates in
-- the same Paper serialization used by the application writers.
CREATE OR REPLACE FUNCTION lock_paper_for_extraction_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM papers
  WHERE project_id = NEW.project_id AND id = NEW.paper_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Extraction revision Paper does not belong to the project' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER extraction_revisions_paper_serialization
BEFORE INSERT ON extraction_value_revisions
FOR EACH ROW EXECUTE FUNCTION lock_paper_for_extraction_revision();
--> statement-breakpoint

-- A request is finalized as one complete manifest, never as a relational
-- construction draft. The deferred check runs after all page rows in the
-- transaction have been inserted.
CREATE OR REPLACE FUNCTION validate_ai_extraction_request_manifest_complete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  page_count integer;
  minimum_ordinal integer;
  maximum_ordinal integer;
  target_request_id uuid;
  request_character_count integer;
  request_byte_size integer;
  manifest_character_count integer;
  manifest_byte_size integer;
BEGIN
  target_request_id := CASE WHEN TG_TABLE_NAME = 'ai_extraction_requests' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'request_id')::uuid END;
  SELECT count(*)::integer, min(page_ordinal), max(page_ordinal)
    INTO page_count, minimum_ordinal, maximum_ordinal
  FROM ai_extraction_request_pages
  WHERE project_id = NEW.project_id AND request_id = target_request_id;
  IF page_count <= 0 OR page_count > 40 OR minimum_ordinal IS DISTINCT FROM 0 OR maximum_ordinal IS DISTINCT FROM page_count - 1 THEN
    RAISE EXCEPTION 'AI extraction request must commit a complete non-empty page manifest' USING ERRCODE = '23514';
  END IF;
  SELECT source_character_count, source_byte_size
    INTO request_character_count, request_byte_size
  FROM ai_extraction_requests
  WHERE project_id = NEW.project_id AND id = target_request_id;
  SELECT coalesce(sum(character_count), 0)::integer,
         (coalesce(sum(byte_size), 0) + greatest(page_count - 1, 0))::integer
    INTO manifest_character_count, manifest_byte_size
  FROM ai_extraction_request_pages
  WHERE project_id = NEW.project_id AND request_id = target_request_id;
  IF request_character_count IS DISTINCT FROM manifest_character_count
    OR request_byte_size IS DISTINCT FROM manifest_byte_size THEN
    RAISE EXCEPTION 'AI extraction request source totals must equal the persisted page manifest' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ai_extraction_requests_manifest_complete
AFTER INSERT ON ai_extraction_requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_ai_extraction_request_manifest_complete();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ai_extraction_request_pages_manifest_complete
AFTER INSERT ON ai_extraction_request_pages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_ai_extraction_request_manifest_complete();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_ai_extraction_request_source_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  document_archived_at timestamptz;
  extraction_document_id uuid;
  extraction_status text;
  field_type_snapshot text;
  field_name_snapshot text;
  field_description_snapshot text;
  current_option_snapshot jsonb;
  field_archived_at timestamptz;
  baseline_paper_id uuid;
  baseline_field_id uuid;
  baseline_finalized_at timestamptz;
BEGIN
  SELECT archived_at INTO document_archived_at
  FROM full_text_documents
  WHERE project_id = NEW.project_id AND paper_id = NEW.paper_id AND id = NEW.full_text_document_id;
  IF NOT FOUND OR document_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'AI request requires a non-archived source document' USING ERRCODE = '23514';
  END IF;
  SELECT full_text_document_id, status INTO extraction_document_id, extraction_status
  FROM document_text_extractions
  WHERE project_id = NEW.project_id AND paper_id = NEW.paper_id AND id = NEW.document_text_extraction_id;
  IF NOT FOUND OR extraction_document_id IS DISTINCT FROM NEW.full_text_document_id OR extraction_status NOT IN ('succeeded', 'partial') THEN
    RAISE EXCEPTION 'AI request source extraction does not match the frozen document or is ineligible' USING ERRCODE = '23514';
  END IF;
  SELECT field_type, name, description, archived_at
    INTO field_type_snapshot, field_name_snapshot, field_description_snapshot, field_archived_at
  FROM extraction_fields
  WHERE project_id = NEW.project_id AND id = NEW.extraction_field_id;
  IF NOT FOUND OR field_archived_at IS NOT NULL OR field_type_snapshot IS DISTINCT FROM NEW.field_type OR field_name_snapshot IS DISTINCT FROM NEW.field_name_snapshot OR field_description_snapshot IS DISTINCT FROM NEW.field_description_snapshot THEN
    RAISE EXCEPTION 'AI request field snapshot does not match an active field' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'label', label, 'sortOrder', sort_order) ORDER BY sort_order, id), '[]'::jsonb)
    INTO current_option_snapshot
  FROM extraction_options
  WHERE project_id = NEW.project_id AND field_id = NEW.extraction_field_id AND archived_at IS NULL;
  IF NEW.option_snapshot IS DISTINCT FROM current_option_snapshot THEN
    RAISE EXCEPTION 'AI request option snapshot does not match the active field options' USING ERRCODE = '23514';
  END IF;
  IF NEW.baseline_extraction_revision_id IS NOT NULL THEN
    SELECT paper_id, field_id, finalized_at INTO baseline_paper_id, baseline_field_id, baseline_finalized_at
    FROM extraction_value_revisions
    WHERE project_id = NEW.project_id AND id = NEW.baseline_extraction_revision_id;
    IF NOT FOUND OR baseline_paper_id IS DISTINCT FROM NEW.paper_id OR baseline_field_id IS DISTINCT FROM NEW.extraction_field_id OR baseline_finalized_at IS NULL THEN
      RAISE EXCEPTION 'AI request baseline must be the finalized revision for the frozen Paper and field' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ai_extraction_requests_source_identity_guard
BEFORE INSERT ON ai_extraction_requests
FOR EACH ROW EXECUTE FUNCTION validate_ai_extraction_request_source_identity();
--> statement-breakpoint

-- Grounding source_text is independently derived from the immutable persisted
-- extraction page. The provider quote is retained only as a locator audit
-- field; it can never become canonical Evidence text by itself.
CREATE OR REPLACE FUNCTION validate_ai_extraction_grounding_source()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  persisted_page_text text;
  derived_text text;
BEGIN
  SELECT page.text INTO persisted_page_text
  FROM document_text_extraction_pages page
  WHERE page.project_id = NEW.project_id
    AND page.id = NEW.page_id
    AND page.page_number = NEW.page_number;
  IF persisted_page_text IS NULL THEN
    RAISE EXCEPTION 'AI grounding page is not an exact persisted extraction page' USING ERRCODE = '23514';
  END IF;
  IF NEW.start_offset < 0 OR NEW.end_offset > char_length(persisted_page_text) THEN
    RAISE EXCEPTION 'AI grounding offsets must remain within the persisted page' USING ERRCODE = '23514';
  END IF;
  derived_text := substring(persisted_page_text from NEW.start_offset + 1 for NEW.end_offset - NEW.start_offset);
  IF derived_text <> NEW.source_text OR derived_text <> NEW.locator_quote THEN
    RAISE EXCEPTION 'AI grounding source text must equal the persisted page substring' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ai_extraction_request_pages request_page
    WHERE request_page.project_id = NEW.project_id
      AND request_page.request_id = NEW.request_id
      AND request_page.page_id = NEW.page_id
      AND request_page.page_number = NEW.page_number
  ) THEN
    RAISE EXCEPTION 'AI grounding page is not part of the frozen request manifest' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ai_extraction_result_groundings_source_guard
BEFORE INSERT ON ai_extraction_result_groundings
FOR EACH ROW EXECUTE FUNCTION validate_ai_extraction_grounding_source();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_ai_extraction_result_complete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_result_id uuid;
  result_outcome text;
  result_state text;
  result_request_id uuid;
  request_model text;
  result_model text;
  grounding_count integer;
  grounding_code_points integer;
BEGIN
  target_result_id := CASE WHEN TG_TABLE_NAME = 'ai_extraction_results' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'result_id')::uuid END;
  SELECT outcome, candidate_state, request_id, configured_model
    INTO result_outcome, result_state, result_request_id, result_model
  FROM ai_extraction_results
  WHERE project_id = NEW.project_id AND id = target_result_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI grounding requires an existing terminal result' USING ERRCODE = '23503';
  END IF;
  SELECT configured_model INTO request_model
  FROM ai_extraction_requests
  WHERE project_id = NEW.project_id AND id = result_request_id;
  IF request_model IS DISTINCT FROM result_model THEN
    RAISE EXCEPTION 'AI result metadata does not match the finalized request' USING ERRCODE = '23514';
  END IF;
  SELECT count(*)::integer, coalesce(sum(end_offset - start_offset), 0)::integer
    INTO grounding_count, grounding_code_points
  FROM ai_extraction_result_groundings
  WHERE project_id = NEW.project_id AND result_id = target_result_id;
  IF grounding_count > 8 OR grounding_code_points > 16000 THEN
    RAISE EXCEPTION 'AI result grounding limits were exceeded' USING ERRCODE = '23514';
  END IF;
  IF result_outcome = 'succeeded' THEN
    IF result_state IS NULL OR grounding_count = 0 THEN
      RAISE EXCEPTION 'A succeeded AI result requires a candidate and exact grounding' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF result_state IS NOT NULL OR grounding_count > 0 THEN
      RAISE EXCEPTION 'Only a succeeded AI result may contain a candidate and grounding rows' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ai_extraction_results_complete
AFTER INSERT ON ai_extraction_results
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_ai_extraction_result_complete();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ai_extraction_result_groundings_complete
AFTER INSERT ON ai_extraction_result_groundings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_ai_extraction_result_complete();
--> statement-breakpoint

-- A decision-to-Evidence link is valid only when it joins the same request's
-- grounding and the exact canonical Evidence span. This keeps direct SQL from
-- bypassing the acceptance service's provenance checks.
CREATE OR REPLACE FUNCTION validate_ai_extraction_decision_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  decision_request_id uuid;
  grounding_request_id uuid;
  grounding_page_id uuid;
  grounding_page_number integer;
  grounding_start integer;
  grounding_end integer;
  grounding_source text;
  decision_paper_id uuid;
  decision_document_id uuid;
  decision_extraction_id uuid;
BEGIN
  SELECT request_id INTO decision_request_id
  FROM ai_extraction_decisions
  WHERE project_id = NEW.project_id AND id = NEW.decision_id;
  SELECT request_id, page_id, page_number, start_offset, end_offset, source_text
    INTO grounding_request_id, grounding_page_id, grounding_page_number, grounding_start, grounding_end, grounding_source
  FROM ai_extraction_result_groundings
  WHERE project_id = NEW.project_id AND id = NEW.grounding_id;
  IF decision_request_id IS NULL OR grounding_request_id IS NULL OR decision_request_id IS DISTINCT FROM grounding_request_id THEN
    RAISE EXCEPTION 'AI decision Evidence must reference a grounding from the same request' USING ERRCODE = '23514';
  END IF;
  SELECT paper_id, full_text_document_id, document_text_extraction_id
    INTO decision_paper_id, decision_document_id, decision_extraction_id
  FROM ai_extraction_requests
  WHERE project_id = NEW.project_id AND id = decision_request_id;
  IF NOT EXISTS (
    SELECT 1
    FROM evidence e
    WHERE e.project_id = NEW.project_id
      AND e.id = NEW.evidence_id
      AND e.paper_id = decision_paper_id
      AND e.full_text_document_id = decision_document_id
      AND e.document_text_extraction_id = decision_extraction_id
      AND e.page_number = grounding_page_number
      AND e.extraction_start_offset = grounding_start
      AND e.extraction_end_offset = grounding_end
      AND e.source_text = grounding_source
  ) THEN
    RAISE EXCEPTION 'AI decision Evidence must preserve the exact grounding provenance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ai_extraction_decision_evidence_provenance_guard
BEFORE INSERT ON ai_extraction_decision_evidence
FOR EACH ROW EXECUTE FUNCTION validate_ai_extraction_decision_evidence();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_ai_extraction_decision_complete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_decision_id uuid;
  decision_kind text;
  acceptance_kind text;
  request_id_value uuid;
  request_baseline_id uuid;
  request_paper_id uuid;
  request_field_id uuid;
  expected_revision_id uuid;
  request_field_type text;
  request_option_snapshot jsonb;
  preceding_revision_id uuid;
  resulting_revision_id uuid;
  resulting_sequence bigint;
  preceding_current_id uuid;
  decision_state text;
  revision_paper_id uuid;
  revision_field_id uuid;
  revision_field_type text;
  revision_state text;
  revision_text text;
  revision_number numeric(30,10);
  revision_boolean boolean;
  revision_option_id uuid;
  selected_option_label text;
  selected_option_archived_at timestamptz;
  frozen_option_label text;
  mapping_count integer;
  support_count integer;
BEGIN
  target_decision_id := CASE WHEN TG_TABLE_NAME = 'ai_extraction_decisions' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'decision_id')::uuid END;
  SELECT decision, acceptance_mode, request_id, expected_current_extraction_revision_id,
         preceding_extraction_revision_id, resulting_extraction_revision_id, value_state,
         text_value, number_value, boolean_value, option_id
    INTO decision_kind, acceptance_kind, request_id_value, expected_revision_id,
         preceding_revision_id, resulting_revision_id, decision_state,
         revision_text, revision_number, revision_boolean, revision_option_id
  FROM ai_extraction_decisions
  WHERE project_id = NEW.project_id AND id = target_decision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI decision mapping requires an existing decision' USING ERRCODE = '23503';
  END IF;
  SELECT paper_id, extraction_field_id, baseline_extraction_revision_id, field_type, option_snapshot
    INTO request_paper_id, request_field_id, request_baseline_id, request_field_type, request_option_snapshot
  FROM ai_extraction_requests
  WHERE project_id = NEW.project_id AND id = request_id_value;
  IF decision_kind = 'rejected' THEN
    IF EXISTS (SELECT 1 FROM ai_extraction_decision_evidence WHERE project_id = NEW.project_id AND decision_id = target_decision_id) THEN
      RAISE EXCEPTION 'Rejected AI decisions cannot have Evidence mappings' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF expected_revision_id IS DISTINCT FROM request_baseline_id OR preceding_revision_id IS DISTINCT FROM expected_revision_id THEN
    RAISE EXCEPTION 'AI decision baseline does not match the frozen request identity' USING ERRCODE = '23514';
  END IF;
  SELECT r.paper_id, r.field_id, r.field_type, r.value_state, r.text_value, r.number_value, r.boolean_value, r.option_id
    INTO revision_paper_id, revision_field_id, revision_field_type, revision_state, revision_text, revision_number, revision_boolean, revision_option_id
  FROM extraction_value_revisions r
  WHERE r.project_id = NEW.project_id AND r.id = resulting_revision_id AND r.finalized_at IS NOT NULL;
  IF NOT FOUND OR revision_paper_id IS DISTINCT FROM request_paper_id OR revision_field_id IS DISTINCT FROM request_field_id OR revision_field_type IS DISTINCT FROM request_field_type OR revision_state IS DISTINCT FROM decision_state THEN
    RAISE EXCEPTION 'AI decision revision does not match the frozen request field' USING ERRCODE = '23514';
  END IF;
  IF revision_option_id IS NOT NULL THEN
    SELECT label, archived_at
      INTO selected_option_label, selected_option_archived_at
    FROM extraction_options
    WHERE project_id = NEW.project_id AND field_id = request_field_id AND id = revision_option_id;
    SELECT option_snapshot_item->>'label'
      INTO frozen_option_label
    FROM jsonb_array_elements(request_option_snapshot) AS option_snapshot_item
    WHERE option_snapshot_item->>'id' = revision_option_id::text
    LIMIT 1;
    IF NOT FOUND OR selected_option_archived_at IS NOT NULL OR frozen_option_label IS NULL OR selected_option_label IS DISTINCT FROM frozen_option_label THEN
      RAISE EXCEPTION 'AI decision option does not match the frozen active option definition' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT sequence INTO resulting_sequence
  FROM extraction_value_revisions
  WHERE project_id = NEW.project_id AND id = resulting_revision_id;
  SELECT r.id INTO preceding_current_id
  FROM extraction_value_revisions r
  WHERE r.project_id = NEW.project_id
    AND r.paper_id = request_paper_id
    AND r.field_id = request_field_id
    AND r.finalized_at IS NOT NULL
    AND r.sequence < resulting_sequence
  ORDER BY r.sequence DESC
  LIMIT 1;
  IF preceding_current_id IS DISTINCT FROM expected_revision_id THEN
    RAISE EXCEPTION 'AI decision baseline is not the serialized predecessor of the resulting revision' USING ERRCODE = '23514';
  END IF;
  IF revision_text IS DISTINCT FROM (SELECT text_value FROM ai_extraction_decisions WHERE project_id = NEW.project_id AND id = target_decision_id)
    OR revision_number IS DISTINCT FROM (SELECT number_value FROM ai_extraction_decisions WHERE project_id = NEW.project_id AND id = target_decision_id)
    OR revision_boolean IS DISTINCT FROM (SELECT boolean_value FROM ai_extraction_decisions WHERE project_id = NEW.project_id AND id = target_decision_id)
    OR revision_option_id IS DISTINCT FROM (SELECT option_id FROM ai_extraction_decisions WHERE project_id = NEW.project_id AND id = target_decision_id) THEN
    RAISE EXCEPTION 'AI decision value snapshot does not match the resulting canonical revision' USING ERRCODE = '23514';
  END IF;
  SELECT count(*)::integer INTO mapping_count
  FROM ai_extraction_decision_evidence
  WHERE project_id = NEW.project_id AND decision_id = target_decision_id;
  SELECT count(*)::integer INTO support_count
  FROM extraction_revision_evidence
  WHERE project_id = NEW.project_id AND revision_id = resulting_revision_id;
  IF mapping_count <> support_count
    OR EXISTS (
      SELECT 1 FROM ai_extraction_decision_evidence m
      LEFT JOIN extraction_revision_evidence s
        ON s.project_id = m.project_id AND s.revision_id = resulting_revision_id AND s.evidence_id = m.evidence_id
      WHERE m.project_id = NEW.project_id AND m.decision_id = target_decision_id AND s.evidence_id IS NULL
    )
    OR EXISTS (
      SELECT 1 FROM extraction_revision_evidence s
      LEFT JOIN ai_extraction_decision_evidence m
        ON m.project_id = s.project_id AND m.decision_id = target_decision_id AND m.evidence_id = s.evidence_id
      WHERE s.project_id = NEW.project_id AND s.revision_id = resulting_revision_id AND m.evidence_id IS NULL
    ) THEN
    RAISE EXCEPTION 'AI decision Evidence mappings must equal the canonical revision support set' USING ERRCODE = '23514';
  END IF;
  IF decision_state IN ('present', 'not_reported', 'not_applicable') AND mapping_count = 0 THEN
    RAISE EXCEPTION 'A non-cleared AI decision requires exact Evidence grounding' USING ERRCODE = '23514';
  END IF;
  IF decision_state = 'cleared' AND (acceptance_kind IS DISTINCT FROM 'edit_and_accept' OR mapping_count <> 0) THEN
    RAISE EXCEPTION 'Only an explicit edit may clear an AI extraction and cleared decisions cannot have Evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ai_extraction_decisions_complete
AFTER INSERT ON ai_extraction_decisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_ai_extraction_decision_complete();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ai_extraction_decision_evidence_complete
AFTER INSERT ON ai_extraction_decision_evidence
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_ai_extraction_decision_complete();
