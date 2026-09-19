CREATE TABLE "ai_synthesis_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"acceptance_mode" text,
	"expected_current_target_revision_id" uuid,
	"resulting_synthesis_revision_id" uuid,
	"title" text,
	"statement_text" text,
	"researcher_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_synthesis_decisions_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "ai_synthesis_decisions_project_request_unique" UNIQUE("project_id","request_id"),
	CONSTRAINT "ai_synthesis_decisions_decision_valid" CHECK ("ai_synthesis_decisions"."decision" in ('rejected', 'accepted')),
	CONSTRAINT "ai_synthesis_decisions_acceptance_mode_valid" CHECK ("ai_synthesis_decisions"."acceptance_mode" is null or "ai_synthesis_decisions"."acceptance_mode" in ('accept', 'edit_and_accept')),
	CONSTRAINT "ai_synthesis_decisions_decision_shape" CHECK ((
      ("ai_synthesis_decisions"."decision" = 'rejected' and "ai_synthesis_decisions"."acceptance_mode" is null and "ai_synthesis_decisions"."resulting_synthesis_revision_id" is null and "ai_synthesis_decisions"."title" is null and "ai_synthesis_decisions"."statement_text" is null and "ai_synthesis_decisions"."researcher_note" is null)
      or ("ai_synthesis_decisions"."decision" = 'accepted' and "ai_synthesis_decisions"."acceptance_mode" is not null and "ai_synthesis_decisions"."resulting_synthesis_revision_id" is not null and "ai_synthesis_decisions"."statement_text" is not null and btrim("ai_synthesis_decisions"."statement_text") <> '')
    )),
	CONSTRAINT "ai_synthesis_decisions_title_bound" CHECK ("ai_synthesis_decisions"."title" is null or (btrim("ai_synthesis_decisions"."title") <> '' and char_length("ai_synthesis_decisions"."title") <= 500)),
	CONSTRAINT "ai_synthesis_decisions_statement_bound" CHECK (char_length("ai_synthesis_decisions"."statement_text") <= 10000),
	CONSTRAINT "ai_synthesis_decisions_note_bound" CHECK ("ai_synthesis_decisions"."researcher_note" is null or (btrim("ai_synthesis_decisions"."researcher_note") <> '' and char_length("ai_synthesis_decisions"."researcher_note") <= 10000))
);
--> statement-breakpoint
CREATE TABLE "ai_synthesis_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_synthesis_dispatches_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "ai_synthesis_dispatches_project_request_unique" UNIQUE("project_id","request_id"),
	CONSTRAINT "ai_synthesis_dispatches_deadline_order" CHECK ("ai_synthesis_dispatches"."deadline_at" > "ai_synthesis_dispatches"."started_at")
);
--> statement-breakpoint
CREATE TABLE "ai_synthesis_request_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"extraction_revision_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"source_ordinal" integer NOT NULL,
	"membership_id" uuid NOT NULL,
	"membership_sort_order" integer NOT NULL,
	"page_number" integer NOT NULL,
	"source_text" text NOT NULL,
	"source_text_sha256" text NOT NULL,
	"source_character_count" integer NOT NULL,
	"source_byte_size" integer NOT NULL,
	"evidence_review_state" text NOT NULL,
	"evidence_note_snapshot" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_synthesis_request_sources_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "ai_synthesis_request_sources_project_request_revision_evidence_unique" UNIQUE("project_id","request_id","extraction_revision_id","evidence_id"),
	CONSTRAINT "ai_synthesis_request_sources_project_request_revision_ordinal_unique" UNIQUE("project_id","request_id","extraction_revision_id","source_ordinal"),
	CONSTRAINT "ai_synthesis_request_sources_ordinal_valid" CHECK ("ai_synthesis_request_sources"."source_ordinal" >= 0 and "ai_synthesis_request_sources"."source_ordinal" < 8),
	CONSTRAINT "ai_synthesis_request_sources_membership_order_valid" CHECK ("ai_synthesis_request_sources"."membership_sort_order" > 0),
	CONSTRAINT "ai_synthesis_request_sources_page_positive" CHECK ("ai_synthesis_request_sources"."page_number" > 0),
	CONSTRAINT "ai_synthesis_request_sources_text_bound" CHECK (btrim("ai_synthesis_request_sources"."source_text") <> '' and char_length("ai_synthesis_request_sources"."source_text") <= 4000),
	CONSTRAINT "ai_synthesis_request_sources_hash_shape" CHECK ("ai_synthesis_request_sources"."source_text_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ai_synthesis_request_sources_count_shape" CHECK ("ai_synthesis_request_sources"."source_character_count" = char_length("ai_synthesis_request_sources"."source_text") and "ai_synthesis_request_sources"."source_character_count" > 0 and "ai_synthesis_request_sources"."source_character_count" <= 4000 and "ai_synthesis_request_sources"."source_byte_size" > 0 and "ai_synthesis_request_sources"."source_byte_size" <= 163840),
	CONSTRAINT "ai_synthesis_request_sources_review_state_valid" CHECK ("ai_synthesis_request_sources"."evidence_review_state" in ('unreviewed', 'needs_review', 'accepted', 'rejected')),
	CONSTRAINT "ai_synthesis_request_sources_note_bound" CHECK ("ai_synthesis_request_sources"."evidence_note_snapshot" is null or char_length("ai_synthesis_request_sources"."evidence_note_snapshot") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "ai_synthesis_request_supports" (
	"project_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"extraction_revision_id" uuid NOT NULL,
	"support_ordinal" integer NOT NULL,
	"paper_id" uuid NOT NULL,
	"extraction_field_id" uuid NOT NULL,
	"extraction_value_id" uuid NOT NULL,
	"field_type" text NOT NULL,
	"value_state" text NOT NULL,
	"text_value" text,
	"number_value" numeric(30, 10),
	"boolean_value" boolean,
	"option_id" uuid,
	"option_label_snapshot" text,
	"researcher_note" text,
	"paper_title_snapshot" text NOT NULL,
	"paper_publication_year_snapshot" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_synthesis_request_supports_project_id_request_id_extraction_revision_id_pk" PRIMARY KEY("project_id","request_id","extraction_revision_id"),
	CONSTRAINT "ai_synthesis_request_supports_project_request_ordinal_unique" UNIQUE("project_id","request_id","support_ordinal"),
	CONSTRAINT "ai_synthesis_request_supports_field_type_valid" CHECK ("ai_synthesis_request_supports"."field_type" in ('short_text', 'long_text', 'number', 'boolean', 'single_select')),
	CONSTRAINT "ai_synthesis_request_supports_value_state_valid" CHECK ("ai_synthesis_request_supports"."value_state" in ('present', 'not_reported', 'not_applicable', 'cleared')),
	CONSTRAINT "ai_synthesis_request_supports_value_shape" CHECK ((
      ("ai_synthesis_request_supports"."value_state" <> 'present' and "ai_synthesis_request_supports"."text_value" is null and "ai_synthesis_request_supports"."number_value" is null and "ai_synthesis_request_supports"."boolean_value" is null and "ai_synthesis_request_supports"."option_id" is null and "ai_synthesis_request_supports"."option_label_snapshot" is null)
      or ("ai_synthesis_request_supports"."value_state" = 'present' and (
        ("ai_synthesis_request_supports"."field_type" in ('short_text', 'long_text') and "ai_synthesis_request_supports"."text_value" is not null and "ai_synthesis_request_supports"."number_value" is null and "ai_synthesis_request_supports"."boolean_value" is null and "ai_synthesis_request_supports"."option_id" is null and "ai_synthesis_request_supports"."option_label_snapshot" is null)
        or ("ai_synthesis_request_supports"."field_type" = 'number' and "ai_synthesis_request_supports"."text_value" is null and "ai_synthesis_request_supports"."number_value" is not null and "ai_synthesis_request_supports"."boolean_value" is null and "ai_synthesis_request_supports"."option_id" is null and "ai_synthesis_request_supports"."option_label_snapshot" is null)
        or ("ai_synthesis_request_supports"."field_type" = 'boolean' and "ai_synthesis_request_supports"."text_value" is null and "ai_synthesis_request_supports"."number_value" is null and "ai_synthesis_request_supports"."boolean_value" is not null and "ai_synthesis_request_supports"."option_id" is null and "ai_synthesis_request_supports"."option_label_snapshot" is null)
        or ("ai_synthesis_request_supports"."field_type" = 'single_select' and "ai_synthesis_request_supports"."text_value" is null and "ai_synthesis_request_supports"."number_value" is null and "ai_synthesis_request_supports"."boolean_value" is null and "ai_synthesis_request_supports"."option_id" is not null and "ai_synthesis_request_supports"."option_label_snapshot" is not null)
      ))
    )),
	CONSTRAINT "ai_synthesis_request_supports_ordinal_valid" CHECK ("ai_synthesis_request_supports"."support_ordinal" >= 0 and "ai_synthesis_request_supports"."support_ordinal" < 20),
	CONSTRAINT "ai_synthesis_request_supports_note_bound" CHECK ("ai_synthesis_request_supports"."researcher_note" is null or char_length("ai_synthesis_request_supports"."researcher_note") <= 10000),
	CONSTRAINT "ai_synthesis_request_supports_paper_title_bound" CHECK (char_length("ai_synthesis_request_supports"."paper_title_snapshot") between 1 and 1000),
	CONSTRAINT "ai_synthesis_request_supports_publication_year_valid" CHECK ("ai_synthesis_request_supports"."paper_publication_year_snapshot" is null or ("ai_synthesis_request_supports"."paper_publication_year_snapshot" between 1000 and 3000))
);
--> statement-breakpoint
CREATE TABLE "ai_synthesis_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"project_title_snapshot" text NOT NULL,
	"preparation_id" uuid NOT NULL,
	"evidence_set_id" uuid NOT NULL,
	"evidence_set_composition_revision_id" uuid NOT NULL,
	"extraction_field_id" uuid NOT NULL,
	"target_synthesis_statement_id" uuid,
	"target_baseline_synthesis_revision_id" uuid,
	"target_title_snapshot" text,
	"target_statement_text_snapshot" text,
	"idempotency_key" uuid NOT NULL,
	"source_state_hash" text NOT NULL,
	"intent_hash" text NOT NULL,
	"field_name_snapshot" text NOT NULL,
	"field_description_snapshot" text,
	"field_type" text NOT NULL,
	"provider" text NOT NULL,
	"configured_model" text NOT NULL,
	"configured_reasoning_effort" text NOT NULL,
	"prompt_version" text NOT NULL,
	"response_schema_version" text NOT NULL,
	"grounding_resolver_version" text NOT NULL,
	"context_selection_version" text NOT NULL,
	"source_coverage_state" text DEFAULT 'complete' NOT NULL,
	"support_count" integer NOT NULL,
	"source_count" integer NOT NULL,
	"source_character_count" integer NOT NULL,
	"source_byte_size" integer NOT NULL,
	"source_manifest_hash" text NOT NULL,
	"external_transmission_acknowledged" boolean NOT NULL,
	"disclosure_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undispatched_expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_synthesis_requests_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "ai_synthesis_requests_project_idempotency_key_unique" UNIQUE("project_id","idempotency_key"),
	CONSTRAINT "ai_synthesis_requests_field_type_valid" CHECK ("ai_synthesis_requests"."field_type" in ('short_text', 'long_text', 'number', 'boolean', 'single_select')),
	CONSTRAINT "ai_synthesis_requests_source_coverage_valid" CHECK ("ai_synthesis_requests"."source_coverage_state" = 'complete'),
	CONSTRAINT "ai_synthesis_requests_count_bounds" CHECK ("ai_synthesis_requests"."support_count" >= 1 and "ai_synthesis_requests"."support_count" <= 20 and "ai_synthesis_requests"."source_count" >= 1 and "ai_synthesis_requests"."source_count" <= 80),
	CONSTRAINT "ai_synthesis_requests_source_bounds" CHECK ("ai_synthesis_requests"."source_character_count" >= 1 and "ai_synthesis_requests"."source_character_count" <= 80000 and "ai_synthesis_requests"."source_byte_size" >= 1 and "ai_synthesis_requests"."source_byte_size" <= 327680),
	CONSTRAINT "ai_synthesis_requests_hash_shape" CHECK ("ai_synthesis_requests"."source_state_hash" ~ '^[0-9a-f]{64}$' and "ai_synthesis_requests"."intent_hash" ~ '^[0-9a-f]{64}$' and "ai_synthesis_requests"."source_manifest_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ai_synthesis_requests_text_bounds" CHECK (char_length("ai_synthesis_requests"."project_title_snapshot") between 1 and 500 and char_length("ai_synthesis_requests"."field_name_snapshot") between 1 and 500 and ("ai_synthesis_requests"."field_description_snapshot" is null or char_length("ai_synthesis_requests"."field_description_snapshot") <= 2000) and ("ai_synthesis_requests"."target_title_snapshot" is null or char_length("ai_synthesis_requests"."target_title_snapshot") <= 500) and ("ai_synthesis_requests"."target_statement_text_snapshot" is null or char_length("ai_synthesis_requests"."target_statement_text_snapshot") <= 10000)),
	CONSTRAINT "ai_synthesis_requests_config_nonblank" CHECK (btrim("ai_synthesis_requests"."provider") <> '' and char_length("ai_synthesis_requests"."provider") <= 100 and btrim("ai_synthesis_requests"."configured_model") <> '' and char_length("ai_synthesis_requests"."configured_model") <= 200 and btrim("ai_synthesis_requests"."configured_reasoning_effort") <> ''),
	CONSTRAINT "ai_synthesis_requests_versions_shape" CHECK (btrim("ai_synthesis_requests"."prompt_version") <> '' and char_length("ai_synthesis_requests"."prompt_version") <= 100 and btrim("ai_synthesis_requests"."response_schema_version") <> '' and char_length("ai_synthesis_requests"."response_schema_version") <= 100 and btrim("ai_synthesis_requests"."grounding_resolver_version") <> '' and char_length("ai_synthesis_requests"."grounding_resolver_version") <= 100 and btrim("ai_synthesis_requests"."context_selection_version") <> '' and char_length("ai_synthesis_requests"."context_selection_version") <= 100 and btrim("ai_synthesis_requests"."disclosure_version") <> '' and char_length("ai_synthesis_requests"."disclosure_version") <= 100),
	CONSTRAINT "ai_synthesis_requests_transmission_acknowledged" CHECK ("ai_synthesis_requests"."external_transmission_acknowledged" = true),
	CONSTRAINT "ai_synthesis_requests_undispatched_expiry_order" CHECK ("ai_synthesis_requests"."undispatched_expires_at" >= "ai_synthesis_requests"."created_at")
);
--> statement-breakpoint
CREATE TABLE "ai_synthesis_result_groundings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"extraction_revision_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"locator_quote" text NOT NULL,
	"locator_prefix" text,
	"locator_suffix" text,
	"source_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_synthesis_result_groundings_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "ai_synthesis_result_groundings_result_source_offset_unique" UNIQUE("project_id","result_id","extraction_revision_id","evidence_id","start_offset","end_offset"),
	CONSTRAINT "ai_synthesis_result_groundings_page_positive" CHECK ("ai_synthesis_result_groundings"."page_number" > 0),
	CONSTRAINT "ai_synthesis_result_groundings_offset_shape" CHECK ("ai_synthesis_result_groundings"."start_offset" >= 0 and "ai_synthesis_result_groundings"."end_offset" > "ai_synthesis_result_groundings"."start_offset" and "ai_synthesis_result_groundings"."end_offset" - "ai_synthesis_result_groundings"."start_offset" <= 500),
	CONSTRAINT "ai_synthesis_result_groundings_quote_bound" CHECK (btrim("ai_synthesis_result_groundings"."locator_quote") <> '' and char_length("ai_synthesis_result_groundings"."locator_quote") <= 500),
	CONSTRAINT "ai_synthesis_result_groundings_context_bound" CHECK (("ai_synthesis_result_groundings"."locator_prefix" is null or char_length("ai_synthesis_result_groundings"."locator_prefix") <= 120) and ("ai_synthesis_result_groundings"."locator_suffix" is null or char_length("ai_synthesis_result_groundings"."locator_suffix") <= 120)),
	CONSTRAINT "ai_synthesis_result_groundings_source_text_bound" CHECK (char_length("ai_synthesis_result_groundings"."source_text") > 0 and char_length("ai_synthesis_result_groundings"."source_text") <= 4000)
);
--> statement-breakpoint
CREATE TABLE "ai_synthesis_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"provider_diagnostic" text NOT NULL,
	"error_code" text,
	"candidate_state" text,
	"proposed_title" text,
	"proposed_statement_text" text,
	"explanation" text,
	"source_coverage_state" text DEFAULT 'complete' NOT NULL,
	"covered_support_count" integer DEFAULT 0 NOT NULL,
	"grounding_count" integer DEFAULT 0 NOT NULL,
	"provider_request_id" text,
	"configured_model" text NOT NULL,
	"returned_model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_synthesis_results_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "ai_synthesis_results_project_request_unique" UNIQUE("project_id","request_id"),
	CONSTRAINT "ai_synthesis_results_project_request_id_unique" UNIQUE("project_id","request_id","id"),
	CONSTRAINT "ai_synthesis_results_outcome_valid" CHECK ("ai_synthesis_results"."outcome" in ('succeeded', 'no_candidate', 'provider_unavailable', 'failed', 'invalid_output', 'unresolvable_grounding', 'outcome_unknown')),
	CONSTRAINT "ai_synthesis_results_provider_diagnostic_valid" CHECK ("ai_synthesis_results"."provider_diagnostic" in ('success', 'refusal', 'incomplete', 'schema_invalid', 'transport_error', 'api_error', 'unknown')),
	CONSTRAINT "ai_synthesis_results_candidate_state_valid" CHECK ("ai_synthesis_results"."candidate_state" is null or "ai_synthesis_results"."candidate_state" in ('present', 'not_present')),
	CONSTRAINT "ai_synthesis_results_source_coverage_valid" CHECK ("ai_synthesis_results"."source_coverage_state" in ('complete', 'partial', 'not_applicable')),
	CONSTRAINT "ai_synthesis_results_result_shape" CHECK ((
      ("ai_synthesis_results"."outcome" = 'succeeded' and "ai_synthesis_results"."candidate_state" = 'present' and "ai_synthesis_results"."proposed_statement_text" is not null and btrim("ai_synthesis_results"."proposed_statement_text") <> '' and "ai_synthesis_results"."error_code" is null)
      or ("ai_synthesis_results"."outcome" = 'no_candidate' and "ai_synthesis_results"."candidate_state" = 'not_present' and "ai_synthesis_results"."proposed_title" is null and "ai_synthesis_results"."proposed_statement_text" is null and "ai_synthesis_results"."grounding_count" = 0)
      or ("ai_synthesis_results"."outcome" not in ('succeeded', 'no_candidate') and "ai_synthesis_results"."candidate_state" is null and "ai_synthesis_results"."proposed_title" is null and "ai_synthesis_results"."proposed_statement_text" is null)
    )),
	CONSTRAINT "ai_synthesis_results_title_bound" CHECK ("ai_synthesis_results"."proposed_title" is null or (btrim("ai_synthesis_results"."proposed_title") <> '' and char_length("ai_synthesis_results"."proposed_title") <= 500)),
	CONSTRAINT "ai_synthesis_results_statement_bound" CHECK ("ai_synthesis_results"."proposed_statement_text" is null or char_length("ai_synthesis_results"."proposed_statement_text") <= 10000),
	CONSTRAINT "ai_synthesis_results_explanation_bound" CHECK ("ai_synthesis_results"."explanation" is null or char_length("ai_synthesis_results"."explanation") <= 2000),
	CONSTRAINT "ai_synthesis_results_error_bound" CHECK ("ai_synthesis_results"."error_code" is null or (btrim("ai_synthesis_results"."error_code") <> '' and char_length("ai_synthesis_results"."error_code") <= 80)),
	CONSTRAINT "ai_synthesis_results_metadata_bound" CHECK ("ai_synthesis_results"."provider_request_id" is null or (btrim("ai_synthesis_results"."provider_request_id") <> '' and char_length("ai_synthesis_results"."provider_request_id") <= 200)),
	CONSTRAINT "ai_synthesis_results_counts_valid" CHECK ("ai_synthesis_results"."covered_support_count" >= 0 and "ai_synthesis_results"."grounding_count" >= 0 and ("ai_synthesis_results"."input_tokens" is null or "ai_synthesis_results"."input_tokens" >= 0) and ("ai_synthesis_results"."output_tokens" is null or "ai_synthesis_results"."output_tokens" >= 0) and ("ai_synthesis_results"."duration_ms" is null or "ai_synthesis_results"."duration_ms" >= 0))
);
--> statement-breakpoint
ALTER TABLE "ai_synthesis_decisions" ADD CONSTRAINT "ai_synthesis_decisions_request_fk" FOREIGN KEY ("project_id","request_id") REFERENCES "public"."ai_synthesis_requests"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_decisions" ADD CONSTRAINT "ai_synthesis_decisions_expected_revision_fk" FOREIGN KEY ("project_id","expected_current_target_revision_id") REFERENCES "public"."synthesis_revisions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_decisions" ADD CONSTRAINT "ai_synthesis_decisions_resulting_revision_fk" FOREIGN KEY ("project_id","resulting_synthesis_revision_id") REFERENCES "public"."synthesis_revisions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_dispatches" ADD CONSTRAINT "ai_synthesis_dispatches_request_fk" FOREIGN KEY ("project_id","request_id") REFERENCES "public"."ai_synthesis_requests"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_request_sources" ADD CONSTRAINT "ai_synthesis_request_sources_support_fk" FOREIGN KEY ("project_id","request_id","extraction_revision_id") REFERENCES "public"."ai_synthesis_request_supports"("project_id","request_id","extraction_revision_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_request_sources" ADD CONSTRAINT "ai_synthesis_request_sources_evidence_fk" FOREIGN KEY ("project_id","paper_id","evidence_id") REFERENCES "public"."evidence"("project_id","paper_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_request_sources" ADD CONSTRAINT "ai_synthesis_request_sources_membership_fk" FOREIGN KEY ("project_id","membership_id") REFERENCES "public"."evidence_set_memberships"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_request_supports" ADD CONSTRAINT "ai_synthesis_request_supports_request_fk" FOREIGN KEY ("project_id","request_id") REFERENCES "public"."ai_synthesis_requests"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_request_supports" ADD CONSTRAINT "ai_synthesis_request_supports_revision_fk" FOREIGN KEY ("project_id","extraction_revision_id") REFERENCES "public"."extraction_value_revisions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_request_supports" ADD CONSTRAINT "ai_synthesis_request_supports_paper_fk" FOREIGN KEY ("project_id","paper_id") REFERENCES "public"."papers"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_request_supports" ADD CONSTRAINT "ai_synthesis_request_supports_field_fk" FOREIGN KEY ("project_id","extraction_field_id") REFERENCES "public"."extraction_fields"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_request_supports" ADD CONSTRAINT "ai_synthesis_request_supports_value_fk" FOREIGN KEY ("project_id","paper_id","extraction_value_id","extraction_field_id") REFERENCES "public"."extraction_values"("project_id","paper_id","id","field_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_request_supports" ADD CONSTRAINT "ai_synthesis_request_supports_option_fk" FOREIGN KEY ("project_id","extraction_field_id","option_id") REFERENCES "public"."extraction_options"("project_id","field_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_requests" ADD CONSTRAINT "ai_synthesis_requests_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_requests" ADD CONSTRAINT "ai_synthesis_requests_preparation_fk" FOREIGN KEY ("project_id","preparation_id") REFERENCES "public"."synthesis_preparations"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_requests" ADD CONSTRAINT "ai_synthesis_requests_evidence_set_fk" FOREIGN KEY ("project_id","evidence_set_id") REFERENCES "public"."evidence_sets"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_requests" ADD CONSTRAINT "ai_synthesis_requests_composition_revision_fk" FOREIGN KEY ("project_id","evidence_set_id","evidence_set_composition_revision_id") REFERENCES "public"."evidence_set_composition_revisions"("project_id","evidence_set_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_requests" ADD CONSTRAINT "ai_synthesis_requests_field_fk" FOREIGN KEY ("project_id","extraction_field_id") REFERENCES "public"."extraction_fields"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_requests" ADD CONSTRAINT "ai_synthesis_requests_target_statement_fk" FOREIGN KEY ("project_id","target_synthesis_statement_id") REFERENCES "public"."synthesis_statements"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_requests" ADD CONSTRAINT "ai_synthesis_requests_target_baseline_fk" FOREIGN KEY ("project_id","target_synthesis_statement_id","target_baseline_synthesis_revision_id") REFERENCES "public"."synthesis_revisions"("project_id","synthesis_statement_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_result_groundings" ADD CONSTRAINT "ai_synthesis_result_groundings_result_fk" FOREIGN KEY ("project_id","request_id","result_id") REFERENCES "public"."ai_synthesis_results"("project_id","request_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_result_groundings" ADD CONSTRAINT "ai_synthesis_result_groundings_source_fk" FOREIGN KEY ("project_id","request_id","extraction_revision_id","evidence_id") REFERENCES "public"."ai_synthesis_request_sources"("project_id","request_id","extraction_revision_id","evidence_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_synthesis_results" ADD CONSTRAINT "ai_synthesis_results_request_fk" FOREIGN KEY ("project_id","request_id") REFERENCES "public"."ai_synthesis_requests"("project_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_ai_synthesis_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'AI synthesis history is immutable';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER ai_synthesis_requests_append_only BEFORE UPDATE OR DELETE ON "ai_synthesis_requests" FOR EACH ROW EXECUTE FUNCTION prevent_ai_synthesis_history_mutation();
--> statement-breakpoint
CREATE TRIGGER ai_synthesis_request_supports_append_only BEFORE UPDATE OR DELETE ON "ai_synthesis_request_supports" FOR EACH ROW EXECUTE FUNCTION prevent_ai_synthesis_history_mutation();
--> statement-breakpoint
CREATE TRIGGER ai_synthesis_request_sources_append_only BEFORE UPDATE OR DELETE ON "ai_synthesis_request_sources" FOR EACH ROW EXECUTE FUNCTION prevent_ai_synthesis_history_mutation();
--> statement-breakpoint
CREATE TRIGGER ai_synthesis_dispatches_append_only BEFORE UPDATE OR DELETE ON "ai_synthesis_dispatches" FOR EACH ROW EXECUTE FUNCTION prevent_ai_synthesis_history_mutation();
--> statement-breakpoint
CREATE TRIGGER ai_synthesis_results_append_only BEFORE UPDATE OR DELETE ON "ai_synthesis_results" FOR EACH ROW EXECUTE FUNCTION prevent_ai_synthesis_history_mutation();
--> statement-breakpoint
CREATE TRIGGER ai_synthesis_result_groundings_append_only BEFORE UPDATE OR DELETE ON "ai_synthesis_result_groundings" FOR EACH ROW EXECUTE FUNCTION prevent_ai_synthesis_history_mutation();
--> statement-breakpoint
CREATE TRIGGER ai_synthesis_decisions_append_only BEFORE UPDATE OR DELETE ON "ai_synthesis_decisions" FOR EACH ROW EXECUTE FUNCTION prevent_ai_synthesis_history_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_ai_synthesis_request_manifest() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  support_total integer;
  source_total integer;
  source_chars integer;
  source_bytes integer;
  preparation_record record;
  mismatch boolean;
BEGIN
  SELECT p.evidence_set_id, p.evidence_set_composition_revision_id, p.extraction_field_id,
         p.target_synthesis_statement_id, p.finalized_synthesis_revision_id
    INTO preparation_record
    FROM synthesis_preparations p
   WHERE p.project_id = NEW.project_id AND p.id = NEW.preparation_id;
  IF NOT FOUND OR preparation_record.evidence_set_id IS DISTINCT FROM NEW.evidence_set_id
     OR preparation_record.extraction_field_id IS DISTINCT FROM NEW.extraction_field_id
     OR preparation_record.evidence_set_composition_revision_id IS DISTINCT FROM NEW.evidence_set_composition_revision_id
     OR preparation_record.target_synthesis_statement_id IS DISTINCT FROM NEW.target_synthesis_statement_id
     OR preparation_record.finalized_synthesis_revision_id IS NOT NULL THEN
    RAISE EXCEPTION 'AI synthesis request preparation snapshot is inconsistent' USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer INTO support_total
    FROM ai_synthesis_request_supports s
   WHERE s.project_id = NEW.project_id AND s.request_id = NEW.id;
  IF support_total IS DISTINCT FROM NEW.support_count OR support_total < 1 OR support_total > 20 THEN
    RAISE EXCEPTION 'AI synthesis request support manifest is incomplete' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM synthesis_preparation_selections s
     WHERE s.project_id = NEW.project_id AND s.preparation_id = NEW.preparation_id
       AND NOT EXISTS (SELECT 1 FROM ai_synthesis_request_supports r WHERE r.project_id = s.project_id AND r.request_id = NEW.id AND r.extraction_revision_id = s.extraction_revision_id)
  ) OR EXISTS (
    SELECT 1 FROM ai_synthesis_request_supports r
     WHERE r.project_id = NEW.project_id AND r.request_id = NEW.id
       AND NOT EXISTS (SELECT 1 FROM synthesis_preparation_selections s WHERE s.project_id = r.project_id AND s.preparation_id = NEW.preparation_id AND s.extraction_revision_id = r.extraction_revision_id)
  ) THEN
    RAISE EXCEPTION 'AI synthesis request supports must equal preparation selections' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM ai_synthesis_request_supports s
     WHERE s.project_id = NEW.project_id AND s.request_id = NEW.id
       AND (s.extraction_field_id IS DISTINCT FROM NEW.extraction_field_id OR s.field_type <> NEW.field_type)
  ) THEN
    RAISE EXCEPTION 'AI synthesis request support field snapshot is inconsistent' USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer, coalesce(sum(char_length(source_text)), 0)::integer, coalesce(sum(source_byte_size), 0)::integer
    INTO source_total, source_chars, source_bytes
    FROM ai_synthesis_request_sources s
   WHERE s.project_id = NEW.project_id AND s.request_id = NEW.id;
  IF source_total IS DISTINCT FROM NEW.source_count OR source_total < 1 OR source_total > 80
     OR source_chars IS DISTINCT FROM NEW.source_character_count OR source_bytes IS DISTINCT FROM NEW.source_byte_size THEN
    RAISE EXCEPTION 'AI synthesis request source manifest is incomplete' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM ai_synthesis_request_supports s
     WHERE s.project_id = NEW.project_id AND s.request_id = NEW.id
       AND NOT EXISTS (
         SELECT 1 FROM ai_synthesis_request_sources x
          WHERE x.project_id = s.project_id AND x.request_id = s.request_id AND x.extraction_revision_id = s.extraction_revision_id
       )
  ) THEN
    RAISE EXCEPTION 'Every AI synthesis support must include connecting Evidence context' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM ai_synthesis_request_sources s
      WHERE s.project_id = NEW.project_id AND s.request_id = NEW.id
     GROUP BY s.extraction_revision_id HAVING count(*) > 8
  ) OR EXISTS (
    SELECT 1 FROM ai_synthesis_request_sources s
     WHERE s.project_id = NEW.project_id AND s.request_id = NEW.id
       AND NOT EXISTS (
         SELECT 1 FROM extraction_revision_evidence re
          WHERE re.project_id = s.project_id AND re.revision_id = s.extraction_revision_id AND re.evidence_id = s.evidence_id
       )
  ) THEN
    RAISE EXCEPTION 'AI synthesis request source is not a connecting Evidence item' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM ai_synthesis_request_sources s
     WHERE s.project_id = NEW.project_id AND s.request_id = NEW.id
       AND NOT EXISTS (
         SELECT 1
           FROM evidence_set_composition_members cm
           JOIN evidence_set_memberships m ON m.project_id = cm.project_id AND m.id = cm.membership_id
          WHERE cm.project_id = NEW.project_id AND cm.evidence_set_id = NEW.evidence_set_id
            AND cm.composition_revision_id = NEW.evidence_set_composition_revision_id
            AND m.id = s.membership_id AND m.evidence_id = s.evidence_id
       )
   ) THEN
    RAISE EXCEPTION 'AI synthesis request source is outside the pinned composition' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM ai_synthesis_request_sources s
      JOIN evidence e
        ON e.project_id = s.project_id
       AND e.paper_id = s.paper_id
       AND e.id = s.evidence_id
     WHERE s.project_id = NEW.project_id
       AND s.request_id = NEW.id
       AND (
         s.page_number IS DISTINCT FROM e.page_number
         OR s.source_text IS DISTINCT FROM e.source_text
         OR s.source_text_sha256 IS DISTINCT FROM encode(sha256(convert_to(e.source_text, 'UTF8')), 'hex')
         OR s.source_character_count IS DISTINCT FROM char_length(e.source_text)
         OR s.source_byte_size IS DISTINCT FROM octet_length(e.source_text)
         OR s.evidence_note_snapshot IS DISTINCT FROM e.note
         OR s.evidence_review_state IS DISTINCT FROM coalesce((
           SELECT d.decision
             FROM evidence_review_decisions d
            WHERE d.project_id = e.project_id
              AND d.evidence_id = e.id
            ORDER BY d.sequence DESC
            LIMIT 1
         ), 'unreviewed')
       )
  ) THEN
    RAISE EXCEPTION 'AI synthesis request source manifest must describe the exact frozen Evidence context' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ai_synthesis_requests_manifest_guard
AFTER INSERT ON "ai_synthesis_requests"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_ai_synthesis_request_manifest();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_ai_synthesis_grounding_source() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  persisted_source_text text;
  persisted_page_number integer;
  derived_text text;
BEGIN
  SELECT s.page_number, s.source_text
    INTO persisted_page_number, persisted_source_text
    FROM ai_synthesis_request_sources s
   WHERE s.project_id = NEW.project_id
     AND s.request_id = NEW.request_id
     AND s.extraction_revision_id = NEW.extraction_revision_id
     AND s.evidence_id = NEW.evidence_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI synthesis grounding is not part of the frozen request source manifest' USING ERRCODE = '23514';
  END IF;
  IF NEW.page_number IS DISTINCT FROM persisted_page_number
     OR persisted_source_text IS NULL
     OR NEW.start_offset < 0
     OR NEW.end_offset > char_length(persisted_source_text) THEN
    RAISE EXCEPTION 'AI synthesis grounding does not identify the exact frozen Evidence source' USING ERRCODE = '23514';
  END IF;
  derived_text := substring(persisted_source_text FROM NEW.start_offset + 1 FOR NEW.end_offset - NEW.start_offset);
  IF derived_text IS NULL OR derived_text IS DISTINCT FROM NEW.source_text OR derived_text IS DISTINCT FROM NEW.locator_quote THEN
    RAISE EXCEPTION 'AI synthesis grounding must preserve the exact frozen Evidence substring' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER ai_synthesis_result_groundings_source_guard
BEFORE INSERT ON "ai_synthesis_result_groundings"
FOR EACH ROW EXECUTE FUNCTION validate_ai_synthesis_grounding_source();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_ai_synthesis_result_groundings() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  required_supports integer;
  grounded_supports integer;
  actual_groundings integer;
BEGIN
  SELECT count(*)::integer INTO required_supports
    FROM ai_synthesis_request_supports s
   WHERE s.project_id = NEW.project_id AND s.request_id = NEW.request_id;
  SELECT count(*)::integer, count(DISTINCT g.extraction_revision_id)::integer
    INTO actual_groundings, grounded_supports
    FROM ai_synthesis_result_groundings g
   WHERE g.project_id = NEW.project_id AND g.request_id = NEW.request_id AND g.result_id = NEW.id;
  IF actual_groundings > 40 OR coalesce((
    SELECT sum(g.end_offset - g.start_offset)::integer
      FROM ai_synthesis_result_groundings g
     WHERE g.project_id = NEW.project_id AND g.request_id = NEW.request_id AND g.result_id = NEW.id
  ), 0) > 12000 THEN
    RAISE EXCEPTION 'AI synthesis result grounding limits were exceeded' USING ERRCODE = '23514';
  END IF;
  IF actual_groundings IS DISTINCT FROM NEW.grounding_count THEN
    RAISE EXCEPTION 'AI synthesis grounding count does not match result metadata' USING ERRCODE = '23514';
  END IF;
  IF NEW.outcome = 'succeeded' AND (required_supports <> grounded_supports OR NEW.covered_support_count IS DISTINCT FROM grounded_supports OR NEW.source_coverage_state <> 'complete') THEN
    RAISE EXCEPTION 'AI synthesis candidate must ground every frozen support' USING ERRCODE = '23514';
  END IF;
  IF NEW.outcome <> 'succeeded' AND actual_groundings <> 0 THEN
    RAISE EXCEPTION 'Only a succeeded AI synthesis result may have groundings' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ai_synthesis_results_grounding_guard
AFTER INSERT ON "ai_synthesis_results"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_ai_synthesis_result_groundings();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_ai_synthesis_decision_result() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  result_outcome text;
  resulting_statement uuid;
  preparation_target_statement uuid;
  request_baseline_revision uuid;
  resulting_title text;
  resulting_statement_text text;
  resulting_researcher_note text;
  support_count integer;
  resulting_support_count integer;
BEGIN
  IF NEW.decision <> 'accepted' THEN RETURN NEW; END IF;
  SELECT r.outcome INTO result_outcome
    FROM ai_synthesis_results r JOIN ai_synthesis_requests q ON q.project_id = r.project_id AND q.id = r.request_id
   WHERE r.project_id = NEW.project_id AND r.request_id = NEW.request_id;
  IF result_outcome IS DISTINCT FROM 'succeeded' THEN
    RAISE EXCEPTION 'Only a successful AI synthesis candidate can be accepted' USING ERRCODE = '23514';
  END IF;
  SELECT sr.synthesis_statement_id, sr.title, sr.statement_text, sr.researcher_note
    INTO resulting_statement, resulting_title, resulting_statement_text, resulting_researcher_note
    FROM synthesis_revisions sr
   WHERE sr.project_id = NEW.project_id AND sr.id = NEW.resulting_synthesis_revision_id;
  SELECT p.target_synthesis_statement_id, q.target_baseline_synthesis_revision_id
    INTO preparation_target_statement, request_baseline_revision
    FROM ai_synthesis_requests q
    JOIN synthesis_preparations p ON p.project_id = q.project_id AND p.id = q.preparation_id
   WHERE q.project_id = NEW.project_id AND q.id = NEW.request_id;
  IF NEW.expected_current_target_revision_id IS DISTINCT FROM request_baseline_revision THEN
    RAISE EXCEPTION 'Accepted AI decision expected revision differs from frozen request baseline' USING ERRCODE = '23514';
  END IF;
  IF resulting_statement IS NULL OR resulting_statement IS DISTINCT FROM preparation_target_statement THEN
    RAISE EXCEPTION 'Accepted AI synthesis revision does not belong to the finalized preparation target' USING ERRCODE = '23514';
  END IF;
  IF NEW.title IS DISTINCT FROM resulting_title
     OR NEW.statement_text IS DISTINCT FROM resulting_statement_text
     OR NEW.researcher_note IS DISTINCT FROM resulting_researcher_note THEN
    RAISE EXCEPTION 'Accepted AI synthesis decision text differs from resulting revision' USING ERRCODE = '23514';
  END IF;
  SELECT count(*)::integer INTO support_count FROM ai_synthesis_request_supports WHERE project_id = NEW.project_id AND request_id = NEW.request_id;
  SELECT count(*)::integer INTO resulting_support_count FROM synthesis_revision_supports WHERE project_id = NEW.project_id AND synthesis_revision_id = NEW.resulting_synthesis_revision_id;
  IF support_count IS DISTINCT FROM resulting_support_count OR EXISTS (
    SELECT 1 FROM ai_synthesis_request_supports s WHERE s.project_id = NEW.project_id AND s.request_id = NEW.request_id
      AND NOT EXISTS (SELECT 1 FROM synthesis_revision_supports rs WHERE rs.project_id = s.project_id AND rs.synthesis_revision_id = NEW.resulting_synthesis_revision_id AND rs.extraction_revision_id = s.extraction_revision_id)
  ) THEN
    RAISE EXCEPTION 'Accepted AI synthesis support set differs from frozen request supports' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ai_synthesis_decisions_support_guard
AFTER INSERT ON "ai_synthesis_decisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_ai_synthesis_decision_result();
