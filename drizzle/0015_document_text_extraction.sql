CREATE TABLE "document_text_extractions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sequence" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "project_id" uuid NOT NULL,
  "paper_id" uuid NOT NULL,
  "full_text_document_id" uuid NOT NULL,
  "extractor_key" text NOT NULL,
  "extractor_version" text NOT NULL,
  "algorithm_version" text NOT NULL,
  "status" text NOT NULL,
  "page_count" integer,
  "character_count" integer,
  "error_code" text,
  "error_message" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_text_extractions_project_id_id_unique" UNIQUE("project_id", "id"),
  CONSTRAINT "document_text_extractions_project_paper_id_id_unique" UNIQUE("project_id", "paper_id", "id"),
  CONSTRAINT "document_text_extractions_extractor_key_nonblank" CHECK (btrim("extractor_key") <> ''),
  CONSTRAINT "document_text_extractions_extractor_version_nonblank" CHECK (btrim("extractor_version") <> ''),
  CONSTRAINT "document_text_extractions_algorithm_version_nonblank" CHECK (btrim("algorithm_version") <> ''),
  CONSTRAINT "document_text_extractions_status_valid" CHECK ("status" in ('succeeded', 'partial', 'failed')),
  CONSTRAINT "document_text_extractions_page_count_shape" CHECK (
    (("status" in ('succeeded', 'partial') and "page_count" is not null and "page_count" > 0 and "page_count" <= 2000)
      or ("status" = 'failed' and ("page_count" is null or ("page_count" > 0 and "page_count" <= 2000))))
  ),
  CONSTRAINT "document_text_extractions_character_count_shape" CHECK (
    (("status" in ('succeeded', 'partial') and "character_count" is not null and "character_count" >= 0 and "character_count" <= 10000000)
      or ("status" = 'failed' and "character_count" is null))
  ),
  CONSTRAINT "document_text_extractions_error_code_nonblank" CHECK ("error_code" is null or btrim("error_code") <> ''),
  CONSTRAINT "document_text_extractions_error_message_limit" CHECK ("error_message" is null or char_length("error_message") <= 1000),
  CONSTRAINT "document_text_extractions_times_ordered" CHECK ("completed_at" is null or "started_at" is null or "completed_at" >= "started_at")
);
--> statement-breakpoint
ALTER TABLE "document_text_extractions"
  ADD CONSTRAINT "document_text_extractions_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_text_extractions"
  ADD CONSTRAINT "document_text_extractions_project_paper_fk"
  FOREIGN KEY ("project_id", "paper_id") REFERENCES "public"."papers"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_text_extractions"
  ADD CONSTRAINT "document_text_extractions_project_paper_document_fk"
  FOREIGN KEY ("project_id", "paper_id", "full_text_document_id") REFERENCES "public"."full_text_documents"("project_id", "paper_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "document_text_extractions_project_document_sequence_idx"
  ON "document_text_extractions" USING btree ("project_id", "full_text_document_id", "sequence");
--> statement-breakpoint
CREATE INDEX "document_text_extractions_project_paper_sequence_idx"
  ON "document_text_extractions" USING btree ("project_id", "paper_id", "sequence");
--> statement-breakpoint
CREATE TABLE "document_text_extraction_pages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "paper_id" uuid NOT NULL,
  "document_text_extraction_id" uuid NOT NULL,
  "page_number" integer NOT NULL,
  "status" text NOT NULL,
  "text" text NOT NULL,
  "character_count" integer NOT NULL,
  "error_code" text,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_text_extraction_pages_project_id_id_unique" UNIQUE("project_id", "id"),
  CONSTRAINT "document_text_extraction_pages_project_paper_extraction_page_unique" UNIQUE("project_id", "paper_id", "document_text_extraction_id", "page_number"),
  CONSTRAINT "document_text_extraction_pages_page_positive" CHECK ("page_number" > 0 and "page_number" <= 2000),
  CONSTRAINT "document_text_extraction_pages_status_valid" CHECK ("status" in ('succeeded', 'failed')),
  CONSTRAINT "document_text_extraction_pages_text_normalized" CHECK ("text" !~ E'\\r'),
  CONSTRAINT "document_text_extraction_pages_character_count_shape" CHECK ("character_count" = char_length("text") and "character_count" >= 0 and "character_count" <= 500000),
  CONSTRAINT "document_text_extraction_pages_failed_placeholder_shape" CHECK (
    (("status" = 'succeeded' and "error_code" is null and "error_message" is null)
      or ("status" = 'failed' and "text" = '' and "character_count" = 0 and "error_code" is not null and btrim("error_code") <> ''))
  ),
  CONSTRAINT "document_text_extraction_pages_error_message_limit" CHECK ("error_message" is null or char_length("error_message") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "document_text_extraction_pages"
  ADD CONSTRAINT "document_text_extraction_pages_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_text_extraction_pages"
  ADD CONSTRAINT "document_text_extraction_pages_project_paper_fk"
  FOREIGN KEY ("project_id", "paper_id") REFERENCES "public"."papers"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_text_extraction_pages"
  ADD CONSTRAINT "document_text_extraction_pages_project_paper_extraction_fk"
  FOREIGN KEY ("project_id", "paper_id", "document_text_extraction_id") REFERENCES "public"."document_text_extractions"("project_id", "paper_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "document_text_extraction_id" uuid;
--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "extraction_start_offset" integer;
--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "extraction_end_offset" integer;
--> statement-breakpoint
ALTER TABLE "evidence"
  ADD CONSTRAINT "evidence_project_paper_extraction_fk"
  FOREIGN KEY ("project_id", "paper_id", "document_text_extraction_id") REFERENCES "public"."document_text_extractions"("project_id", "paper_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evidence"
  ADD CONSTRAINT "evidence_project_paper_extraction_page_fk"
  FOREIGN KEY ("project_id", "paper_id", "document_text_extraction_id", "page_number") REFERENCES "public"."document_text_extraction_pages"("project_id", "paper_id", "document_text_extraction_id", "page_number") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evidence"
  ADD CONSTRAINT "evidence_extraction_offset_nonnegative" CHECK (
    ("extraction_start_offset" is null and "extraction_end_offset" is null)
    or ("extraction_start_offset" is not null and "extraction_end_offset" is not null and "extraction_start_offset" >= 0 and "extraction_end_offset" > "extraction_start_offset")
  );
--> statement-breakpoint
CREATE FUNCTION prevent_document_text_extraction_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'document text extraction artifacts are immutable';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER document_text_extractions_immutable
BEFORE UPDATE OR DELETE ON document_text_extractions
FOR EACH ROW EXECUTE FUNCTION prevent_document_text_extraction_mutation();
--> statement-breakpoint
CREATE FUNCTION prevent_document_text_extraction_page_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'document text extraction page artifacts are immutable';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER document_text_extraction_pages_immutable
BEFORE UPDATE OR DELETE ON document_text_extraction_pages
FOR EACH ROW EXECUTE FUNCTION prevent_document_text_extraction_page_mutation();
--> statement-breakpoint
CREATE FUNCTION validate_document_text_extraction_document() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  document_archived_at timestamptz;
BEGIN
  SELECT archived_at INTO document_archived_at
  FROM full_text_documents
  WHERE project_id = NEW.project_id
    AND paper_id = NEW.paper_id
    AND id = NEW.full_text_document_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'full-text document does not belong to the extraction paper';
  END IF;
  IF document_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'new extraction cannot reference an archived full-text document';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER document_text_extractions_active_document
BEFORE INSERT ON document_text_extractions
FOR EACH ROW EXECUTE FUNCTION validate_document_text_extraction_document();
--> statement-breakpoint
CREATE FUNCTION validate_document_text_extraction_terminal_shape(target_extraction_id uuid) RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  extraction_status text;
  extraction_page_count integer;
  extraction_character_count integer;
  row_count integer;
  succeeded_count integer;
  failed_count integer;
  minimum_page integer;
  maximum_page integer;
  summed_character_count integer;
BEGIN
  SELECT status, page_count, character_count
    INTO extraction_status, extraction_page_count, extraction_character_count
  FROM document_text_extractions
  WHERE id = target_extraction_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*)::integer,
         count(*) FILTER (WHERE status = 'succeeded')::integer,
         count(*) FILTER (WHERE status = 'failed')::integer,
         min(page_number), max(page_number), coalesce(sum(character_count), 0)::integer
    INTO row_count, succeeded_count, failed_count, minimum_page, maximum_page, summed_character_count
  FROM document_text_extraction_pages
  WHERE document_text_extraction_id = target_extraction_id;

  IF extraction_status = 'failed' THEN
    IF row_count <> 0 THEN
      RAISE EXCEPTION 'failed extraction must not retain page rows';
    END IF;
    RETURN;
  END IF;

  IF extraction_page_count IS NULL OR extraction_page_count <= 0 THEN
    RAISE EXCEPTION 'successful or partial extraction must declare a positive page count';
  END IF;
  IF row_count <> extraction_page_count
    OR minimum_page <> 1
    OR maximum_page <> extraction_page_count
    OR extraction_character_count IS DISTINCT FROM summed_character_count THEN
    RAISE EXCEPTION 'extraction page rows do not match the terminal extraction snapshot';
  END IF;
  IF extraction_status = 'succeeded' AND failed_count <> 0 THEN
    RAISE EXCEPTION 'succeeded extraction cannot contain failed page rows';
  END IF;
  IF extraction_status = 'partial' AND (succeeded_count = 0 OR failed_count = 0) THEN
    RAISE EXCEPTION 'partial extraction must contain both succeeded and failed page rows';
  END IF;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION validate_document_text_extraction_terminal_shape_trigger() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM validate_document_text_extraction_terminal_shape(NEW.id);
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION validate_document_text_extraction_page_terminal_shape_trigger() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM validate_document_text_extraction_terminal_shape(NEW.document_text_extraction_id);
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER document_text_extractions_terminal_shape
AFTER INSERT ON document_text_extractions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_document_text_extraction_terminal_shape_trigger();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER document_text_extraction_pages_terminal_shape
AFTER INSERT ON document_text_extraction_pages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_document_text_extraction_page_terminal_shape_trigger();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_evidence_document_retargeting() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.paper_id IS DISTINCT FROM OLD.paper_id
    OR NEW.full_text_document_id IS DISTINCT FROM OLD.full_text_document_id
    OR NEW.document_text_extraction_id IS DISTINCT FROM OLD.document_text_extraction_id
    OR NEW.extraction_start_offset IS DISTINCT FROM OLD.extraction_start_offset
    OR NEW.extraction_end_offset IS DISTINCT FROM OLD.extraction_end_offset
    OR (OLD.document_text_extraction_id IS NOT NULL AND NEW.page_number IS DISTINCT FROM OLD.page_number)
    OR (OLD.document_text_extraction_id IS NOT NULL AND NEW.source_text IS DISTINCT FROM OLD.source_text)
  ) THEN
    RAISE EXCEPTION 'Evidence document or extraction provenance is immutable';
  END IF;
  IF NEW.full_text_document_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM full_text_documents doc
    WHERE doc.project_id = NEW.project_id
      AND doc.paper_id = NEW.paper_id
      AND doc.id = NEW.full_text_document_id
      AND doc.archived_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'new Evidence cannot reference an archived full-text document';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION validate_evidence_extraction_provenance() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  extraction_document_id uuid;
  page_status text;
  page_text text;
  extracted_text text;
BEGIN
  IF NEW.document_text_extraction_id IS NULL THEN
    IF NEW.extraction_start_offset IS NOT NULL OR NEW.extraction_end_offset IS NOT NULL THEN
      RAISE EXCEPTION 'Evidence offsets require extraction provenance';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.full_text_document_id IS NULL
    OR NEW.extraction_start_offset IS NULL
    OR NEW.extraction_end_offset IS NULL THEN
    RAISE EXCEPTION 'extraction-grounded Evidence requires document and both offsets';
  END IF;
  SELECT full_text_document_id INTO extraction_document_id
  FROM document_text_extractions
  WHERE project_id = NEW.project_id
    AND paper_id = NEW.paper_id
    AND id = NEW.document_text_extraction_id;
  IF NOT FOUND OR extraction_document_id IS DISTINCT FROM NEW.full_text_document_id THEN
    RAISE EXCEPTION 'Evidence extraction does not belong to its document and Paper';
  END IF;

  SELECT status, text INTO page_status, page_text
  FROM document_text_extraction_pages
  WHERE project_id = NEW.project_id
    AND paper_id = NEW.paper_id
    AND document_text_extraction_id = NEW.document_text_extraction_id
    AND page_number = NEW.page_number;
  IF NOT FOUND OR page_status <> 'succeeded' THEN
    RAISE EXCEPTION 'extraction-grounded Evidence requires a successful extracted page';
  END IF;
  IF NEW.extraction_start_offset < 0
    OR NEW.extraction_end_offset <= NEW.extraction_start_offset
    OR NEW.extraction_end_offset > char_length(page_text) THEN
    RAISE EXCEPTION 'Evidence offsets are outside the extracted page text';
  END IF;
  extracted_text := substring(page_text FROM NEW.extraction_start_offset + 1 FOR NEW.extraction_end_offset - NEW.extraction_start_offset);
  IF extracted_text IS DISTINCT FROM NEW.source_text THEN
    RAISE EXCEPTION 'Evidence source text does not match the extracted page substring';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER evidence_extraction_provenance_guard
BEFORE INSERT OR UPDATE ON evidence
FOR EACH ROW EXECUTE FUNCTION validate_evidence_extraction_provenance();
