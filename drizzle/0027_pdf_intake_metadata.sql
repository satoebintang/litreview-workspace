CREATE TABLE "pdf_intake_metadata_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"intake_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"paper_field" text NOT NULL,
	"candidate_ordinal" integer NOT NULL,
	"value_jsonb" jsonb,
	"source_kind" text,
	"source_locator" text,
	"classification" text NOT NULL,
	"diagnostic" text,
	"normalized_value" text,
	"page_number" integer,
	"start_offset" integer,
	"end_offset" integer,
	"exact_match" text,
	"page_text_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pdf_intake_metadata_fields_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "pdf_intake_metadata_fields_project_intake_result_unique" UNIQUE("project_id","intake_id","result_id","paper_field","candidate_ordinal"),
	CONSTRAINT "pdf_intake_metadata_fields_paper_field_valid" CHECK ("pdf_intake_metadata_fields"."paper_field" in ('title', 'authors', 'publication_year', 'venue', 'doi', 'abstract')),
	CONSTRAINT "pdf_intake_metadata_fields_candidate_ordinal_valid" CHECK ("pdf_intake_metadata_fields"."candidate_ordinal" > 0),
	CONSTRAINT "pdf_intake_metadata_fields_source_kind_valid" CHECK ("pdf_intake_metadata_fields"."source_kind" is null or "pdf_intake_metadata_fields"."source_kind" in ('pdf_info', 'xmp', 'page_text_match', 'unavailable')),
	CONSTRAINT "pdf_intake_metadata_fields_classification_valid" CHECK ("pdf_intake_metadata_fields"."classification" in ('exact_embedded_metadata', 'exact_text_identifier', 'ambiguous', 'unavailable')),
	CONSTRAINT "pdf_intake_metadata_fields_source_locator_shape" CHECK ("pdf_intake_metadata_fields"."source_locator" is null or btrim("pdf_intake_metadata_fields"."source_locator") <> ''),
	CONSTRAINT "pdf_intake_metadata_fields_page_number_valid" CHECK ("pdf_intake_metadata_fields"."page_number" is null or "pdf_intake_metadata_fields"."page_number" > 0),
	CONSTRAINT "pdf_intake_metadata_fields_offset_shape" CHECK ((("pdf_intake_metadata_fields"."start_offset" is null and "pdf_intake_metadata_fields"."end_offset" is null) or ("pdf_intake_metadata_fields"."start_offset" is not null and "pdf_intake_metadata_fields"."end_offset" is not null and "pdf_intake_metadata_fields"."start_offset" >= 0 and "pdf_intake_metadata_fields"."end_offset" > "pdf_intake_metadata_fields"."start_offset"))),
	CONSTRAINT "pdf_intake_metadata_fields_exact_match_shape" CHECK ("pdf_intake_metadata_fields"."exact_match" is null or btrim("pdf_intake_metadata_fields"."exact_match") <> ''),
	CONSTRAINT "pdf_intake_metadata_fields_page_text_sha256_format" CHECK ("pdf_intake_metadata_fields"."page_text_sha256" is null or "pdf_intake_metadata_fields"."page_text_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pdf_intake_metadata_fields_page_match_provenance_shape" CHECK ("pdf_intake_metadata_fields"."source_kind" is distinct from 'page_text_match' or ("pdf_intake_metadata_fields"."page_number" is not null and "pdf_intake_metadata_fields"."start_offset" is not null and "pdf_intake_metadata_fields"."end_offset" is not null and "pdf_intake_metadata_fields"."exact_match" is not null and "pdf_intake_metadata_fields"."page_text_sha256" is not null)),
	CONSTRAINT "pdf_intake_metadata_fields_unavailable_shape" CHECK (("pdf_intake_metadata_fields"."classification" <> 'unavailable' or ("pdf_intake_metadata_fields"."value_jsonb" is null and "pdf_intake_metadata_fields"."normalized_value" is null and "pdf_intake_metadata_fields"."page_number" is null and "pdf_intake_metadata_fields"."start_offset" is null and "pdf_intake_metadata_fields"."end_offset" is null and "pdf_intake_metadata_fields"."exact_match" is null and "pdf_intake_metadata_fields"."page_text_sha256" is null)))
);
--> statement-breakpoint
CREATE TABLE "pdf_intake_metadata_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence_no" bigint NOT NULL,
	"project_id" uuid NOT NULL,
	"intake_id" uuid NOT NULL,
	"status" text NOT NULL,
	"extractor_key" text NOT NULL,
	"extractor_version" text NOT NULL,
	"pdfjs_version" text,
	"mapping_version" text NOT NULL,
	"text_scan_version" text NOT NULL,
	"doi_algorithm_version" text NOT NULL,
	"page_count" integer,
	"attempted_page_count" integer NOT NULL,
	"succeeded_page_count" integer NOT NULL,
	"scanned_code_points" integer NOT NULL,
	"diagnostics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pdf_intake_metadata_results_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "pdf_intake_metadata_results_project_intake_sequence_no_unique" UNIQUE("project_id","intake_id","sequence_no"),
	CONSTRAINT "pdf_intake_metadata_results_status_valid" CHECK ("pdf_intake_metadata_results"."status" in ('succeeded', 'partial', 'failed')),
	CONSTRAINT "pdf_intake_metadata_results_extractor_key_nonblank" CHECK (btrim("pdf_intake_metadata_results"."extractor_key") <> ''),
	CONSTRAINT "pdf_intake_metadata_results_version_shape" CHECK (btrim("pdf_intake_metadata_results"."extractor_version") <> '' and ("pdf_intake_metadata_results"."pdfjs_version" is null or btrim("pdf_intake_metadata_results"."pdfjs_version") <> '') and btrim("pdf_intake_metadata_results"."mapping_version") <> '' and btrim("pdf_intake_metadata_results"."text_scan_version") <> '' and btrim("pdf_intake_metadata_results"."doi_algorithm_version") <> ''),
	CONSTRAINT "pdf_intake_metadata_results_page_counts_valid" CHECK ("pdf_intake_metadata_results"."page_count" is null or ("pdf_intake_metadata_results"."page_count" >= 0 and "pdf_intake_metadata_results"."attempted_page_count" >= 0 and "pdf_intake_metadata_results"."succeeded_page_count" >= 0 and "pdf_intake_metadata_results"."succeeded_page_count" <= "pdf_intake_metadata_results"."attempted_page_count" and "pdf_intake_metadata_results"."attempted_page_count" <= "pdf_intake_metadata_results"."page_count")),
	CONSTRAINT "pdf_intake_metadata_results_scanned_code_points_valid" CHECK ("pdf_intake_metadata_results"."scanned_code_points" >= 0 and "pdf_intake_metadata_results"."scanned_code_points" <= 250000),
	CONSTRAINT "pdf_intake_metadata_results_error_shape" CHECK ((("pdf_intake_metadata_results"."status" = 'failed' and "pdf_intake_metadata_results"."error_code" is not null and btrim("pdf_intake_metadata_results"."error_code") <> '') or ("pdf_intake_metadata_results"."status" <> 'failed' and "pdf_intake_metadata_results"."error_code" is null))),
	CONSTRAINT "pdf_intake_metadata_results_error_message_bound" CHECK ("pdf_intake_metadata_results"."error_message" is null or char_length("pdf_intake_metadata_results"."error_message") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "pdf_intake_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence_no" bigint GENERATED ALWAYS AS IDENTITY (sequence name "pdf_intake_resolutions_sequence_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"intake_id" uuid NOT NULL,
	"metadata_result_id" uuid NOT NULL,
	"resolution_kind" text NOT NULL,
	"paper_id" uuid NOT NULL,
	"full_text_document_id" uuid NOT NULL,
	"materialization_kind" text NOT NULL,
	"creation_payload" jsonb,
	"candidate_context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"preview_fingerprint" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pdf_intake_resolutions_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "pdf_intake_resolutions_project_intake_unique" UNIQUE("project_id","intake_id"),
	CONSTRAINT "pdf_intake_resolutions_resolution_kind_valid" CHECK ("pdf_intake_resolutions"."resolution_kind" in ('create_paper', 'match_paper')),
	CONSTRAINT "pdf_intake_resolutions_materialization_kind_valid" CHECK ("pdf_intake_resolutions"."materialization_kind" in ('created_document', 'reused_document')),
	CONSTRAINT "pdf_intake_resolutions_creation_payload_shape" CHECK ((("pdf_intake_resolutions"."resolution_kind" = 'create_paper' and "pdf_intake_resolutions"."creation_payload" is not null) or ("pdf_intake_resolutions"."resolution_kind" = 'match_paper' and "pdf_intake_resolutions"."creation_payload" is null))),
	CONSTRAINT "pdf_intake_resolutions_candidate_context_shape" CHECK ("pdf_intake_resolutions"."candidate_context" is not null),
	CONSTRAINT "pdf_intake_resolutions_preview_fingerprint_shape" CHECK ("pdf_intake_resolutions"."preview_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pdf_intake_resolutions_request_fingerprint_shape" CHECK ("pdf_intake_resolutions"."request_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "pdf_intakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pdf_intakes_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "pdf_intakes_project_sha256_unique" UNIQUE("project_id","sha256"),
	CONSTRAINT "pdf_intakes_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "pdf_intakes_storage_key_nonblank" CHECK (btrim("pdf_intakes"."storage_key") <> ''),
	CONSTRAINT "pdf_intakes_storage_key_format" CHECK ("pdf_intakes"."storage_key" ~ '^projects/[0-9a-f-]{36}/pdf-intakes/[0-9a-f-]{36}/source\.pdf$'),
	CONSTRAINT "pdf_intakes_filename_nonblank" CHECK (btrim("pdf_intakes"."original_filename") <> ''),
	CONSTRAINT "pdf_intakes_filename_length" CHECK (char_length("pdf_intakes"."original_filename") <= 500),
	CONSTRAINT "pdf_intakes_media_type_pdf" CHECK ("pdf_intakes"."media_type" = 'application/pdf'),
	CONSTRAINT "pdf_intakes_byte_size_bound" CHECK ("pdf_intakes"."byte_size" > 0 and "pdf_intakes"."byte_size" <= 52428800),
	CONSTRAINT "pdf_intakes_sha256_format" CHECK ("pdf_intakes"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "pdf_intake_metadata_fields" ADD CONSTRAINT "pdf_intake_metadata_fields_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_intake_metadata_fields" ADD CONSTRAINT "pdf_intake_metadata_fields_intake_fk" FOREIGN KEY ("project_id","intake_id") REFERENCES "public"."pdf_intakes"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_intake_metadata_fields" ADD CONSTRAINT "pdf_intake_metadata_fields_result_fk" FOREIGN KEY ("project_id","result_id") REFERENCES "public"."pdf_intake_metadata_results"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_intake_metadata_results" ADD CONSTRAINT "pdf_intake_metadata_results_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_intake_metadata_results" ADD CONSTRAINT "pdf_intake_metadata_results_intake_fk" FOREIGN KEY ("project_id","intake_id") REFERENCES "public"."pdf_intakes"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_intake_resolutions" ADD CONSTRAINT "pdf_intake_resolutions_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_intake_resolutions" ADD CONSTRAINT "pdf_intake_resolutions_intake_fk" FOREIGN KEY ("project_id","intake_id") REFERENCES "public"."pdf_intakes"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_intake_resolutions" ADD CONSTRAINT "pdf_intake_resolutions_metadata_result_fk" FOREIGN KEY ("project_id","metadata_result_id") REFERENCES "public"."pdf_intake_metadata_results"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_intake_resolutions" ADD CONSTRAINT "pdf_intake_resolutions_paper_fk" FOREIGN KEY ("project_id","paper_id") REFERENCES "public"."papers"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_intake_resolutions" ADD CONSTRAINT "pdf_intake_resolutions_full_text_document_fk" FOREIGN KEY ("project_id","full_text_document_id") REFERENCES "public"."full_text_documents"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_intakes" ADD CONSTRAINT "pdf_intakes_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pdf_intake_metadata_fields_project_result_order_idx" ON "pdf_intake_metadata_fields" USING btree ("project_id","intake_id","result_id","paper_field","candidate_ordinal");--> statement-breakpoint
CREATE INDEX "pdf_intake_metadata_results_project_intake_sequence_no_idx" ON "pdf_intake_metadata_results" USING btree ("project_id","intake_id","sequence_no");--> statement-breakpoint
CREATE INDEX "pdf_intake_metadata_results_project_created_at_idx" ON "pdf_intake_metadata_results" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "pdf_intake_resolutions_project_sequence_no_idx" ON "pdf_intake_resolutions" USING btree ("project_id","sequence_no");--> statement-breakpoint
CREATE INDEX "pdf_intakes_project_created_at_idx" ON "pdf_intakes" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_pdf_intake_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'PDF intake source artifacts are immutable';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER pdf_intakes_append_only
BEFORE UPDATE OR DELETE ON "pdf_intakes"
FOR EACH ROW EXECUTE FUNCTION prevent_pdf_intake_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_pdf_intake_metadata_result_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'PDF intake metadata results are append-only';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER pdf_intake_metadata_results_append_only
BEFORE UPDATE OR DELETE ON "pdf_intake_metadata_results"
FOR EACH ROW EXECUTE FUNCTION prevent_pdf_intake_metadata_result_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_pdf_intake_metadata_field_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'PDF intake metadata fields are append-only';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER pdf_intake_metadata_fields_append_only
BEFORE UPDATE OR DELETE ON "pdf_intake_metadata_fields"
FOR EACH ROW EXECUTE FUNCTION prevent_pdf_intake_metadata_field_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_pdf_intake_metadata_field_consistency() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  result_intake_id uuid;
BEGIN
  SELECT r.intake_id INTO result_intake_id
  FROM pdf_intake_metadata_results r
  WHERE r.project_id = NEW.project_id AND r.id = NEW.result_id;
  IF result_intake_id IS NULL OR result_intake_id IS DISTINCT FROM NEW.intake_id THEN
    RAISE EXCEPTION 'PDF intake metadata field result must belong to the same intake' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER pdf_intake_metadata_fields_consistency_guard
AFTER INSERT ON "pdf_intake_metadata_fields"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_pdf_intake_metadata_field_consistency();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_pdf_intake_resolution_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'PDF intake resolutions are append-only';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER pdf_intake_resolutions_append_only
BEFORE UPDATE OR DELETE ON "pdf_intake_resolutions"
FOR EACH ROW EXECUTE FUNCTION prevent_pdf_intake_resolution_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_pdf_intake_resolution_consistency() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  intake_sha256 text;
  result_intake_id uuid;
  document_paper_id uuid;
  document_sha256 text;
  intake_byte_size bigint;
  document_byte_size bigint;
BEGIN
  SELECT i.sha256, i.byte_size INTO intake_sha256, intake_byte_size
  FROM pdf_intakes i
  WHERE i.project_id = NEW.project_id AND i.id = NEW.intake_id
  FOR UPDATE;
  IF intake_sha256 IS NULL THEN
    RAISE EXCEPTION 'PDF intake resolution must reference a project-owned intake' USING ERRCODE = '23503';
  END IF;

  SELECT r.intake_id INTO result_intake_id
  FROM pdf_intake_metadata_results r
  WHERE r.project_id = NEW.project_id AND r.id = NEW.metadata_result_id;
  IF result_intake_id IS NULL OR result_intake_id IS DISTINCT FROM NEW.intake_id THEN
    RAISE EXCEPTION 'PDF intake resolution metadata result must belong to the same intake' USING ERRCODE = '23514';
  END IF;

  SELECT d.paper_id, d.sha256, d.byte_size INTO document_paper_id, document_sha256, document_byte_size
  FROM full_text_documents d
  WHERE d.project_id = NEW.project_id AND d.id = NEW.full_text_document_id;
  IF document_paper_id IS NULL OR document_paper_id IS DISTINCT FROM NEW.paper_id THEN
    RAISE EXCEPTION 'PDF intake resolution document must belong to the selected Paper' USING ERRCODE = '23514';
  END IF;
  IF document_sha256 IS DISTINCT FROM intake_sha256 THEN
    RAISE EXCEPTION 'PDF intake resolution document hash must match the staged intake hash' USING ERRCODE = '23514';
  END IF;
  IF document_byte_size IS DISTINCT FROM intake_byte_size THEN
    RAISE EXCEPTION 'PDF intake resolution document byte size must match the staged intake size' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER pdf_intake_resolutions_consistency_guard
AFTER INSERT ON "pdf_intake_resolutions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_pdf_intake_resolution_consistency();
