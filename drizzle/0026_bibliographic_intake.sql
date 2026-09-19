-- Slice 27: immutable bibliographic intake and append-only Paper resolution.
-- The import is an audit artifact: its original UTF-8 bytes are retained so
-- record spans can always be checked against the bytes that were parsed.
CREATE TABLE "bibliographic_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "format" text NOT NULL,
  "filename" text NOT NULL,
  "source_bytes" bytea NOT NULL,
  "source_sha256" text NOT NULL,
  "source_byte_size" integer NOT NULL,
  "parser_version" text NOT NULL,
  "adapter_version" text NOT NULL,
  "mapping_version" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "expected_record_count" integer NOT NULL,
  "diagnostics" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "error_code" text,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finalized_at" timestamp with time zone,
  CONSTRAINT "bibliographic_imports_project_id_id_unique" UNIQUE("project_id", "id"),
  CONSTRAINT "bibliographic_imports_project_format_sha256_unique" UNIQUE("project_id", "format", "source_sha256"),
  CONSTRAINT "bibliographic_imports_format_nonblank" CHECK (btrim("format") <> ''),
  CONSTRAINT "bibliographic_imports_format_valid" CHECK ("format" IN ('bibtex', 'ris')),
  CONSTRAINT "bibliographic_imports_filename_nonblank" CHECK (btrim("filename") <> ''),
  CONSTRAINT "bibliographic_imports_filename_length" CHECK (char_length("filename") <= 500),
  CONSTRAINT "bibliographic_imports_source_size_bound" CHECK (octet_length("source_bytes") > 0 AND octet_length("source_bytes") <= 2097152 AND "source_byte_size" = octet_length("source_bytes")),
  CONSTRAINT "bibliographic_imports_version_shape" CHECK (btrim("parser_version") <> '' AND btrim("adapter_version") <> '' AND btrim("mapping_version") <> ''),
  CONSTRAINT "bibliographic_imports_sha256_shape" CHECK ("source_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "bibliographic_imports_status_valid" CHECK ("status" IN ('pending', 'parsing', 'complete', 'parsed', 'failed', 'finalized')),
  CONSTRAINT "bibliographic_imports_record_count_valid" CHECK ("expected_record_count" >= 0 AND "expected_record_count" <= 1000),
  CONSTRAINT "bibliographic_imports_error_shape" CHECK (("status" = 'failed' AND "error_code" IS NOT NULL AND btrim("error_code") <> '') OR ("status" <> 'failed' AND "error_code" IS NULL)),
  CONSTRAINT "bibliographic_imports_error_message_bound" CHECK ("error_message" IS NULL OR char_length("error_message") <= 2000),
  CONSTRAINT "bibliographic_imports_finalization_shape" CHECK (("finalized_at" IS NULL AND "status" NOT IN ('finalized', 'failed')) OR ("finalized_at" IS NOT NULL AND "status" IN ('finalized', 'failed')))
);
--> statement-breakpoint
CREATE TABLE "bibliographic_import_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "import_id" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "source_key" text,
  "source_type" text,
  "title" text,
  "authors" text[] DEFAULT '{}' NOT NULL,
  "abstract" text,
  "doi" text,
  "url" text,
  "publication_year" integer,
  "venue" text,
  "start_byte" integer NOT NULL,
  "end_byte" integer NOT NULL,
  "parse_outcome" text NOT NULL DEFAULT 'parsed',
  "field_states" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "diagnostics" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finalized_at" timestamp with time zone,
  CONSTRAINT "bibliographic_import_records_project_id_id_unique" UNIQUE("project_id", "id"),
  CONSTRAINT "bibliographic_import_records_project_import_ordinal_unique" UNIQUE("project_id", "import_id", "ordinal"),
  CONSTRAINT "bibliographic_import_records_ordinal_valid" CHECK ("ordinal" >= 0),
  CONSTRAINT "bibliographic_import_records_source_key_nonblank" CHECK ("source_key" IS NULL OR btrim("source_key") <> ''),
  CONSTRAINT "bibliographic_import_records_source_type_nonblank" CHECK ("source_type" IS NULL OR btrim("source_type") <> ''),
  CONSTRAINT "bibliographic_import_records_title_nonblank" CHECK (("title" IS NULL AND "parse_outcome" IN ('parsed_with_warnings', 'failed')) OR ("title" IS NOT NULL AND btrim("title") <> '')),
  CONSTRAINT "bibliographic_import_records_year_valid" CHECK ("publication_year" IS NULL OR ("publication_year" >= 1000 AND "publication_year" <= 3000)),
  CONSTRAINT "bibliographic_import_records_venue_nonblank" CHECK ("venue" IS NULL OR btrim("venue") <> ''),
  CONSTRAINT "bibliographic_import_records_span_shape" CHECK ("start_byte" >= 0 AND "end_byte" > "start_byte"),
  CONSTRAINT "bibliographic_import_records_parse_outcome_valid" CHECK ("parse_outcome" IN ('parsed', 'parsed_with_warnings', 'failed')),
  CONSTRAINT "bibliographic_import_records_finalization_shape" CHECK (("finalized_at" IS NULL) OR "parse_outcome" <> 'failed')
);
--> statement-breakpoint
ALTER TABLE "bibliographic_imports" ADD CONSTRAINT "bibliographic_imports_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bibliographic_import_records" ADD CONSTRAINT "bibliographic_import_records_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bibliographic_import_records" ADD CONSTRAINT "bibliographic_import_records_import_fk" FOREIGN KEY ("project_id", "import_id") REFERENCES "public"."bibliographic_imports"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "bibliographic_imports_project_created_at_idx" ON "bibliographic_imports" USING btree ("project_id", "created_at");
--> statement-breakpoint
CREATE INDEX "bibliographic_import_records_project_import_ordinal_idx" ON "bibliographic_import_records" USING btree ("project_id", "import_id", "ordinal");
--> statement-breakpoint
CREATE INDEX "bibliographic_import_records_project_doi_comparison_idx" ON "bibliographic_import_records" USING btree ("project_id", lower(regexp_replace(regexp_replace(btrim("doi"), '^https?://(dx[.])?doi[.]org/', '', 'i'), '^doi:[[:space:]]*', '', 'i'))) WHERE "doi" IS NOT NULL AND btrim("doi") <> '';
--> statement-breakpoint
CREATE INDEX "bibliographic_import_records_project_title_comparison_idx" ON "bibliographic_import_records" USING btree ("project_id", lower(regexp_replace(btrim("title"), '[[:space:]]+', ' ', 'g')), "publication_year");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_bibliographic_import_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Bibliographic import source artifacts are immutable';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'complete' AND NEW.status = 'finalized' AND OLD.finalized_at IS NULL AND NEW.finalized_at IS NOT NULL
      AND OLD.project_id IS NOT DISTINCT FROM NEW.project_id
      AND OLD.format IS NOT DISTINCT FROM NEW.format
      AND OLD.filename IS NOT DISTINCT FROM NEW.filename
      AND OLD.source_bytes IS NOT DISTINCT FROM NEW.source_bytes
      AND OLD.source_sha256 IS NOT DISTINCT FROM NEW.source_sha256
      AND OLD.source_byte_size IS NOT DISTINCT FROM NEW.source_byte_size
      AND OLD.parser_version IS NOT DISTINCT FROM NEW.parser_version
      AND OLD.adapter_version IS NOT DISTINCT FROM NEW.adapter_version
      AND OLD.mapping_version IS NOT DISTINCT FROM NEW.mapping_version
      AND OLD.expected_record_count IS NOT DISTINCT FROM NEW.expected_record_count
      AND OLD.diagnostics IS NOT DISTINCT FROM NEW.diagnostics
      AND OLD.error_code IS NOT DISTINCT FROM NEW.error_code
      AND OLD.error_message IS NOT DISTINCT FROM NEW.error_message
      AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Bibliographic import source artifacts are immutable';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER bibliographic_imports_immutable_after_finalization
BEFORE UPDATE OR DELETE ON "bibliographic_imports"
FOR EACH ROW EXECUTE FUNCTION prevent_bibliographic_import_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_bibliographic_import_finalization() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  record_count integer;
  minimum_ordinal integer;
  maximum_ordinal integer;
  distinct_ordinal_count integer;
BEGIN
  IF NEW.finalized_at IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*)::integer, min(ordinal), max(ordinal), count(DISTINCT ordinal)::integer
    INTO record_count, minimum_ordinal, maximum_ordinal, distinct_ordinal_count
  FROM bibliographic_import_records
  WHERE project_id = NEW.project_id AND import_id = NEW.id;
  IF record_count <> NEW.expected_record_count THEN
    RAISE EXCEPTION 'Bibliographic import finalization record count does not match expected_record_count' USING ERRCODE = '23514';
  END IF;
  IF record_count > 0 AND (minimum_ordinal <> 1 OR maximum_ordinal <> record_count OR distinct_ordinal_count <> record_count) THEN
    RAISE EXCEPTION 'Bibliographic import record ordinals must be contiguous from one at finalization' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER bibliographic_imports_finalization_guard
BEFORE INSERT OR UPDATE OF finalized_at, status, expected_record_count ON "bibliographic_imports"
FOR EACH ROW EXECUTE FUNCTION validate_bibliographic_import_finalization();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_bibliographic_import_record_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  import_finalized_at timestamptz;
BEGIN
  SELECT finalized_at INTO import_finalized_at
  FROM bibliographic_imports
  WHERE project_id = OLD.project_id AND id = OLD.import_id;
  IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' OR import_finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'Bibliographic import source records are immutable';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER bibliographic_import_records_immutable_after_finalization
BEFORE UPDATE OR DELETE ON "bibliographic_import_records"
FOR EACH ROW EXECUTE FUNCTION prevent_bibliographic_import_record_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_bibliographic_import_record_span() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  source_length integer;
BEGIN
  SELECT octet_length(source_bytes) INTO source_length
  FROM bibliographic_imports
  WHERE project_id = NEW.project_id AND id = NEW.import_id;
  IF source_length IS NULL THEN
    RAISE EXCEPTION 'Bibliographic import record must belong to a project-owned import' USING ERRCODE = '23503';
  END IF;
  IF NEW.start_byte < 0 OR NEW.end_byte <= NEW.start_byte OR NEW.end_byte > source_length THEN
    RAISE EXCEPTION 'Bibliographic import record byte span must lie within the original source bytes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER bibliographic_import_records_source_span_guard
BEFORE INSERT OR UPDATE ON "bibliographic_import_records"
FOR EACH ROW EXECUTE FUNCTION validate_bibliographic_import_record_span();
--> statement-breakpoint
CREATE TABLE "bibliographic_import_resolutions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sequence" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "project_id" uuid NOT NULL,
  "import_id" uuid NOT NULL,
  "record_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "paper_id" uuid,
  "expected_previous_resolution_id" uuid,
  "creation_payload" jsonb,
  "candidate_paper_id" uuid,
  "candidate_rank" integer,
  "candidate_reason" text,
  "candidate_doi" text,
  "candidate_title" text,
  "candidate_publication_year" integer,
  "candidate_venue" text,
  "candidate_context" jsonb,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bibliographic_import_resolutions_project_id_id_unique" UNIQUE("project_id", "id"),
  CONSTRAINT "bibliographic_import_resolutions_event_type_valid" CHECK ("event_type" IN ('created_paper', 'matched_paper', 'cleared')),
  CONSTRAINT "bibliographic_import_resolutions_paper_shape" CHECK (("event_type" IN ('created_paper', 'matched_paper') AND "paper_id" IS NOT NULL) OR ("event_type" = 'cleared' AND "paper_id" IS NULL)),
  CONSTRAINT "bibliographic_import_resolutions_creation_payload_shape" CHECK (("event_type" = 'created_paper' AND "creation_payload" IS NOT NULL) OR ("event_type" <> 'created_paper' AND "creation_payload" IS NULL)),
  CONSTRAINT "bibliographic_import_resolutions_candidate_rank_valid" CHECK ("candidate_rank" IS NULL OR "candidate_rank" > 0),
  CONSTRAINT "bibliographic_import_resolutions_candidate_reason_shape" CHECK ("candidate_reason" IS NULL OR (btrim("candidate_reason") <> '' AND char_length("candidate_reason") <= 1000)),
  CONSTRAINT "bibliographic_import_resolutions_candidate_year_valid" CHECK ("candidate_publication_year" IS NULL OR ("candidate_publication_year" >= 1000 AND "candidate_publication_year" <= 3000)),
  CONSTRAINT "bibliographic_import_resolutions_note_shape" CHECK ("note" IS NULL OR (btrim("note") <> '' AND char_length("note") <= 2000))
);
--> statement-breakpoint
ALTER TABLE "bibliographic_import_resolutions" ADD CONSTRAINT "bibliographic_import_resolutions_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bibliographic_import_resolutions" ADD CONSTRAINT "bibliographic_import_resolutions_record_fk" FOREIGN KEY ("project_id", "record_id") REFERENCES "public"."bibliographic_import_records"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bibliographic_import_resolutions" ADD CONSTRAINT "bibliographic_import_resolutions_import_fk" FOREIGN KEY ("project_id", "import_id") REFERENCES "public"."bibliographic_imports"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bibliographic_import_resolutions" ADD CONSTRAINT "bibliographic_import_resolutions_paper_fk" FOREIGN KEY ("project_id", "paper_id") REFERENCES "public"."papers"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bibliographic_import_resolutions" ADD CONSTRAINT "bibliographic_import_resolutions_candidate_paper_fk" FOREIGN KEY ("project_id", "candidate_paper_id") REFERENCES "public"."papers"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bibliographic_import_resolutions" ADD CONSTRAINT "bibliographic_import_resolutions_expected_previous_fk" FOREIGN KEY ("project_id", "expected_previous_resolution_id") REFERENCES "public"."bibliographic_import_resolutions"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "bibliographic_import_resolutions_project_record_sequence_idx" ON "bibliographic_import_resolutions" USING btree ("project_id", "record_id", "sequence");
--> statement-breakpoint
CREATE INDEX "bibliographic_import_resolutions_project_import_sequence_idx" ON "bibliographic_import_resolutions" USING btree ("project_id", "import_id", "sequence");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_bibliographic_import_resolution_context() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  record_import_id uuid;
  record_parse_outcome text;
  import_finalized_at timestamptz;
BEGIN
  SELECT r.import_id, r.parse_outcome, i.finalized_at
    INTO record_import_id, record_parse_outcome, import_finalized_at
  FROM bibliographic_import_records r
  JOIN bibliographic_imports i ON i.project_id = r.project_id AND i.id = r.import_id
  WHERE r.project_id = NEW.project_id AND r.id = NEW.record_id;
  IF record_import_id IS NULL OR record_import_id IS DISTINCT FROM NEW.import_id THEN
    RAISE EXCEPTION 'Bibliographic resolution import and record must share the same project-owned import' USING ERRCODE = '23514';
  END IF;
  IF import_finalized_at IS NULL THEN
    RAISE EXCEPTION 'Bibliographic resolutions require a finalized import' USING ERRCODE = '23514';
  END IF;
  IF record_parse_outcome = 'failed' THEN
    RAISE EXCEPTION 'Failed bibliographic records cannot be resolved' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER bibliographic_import_resolutions_context_guard
BEFORE INSERT ON "bibliographic_import_resolutions"
FOR EACH ROW EXECUTE FUNCTION validate_bibliographic_import_resolution_context();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_bibliographic_import_resolution_transition() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  current_id uuid;
BEGIN
  -- Serialize direct SQL writers on the same immutable source record. The
  -- application service takes this lock before inserting as well, but keeping
  -- the invariant here prevents two concurrent appenders from both observing
  -- the same predecessor when the table is used outside that service.
  PERFORM 1
  FROM bibliographic_import_records
  WHERE project_id = NEW.project_id AND id = NEW.record_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bibliographic resolution record does not belong to this project' USING ERRCODE = '23503';
  END IF;

  SELECT r.id INTO current_id
  FROM bibliographic_import_resolutions r
  WHERE r.project_id = NEW.project_id AND r.record_id = NEW.record_id
  ORDER BY r.sequence DESC, r.id DESC LIMIT 1;
  IF NEW.expected_previous_resolution_id IS DISTINCT FROM current_id THEN
    RAISE EXCEPTION 'Bibliographic resolution expected predecessor does not match current record state' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER bibliographic_import_resolutions_transition_guard
BEFORE INSERT ON "bibliographic_import_resolutions"
FOR EACH ROW EXECUTE FUNCTION validate_bibliographic_import_resolution_transition();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_bibliographic_import_resolution_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'Bibliographic import resolutions are append-only';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER bibliographic_import_resolutions_append_only
BEFORE UPDATE OR DELETE ON "bibliographic_import_resolutions"
FOR EACH ROW EXECUTE FUNCTION prevent_bibliographic_import_resolution_mutation();
