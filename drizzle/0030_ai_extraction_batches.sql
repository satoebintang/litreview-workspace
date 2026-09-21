CREATE TABLE "ai_extraction_batch_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"item_ordinal" integer NOT NULL,
	"paper_id" uuid NOT NULL,
	"extraction_field_id" uuid NOT NULL,
	"expected_current_extraction_revision_id" uuid,
	"title_abstract_decision_id" uuid,
	"full_text_decision_id" uuid,
	"full_text_document_id" uuid,
	"document_text_extraction_id" uuid,
	"initial_disposition" text NOT NULL,
	"initial_reason_code" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"expected_request_intent_hash" text,
	"field_definition_hash" text NOT NULL,
	"option_snapshot_hash" text NOT NULL,
	"paper_title_snapshot" text NOT NULL,
	"paper_abstract_snapshot" text,
	"field_name_snapshot" text NOT NULL,
	"field_description_snapshot" text,
	"field_type_snapshot" text NOT NULL,
	"field_required_snapshot" boolean NOT NULL,
	"field_option_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"document_filename_snapshot" text,
	"extraction_sequence_snapshot" bigint,
	"extraction_status_snapshot" text,
	"page_manifest" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"page_manifest_hash" text NOT NULL,
	"page_count" integer NOT NULL,
	"source_character_count" integer NOT NULL,
	"source_byte_size" integer NOT NULL,
	"item_manifest_hash" text NOT NULL,
	"ai_extraction_request_id" uuid,
	"request_relationship" text,
	"orchestration_terminal_code" text,
	"orchestration_terminal_detail" text,
	"orchestration_finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_extraction_batch_items_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "ai_extraction_batch_items_project_batch_ordinal_unique" UNIQUE("project_id","batch_id","item_ordinal"),
	CONSTRAINT "ai_extraction_batch_items_project_batch_paper_field_unique" UNIQUE("project_id","batch_id","paper_id","extraction_field_id"),
	CONSTRAINT "ai_extraction_batch_items_project_batch_idempotency_unique" UNIQUE("project_id","batch_id","idempotency_key"),
	CONSTRAINT "ai_extraction_batch_items_ordinal_valid" CHECK ("ai_extraction_batch_items"."item_ordinal" >= 0 and "ai_extraction_batch_items"."item_ordinal" < 500),
	CONSTRAINT "ai_extraction_batch_items_disposition_valid" CHECK ("ai_extraction_batch_items"."initial_disposition" in ('executable', 'reusable', 'blocked', 'ineligible')),
	CONSTRAINT "ai_extraction_batch_items_reason_shape" CHECK (btrim("ai_extraction_batch_items"."initial_reason_code") <> '' and char_length("ai_extraction_batch_items"."initial_reason_code") <= 100),
	CONSTRAINT "ai_extraction_batch_items_field_type_valid" CHECK ("ai_extraction_batch_items"."field_type_snapshot" in ('short_text', 'long_text', 'number', 'boolean', 'single_select')),
	CONSTRAINT "ai_extraction_batch_items_hash_shape" CHECK ("ai_extraction_batch_items"."field_definition_hash" ~ '^[0-9a-f]{64}$' and "ai_extraction_batch_items"."option_snapshot_hash" ~ '^[0-9a-f]{64}$' and "ai_extraction_batch_items"."page_manifest_hash" ~ '^[0-9a-f]{64}$' and "ai_extraction_batch_items"."item_manifest_hash" ~ '^[0-9a-f]{64}$' and ("ai_extraction_batch_items"."expected_request_intent_hash" is null or "ai_extraction_batch_items"."expected_request_intent_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "ai_extraction_batch_items_page_manifest_array" CHECK (jsonb_typeof("ai_extraction_batch_items"."page_manifest") = 'array'),
	CONSTRAINT "ai_extraction_batch_items_page_count_bounds" CHECK ("ai_extraction_batch_items"."page_count" >= 0 and "ai_extraction_batch_items"."page_count" <= 40),
	CONSTRAINT "ai_extraction_batch_items_source_count_bounds" CHECK ("ai_extraction_batch_items"."source_character_count" >= 0 and "ai_extraction_batch_items"."source_character_count" <= 80000 and "ai_extraction_batch_items"."source_byte_size" >= 0 and "ai_extraction_batch_items"."source_byte_size" <= 327680),
	CONSTRAINT "ai_extraction_batch_items_source_identity_shape" CHECK ((
      ("ai_extraction_batch_items"."initial_disposition" in ('executable', 'reusable') and "ai_extraction_batch_items"."full_text_document_id" is not null and "ai_extraction_batch_items"."document_text_extraction_id" is not null and "ai_extraction_batch_items"."extraction_sequence_snapshot" is not null and "ai_extraction_batch_items"."extraction_status_snapshot" is not null and "ai_extraction_batch_items"."page_count" > 0 and "ai_extraction_batch_items"."source_character_count" > 0 and "ai_extraction_batch_items"."source_byte_size" > 0)
      or "ai_extraction_batch_items"."initial_disposition" in ('blocked', 'ineligible')
    )),
	CONSTRAINT "ai_extraction_batch_items_request_relationship_valid" CHECK ("ai_extraction_batch_items"."request_relationship" is null or "ai_extraction_batch_items"."request_relationship" in ('authoritative', 'blocking')),
	CONSTRAINT "ai_extraction_batch_items_request_link_shape" CHECK (("ai_extraction_batch_items"."ai_extraction_request_id" is null and "ai_extraction_batch_items"."request_relationship" is null) or ("ai_extraction_batch_items"."ai_extraction_request_id" is not null and "ai_extraction_batch_items"."request_relationship" is not null)),
	CONSTRAINT "ai_extraction_batch_items_terminal_shape" CHECK (("ai_extraction_batch_items"."orchestration_terminal_code" is null and "ai_extraction_batch_items"."orchestration_finalized_at" is null) or ("ai_extraction_batch_items"."orchestration_terminal_code" is not null and "ai_extraction_batch_items"."orchestration_finalized_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "ai_extraction_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text DEFAULT 'openai' NOT NULL,
	"configured_model" text NOT NULL,
	"configured_reasoning_effort" text DEFAULT 'low' NOT NULL,
	"selection_policy_version" text NOT NULL,
	"batch_disclosure_version" text NOT NULL,
	"request_disclosure_version" text NOT NULL,
	"external_transmission_acknowledged" boolean NOT NULL,
	"paper_count" integer NOT NULL,
	"field_count" integer NOT NULL,
	"cell_count" integer NOT NULL,
	"executable_count" integer NOT NULL,
	"manifest_algorithm_version" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "ai_extraction_batches_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "ai_extraction_batches_provider_valid" CHECK ("ai_extraction_batches"."provider" = 'openai'),
	CONSTRAINT "ai_extraction_batches_model_shape" CHECK (btrim("ai_extraction_batches"."configured_model") <> '' and char_length("ai_extraction_batches"."configured_model") <= 200),
	CONSTRAINT "ai_extraction_batches_reasoning_valid" CHECK ("ai_extraction_batches"."configured_reasoning_effort" = 'low'),
	CONSTRAINT "ai_extraction_batches_version_shape" CHECK (btrim("ai_extraction_batches"."selection_policy_version") <> '' and btrim("ai_extraction_batches"."batch_disclosure_version") <> '' and btrim("ai_extraction_batches"."request_disclosure_version") <> '' and btrim("ai_extraction_batches"."manifest_algorithm_version") <> ''),
	CONSTRAINT "ai_extraction_batches_transmission_acknowledged" CHECK ("ai_extraction_batches"."external_transmission_acknowledged" = true),
	CONSTRAINT "ai_extraction_batches_count_bounds" CHECK ("ai_extraction_batches"."paper_count" >= 1 and "ai_extraction_batches"."paper_count" <= 100 and "ai_extraction_batches"."field_count" >= 1 and "ai_extraction_batches"."field_count" <= 25 and "ai_extraction_batches"."cell_count" >= 1 and "ai_extraction_batches"."cell_count" <= 500 and "ai_extraction_batches"."executable_count" >= 0 and "ai_extraction_batches"."executable_count" <= "ai_extraction_batches"."cell_count"),
	CONSTRAINT "ai_extraction_batches_manifest_hash_shape" CHECK ("ai_extraction_batches"."manifest_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "ai_extraction_batch_items" ADD CONSTRAINT "ai_extraction_batch_items_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_batch_items" ADD CONSTRAINT "ai_extraction_batch_items_batch_fk" FOREIGN KEY ("project_id","batch_id") REFERENCES "public"."ai_extraction_batches"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_batch_items" ADD CONSTRAINT "ai_extraction_batch_items_paper_fk" FOREIGN KEY ("project_id","paper_id") REFERENCES "public"."papers"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_batch_items" ADD CONSTRAINT "ai_extraction_batch_items_field_fk" FOREIGN KEY ("project_id","extraction_field_id") REFERENCES "public"."extraction_fields"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_batch_items" ADD CONSTRAINT "ai_extraction_batch_items_document_fk" FOREIGN KEY ("project_id","paper_id","full_text_document_id") REFERENCES "public"."full_text_documents"("project_id","paper_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_batch_items" ADD CONSTRAINT "ai_extraction_batch_items_extraction_fk" FOREIGN KEY ("project_id","paper_id","document_text_extraction_id") REFERENCES "public"."document_text_extractions"("project_id","paper_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_batch_items" ADD CONSTRAINT "ai_extraction_batch_items_baseline_revision_fk" FOREIGN KEY ("project_id","expected_current_extraction_revision_id") REFERENCES "public"."extraction_value_revisions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_batch_items" ADD CONSTRAINT "ai_extraction_batch_items_request_fk" FOREIGN KEY ("project_id","ai_extraction_request_id") REFERENCES "public"."ai_extraction_requests"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_batch_items" ADD CONSTRAINT "ai_extraction_batch_items_title_abstract_decision_fk" FOREIGN KEY ("project_id","title_abstract_decision_id") REFERENCES "public"."screening_decisions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_batch_items" ADD CONSTRAINT "ai_extraction_batch_items_full_text_decision_fk" FOREIGN KEY ("project_id","full_text_decision_id") REFERENCES "public"."full_text_screening_decisions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extraction_batches" ADD CONSTRAINT "ai_extraction_batches_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_extraction_batch_items_project_batch_ordinal_idx" ON "ai_extraction_batch_items" USING btree ("project_id","batch_id","item_ordinal");--> statement-breakpoint
CREATE INDEX "ai_extraction_batch_items_project_paper_idx" ON "ai_extraction_batch_items" USING btree ("project_id","paper_id","item_ordinal");--> statement-breakpoint
CREATE INDEX "ai_extraction_batches_project_created_at_idx" ON "ai_extraction_batches" USING btree ("project_id","created_at");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ai_extraction_batch_scalar_text(p_value text) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE
AS $function$
DECLARE
  payload bytea;
BEGIN
  IF p_value IS NULL THEN
    payload := decode('00', 'hex');
  ELSE
    payload := decode('01', 'hex') || convert_to(p_value, 'UTF8');
  END IF;
  RETURN int4send(octet_length(payload)) || payload;
END;
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ai_extraction_batch_scalar_boolean(p_value boolean) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE
AS $function$
DECLARE
  payload bytea;
BEGIN
  IF p_value IS NULL THEN
    RETURN ai_extraction_batch_scalar_text(NULL);
  END IF;
  payload := decode('02', 'hex') || convert_to(CASE WHEN p_value THEN 'true' ELSE 'false' END, 'UTF8');
  RETURN int4send(octet_length(payload)) || payload;
END;
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ai_extraction_batch_scalar_integer(p_value bigint) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE
AS $function$
DECLARE
  payload bytea;
BEGIN
  IF p_value IS NULL THEN
    RETURN ai_extraction_batch_scalar_text(NULL);
  END IF;
  payload := decode('03', 'hex') || convert_to(p_value::text, 'UTF8');
  RETURN int4send(octet_length(payload)) || payload;
END;
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ai_extraction_batch_option_snapshot_hash(p_options jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $function$
DECLARE
  payload bytea := ''::bytea;
  option_row jsonb;
  option_count integer;
BEGIN
  SELECT count(*)::integer INTO option_count
  FROM jsonb_array_elements(coalesce(p_options, '[]'::jsonb)) AS option_element(value)
  WHERE option_element.value->>'archivedAt' IS NULL;
  payload := payload || ai_extraction_batch_scalar_text('ai-extraction-batch-domain-v1');
  payload := payload || ai_extraction_batch_scalar_integer(option_count);
  FOR option_row IN
    SELECT option_element.value
    FROM jsonb_array_elements(coalesce(p_options, '[]'::jsonb)) AS option_element(value)
    WHERE option_element.value->>'archivedAt' IS NULL
    ORDER BY (option_element.value->>'sortOrder')::bigint, lower(option_element.value->>'id')
  LOOP
    payload := payload || ai_extraction_batch_scalar_text(lower(option_row->>'id'));
    payload := payload || ai_extraction_batch_scalar_text(option_row->>'label');
    payload := payload || ai_extraction_batch_scalar_integer((option_row->>'sortOrder')::bigint);
  END LOOP;
  RETURN encode(sha256(payload), 'hex');
END;
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ai_extraction_batch_page_manifest_hash(p_item ai_extraction_batch_items) RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $function$
DECLARE
  payload bytea := ''::bytea;
  page_row jsonb;
  page_count integer;
  character_count integer;
  byte_size integer;
BEGIN
  page_count := jsonb_array_length(coalesce(p_item.page_manifest, '[]'::jsonb));
  IF page_count = 0 THEN
    payload := payload || ai_extraction_batch_scalar_text('ai-extraction-batch-domain-v1');
    payload := payload || ai_extraction_batch_scalar_text(NULL);
    payload := payload || ai_extraction_batch_scalar_text(NULL);
    payload := payload || ai_extraction_batch_scalar_integer(0);
    payload := payload || ai_extraction_batch_scalar_integer(0);
    payload := payload || ai_extraction_batch_scalar_integer(0);
    RETURN encode(sha256(payload), 'hex');
  END IF;
  SELECT coalesce(sum((value->>'characterCount')::integer), 0), coalesce(sum((value->>'byteSize')::integer), 0)
    INTO character_count, byte_size
  FROM jsonb_array_elements(p_item.page_manifest);
  payload := payload || ai_extraction_batch_scalar_text('ai-extraction-batch-domain-v1');
  payload := payload || ai_extraction_batch_scalar_text(lower(p_item.paper_id::text));
  payload := payload || ai_extraction_batch_scalar_text(CASE WHEN p_item.document_text_extraction_id IS NULL THEN NULL ELSE lower(p_item.document_text_extraction_id::text) END);
  payload := payload || ai_extraction_batch_scalar_integer(page_count);
  payload := payload || ai_extraction_batch_scalar_integer(character_count);
  payload := payload || ai_extraction_batch_scalar_integer(byte_size);
  FOR page_row IN
    SELECT value
    FROM jsonb_array_elements(p_item.page_manifest)
    ORDER BY (value->>'pageOrdinal')::integer, lower(value->>'pageId')
  LOOP
    payload := payload || ai_extraction_batch_scalar_text(lower(page_row->>'pageId'));
    payload := payload || ai_extraction_batch_scalar_integer((page_row->>'pageNumber')::bigint);
    payload := payload || ai_extraction_batch_scalar_integer((page_row->>'pageOrdinal')::bigint);
    payload := payload || ai_extraction_batch_scalar_text(page_row->>'textSha256');
    payload := payload || ai_extraction_batch_scalar_integer((page_row->>'characterCount')::bigint);
    payload := payload || ai_extraction_batch_scalar_integer((page_row->>'byteSize')::bigint);
  END LOOP;
  RETURN encode(sha256(payload), 'hex');
END;
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ai_extraction_batch_item_manifest_hash(p_item ai_extraction_batch_items) RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $function$
DECLARE
  payload bytea := ''::bytea;
  option_row jsonb;
  page_hash text;
  page_count integer;
  option_count integer;
  character_count integer;
  byte_size integer;
BEGIN
  page_hash := ai_extraction_batch_page_manifest_hash(p_item);
  page_count := jsonb_array_length(coalesce(p_item.page_manifest, '[]'::jsonb));
  SELECT coalesce(sum((value->>'characterCount')::integer), 0), coalesce(sum((value->>'byteSize')::integer), 0)
    INTO character_count, byte_size
  FROM jsonb_array_elements(coalesce(p_item.page_manifest, '[]'::jsonb));
  payload := payload || ai_extraction_batch_scalar_text('ai-extraction-batch-domain-v1');
  payload := payload || ai_extraction_batch_scalar_integer(p_item.item_ordinal);
  payload := payload || ai_extraction_batch_scalar_text(lower(p_item.paper_id::text));
  payload := payload || ai_extraction_batch_scalar_text(lower(p_item.extraction_field_id::text));
  payload := payload || ai_extraction_batch_scalar_text(CASE WHEN p_item.expected_current_extraction_revision_id IS NULL THEN NULL ELSE lower(p_item.expected_current_extraction_revision_id::text) END);
  payload := payload || ai_extraction_batch_scalar_text(CASE WHEN p_item.title_abstract_decision_id IS NULL THEN NULL ELSE lower(p_item.title_abstract_decision_id::text) END);
  payload := payload || ai_extraction_batch_scalar_text(CASE WHEN p_item.full_text_decision_id IS NULL THEN NULL ELSE lower(p_item.full_text_decision_id::text) END);
  payload := payload || ai_extraction_batch_scalar_text(CASE WHEN p_item.full_text_document_id IS NULL THEN NULL ELSE lower(p_item.full_text_document_id::text) END);
  payload := payload || ai_extraction_batch_scalar_text(CASE WHEN p_item.document_text_extraction_id IS NULL THEN NULL ELSE lower(p_item.document_text_extraction_id::text) END);
  payload := payload || ai_extraction_batch_scalar_text(p_item.initial_disposition);
  payload := payload || ai_extraction_batch_scalar_text(p_item.initial_reason_code);
  payload := payload || ai_extraction_batch_scalar_text(lower(p_item.idempotency_key::text));
  payload := payload || ai_extraction_batch_scalar_text(p_item.expected_request_intent_hash);
  payload := payload || ai_extraction_batch_scalar_text(p_item.field_definition_hash);
  payload := payload || ai_extraction_batch_scalar_text(p_item.option_snapshot_hash);
  payload := payload || ai_extraction_batch_scalar_text(p_item.paper_title_snapshot);
  payload := payload || ai_extraction_batch_scalar_text(p_item.paper_abstract_snapshot);
  payload := payload || ai_extraction_batch_scalar_text(p_item.field_name_snapshot);
  payload := payload || ai_extraction_batch_scalar_text(p_item.field_description_snapshot);
  payload := payload || ai_extraction_batch_scalar_text(p_item.field_type_snapshot);
  payload := payload || ai_extraction_batch_scalar_boolean(p_item.field_required_snapshot);
  SELECT count(*)::integer INTO option_count
  FROM jsonb_array_elements(coalesce(p_item.field_option_snapshot, '[]'::jsonb)) AS option_element(value)
  WHERE option_element.value->>'archivedAt' IS NULL;
  payload := payload || ai_extraction_batch_scalar_integer(option_count);
  FOR option_row IN
    SELECT option_element.value
    FROM jsonb_array_elements(coalesce(p_item.field_option_snapshot, '[]'::jsonb)) AS option_element(value)
    WHERE option_element.value->>'archivedAt' IS NULL
    ORDER BY (option_element.value->>'sortOrder')::bigint, lower(option_element.value->>'id')
  LOOP
    payload := payload || ai_extraction_batch_scalar_text(lower(option_row->>'id'));
    payload := payload || ai_extraction_batch_scalar_text(option_row->>'label');
    payload := payload || ai_extraction_batch_scalar_integer((option_row->>'sortOrder')::bigint);
  END LOOP;
  payload := payload || ai_extraction_batch_scalar_text(p_item.document_filename_snapshot);
  payload := payload || ai_extraction_batch_scalar_integer(p_item.extraction_sequence_snapshot);
  payload := payload || ai_extraction_batch_scalar_text(p_item.extraction_status_snapshot);
  payload := payload || ai_extraction_batch_scalar_text(page_hash);
  payload := payload || ai_extraction_batch_scalar_integer(page_count);
  payload := payload || ai_extraction_batch_scalar_integer(character_count);
  payload := payload || ai_extraction_batch_scalar_integer(byte_size);
  RETURN encode(sha256(payload), 'hex');
END;
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ai_extraction_batch_manifest_hash(p_batch ai_extraction_batches) RETURNS text
LANGUAGE plpgsql STABLE
AS $function$
DECLARE
  payload bytea := ''::bytea;
  item_row ai_extraction_batch_items;
BEGIN
  payload := payload || ai_extraction_batch_scalar_text('ai-extraction-batch-domain-v1');
  payload := payload || ai_extraction_batch_scalar_text(p_batch.manifest_algorithm_version);
  payload := payload || ai_extraction_batch_scalar_text(p_batch.provider);
  payload := payload || ai_extraction_batch_scalar_text(p_batch.configured_model);
  payload := payload || ai_extraction_batch_scalar_text(p_batch.configured_reasoning_effort);
  payload := payload || ai_extraction_batch_scalar_text(p_batch.selection_policy_version);
  payload := payload || ai_extraction_batch_scalar_text(p_batch.batch_disclosure_version);
  payload := payload || ai_extraction_batch_scalar_text(p_batch.request_disclosure_version);
  payload := payload || ai_extraction_batch_scalar_boolean(p_batch.external_transmission_acknowledged);
  payload := payload || ai_extraction_batch_scalar_integer(p_batch.paper_count);
  payload := payload || ai_extraction_batch_scalar_integer(p_batch.field_count);
  payload := payload || ai_extraction_batch_scalar_integer(p_batch.cell_count);
  payload := payload || ai_extraction_batch_scalar_integer(p_batch.executable_count);
  FOR item_row IN
    SELECT * FROM ai_extraction_batch_items
    WHERE project_id = p_batch.project_id AND batch_id = p_batch.id
    ORDER BY item_ordinal
  LOOP
    payload := payload || ai_extraction_batch_scalar_integer(item_row.item_ordinal);
    payload := payload || ai_extraction_batch_scalar_text(item_row.item_manifest_hash);
  END LOOP;
  RETURN encode(sha256(payload), 'hex');
END;
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_ai_extraction_batch_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AI extraction batches cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.cancelled_at IS NOT NULL OR NEW.external_transmission_acknowledged IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'AI extraction batches must begin acknowledged and uncancelled' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.configured_model IS DISTINCT FROM OLD.configured_model
    OR NEW.configured_reasoning_effort IS DISTINCT FROM OLD.configured_reasoning_effort
    OR NEW.selection_policy_version IS DISTINCT FROM OLD.selection_policy_version
    OR NEW.batch_disclosure_version IS DISTINCT FROM OLD.batch_disclosure_version
    OR NEW.request_disclosure_version IS DISTINCT FROM OLD.request_disclosure_version
    OR NEW.external_transmission_acknowledged IS DISTINCT FROM OLD.external_transmission_acknowledged
    OR NEW.paper_count IS DISTINCT FROM OLD.paper_count
    OR NEW.field_count IS DISTINCT FROM OLD.field_count
    OR NEW.cell_count IS DISTINCT FROM OLD.cell_count
    OR NEW.executable_count IS DISTINCT FROM OLD.executable_count
    OR NEW.manifest_algorithm_version IS DISTINCT FROM OLD.manifest_algorithm_version
    OR NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'AI extraction batch manifest identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.cancelled_at IS NOT NULL THEN
    IF NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at THEN
      RAISE EXCEPTION 'AI extraction batch cancellation is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.cancelled_at IS NOT NULL THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'AI extraction batch updates may only cancel the batch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER ai_extraction_batches_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON ai_extraction_batches
FOR EACH ROW EXECUTE FUNCTION prevent_ai_extraction_batch_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_ai_extraction_batch_item_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  batch_row ai_extraction_batches;
  request_row ai_extraction_requests;
  other_item uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AI extraction batch items cannot be deleted' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO batch_row FROM ai_extraction_batches WHERE project_id = NEW.project_id AND id = NEW.batch_id FOR UPDATE;
  IF batch_row.id IS NULL THEN
    RAISE EXCEPTION 'AI extraction batch does not belong to this project' USING ERRCODE = '23503';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF batch_row.cancelled_at IS NOT NULL OR NEW.ai_extraction_request_id IS NOT NULL OR NEW.request_relationship IS NOT NULL OR NEW.orchestration_terminal_code IS NOT NULL OR NEW.orchestration_finalized_at IS NOT NULL THEN
      RAISE EXCEPTION 'AI extraction batch items must be inserted as unlinked manifest rows' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
      OR NEW.item_ordinal IS DISTINCT FROM OLD.item_ordinal
      OR NEW.paper_id IS DISTINCT FROM OLD.paper_id
      OR NEW.extraction_field_id IS DISTINCT FROM OLD.extraction_field_id
      OR NEW.expected_current_extraction_revision_id IS DISTINCT FROM OLD.expected_current_extraction_revision_id
      OR NEW.title_abstract_decision_id IS DISTINCT FROM OLD.title_abstract_decision_id
      OR NEW.full_text_decision_id IS DISTINCT FROM OLD.full_text_decision_id
      OR NEW.full_text_document_id IS DISTINCT FROM OLD.full_text_document_id
      OR NEW.document_text_extraction_id IS DISTINCT FROM OLD.document_text_extraction_id
      OR NEW.initial_disposition IS DISTINCT FROM OLD.initial_disposition
      OR NEW.initial_reason_code IS DISTINCT FROM OLD.initial_reason_code
      OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
      OR NEW.expected_request_intent_hash IS DISTINCT FROM OLD.expected_request_intent_hash
      OR NEW.field_definition_hash IS DISTINCT FROM OLD.field_definition_hash
      OR NEW.option_snapshot_hash IS DISTINCT FROM OLD.option_snapshot_hash
      OR NEW.paper_title_snapshot IS DISTINCT FROM OLD.paper_title_snapshot
      OR NEW.paper_abstract_snapshot IS DISTINCT FROM OLD.paper_abstract_snapshot
      OR NEW.field_name_snapshot IS DISTINCT FROM OLD.field_name_snapshot
      OR NEW.field_description_snapshot IS DISTINCT FROM OLD.field_description_snapshot
      OR NEW.field_type_snapshot IS DISTINCT FROM OLD.field_type_snapshot
      OR NEW.field_required_snapshot IS DISTINCT FROM OLD.field_required_snapshot
      OR NEW.field_option_snapshot IS DISTINCT FROM OLD.field_option_snapshot
      OR NEW.document_filename_snapshot IS DISTINCT FROM OLD.document_filename_snapshot
      OR NEW.extraction_sequence_snapshot IS DISTINCT FROM OLD.extraction_sequence_snapshot
      OR NEW.extraction_status_snapshot IS DISTINCT FROM OLD.extraction_status_snapshot
      OR NEW.page_manifest IS DISTINCT FROM OLD.page_manifest
      OR NEW.page_manifest_hash IS DISTINCT FROM OLD.page_manifest_hash
      OR NEW.page_count IS DISTINCT FROM OLD.page_count
      OR NEW.source_character_count IS DISTINCT FROM OLD.source_character_count
      OR NEW.source_byte_size IS DISTINCT FROM OLD.source_byte_size
      OR NEW.item_manifest_hash IS DISTINCT FROM OLD.item_manifest_hash
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'AI extraction batch item manifest identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.ai_extraction_request_id IS NOT NULL AND NEW.ai_extraction_request_id IS DISTINCT FROM OLD.ai_extraction_request_id THEN
      RAISE EXCEPTION 'AI extraction batch item request link is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.request_relationship IS NOT NULL AND NEW.request_relationship IS DISTINCT FROM OLD.request_relationship THEN
      RAISE EXCEPTION 'AI extraction batch item request relationship is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.orchestration_terminal_code IS NOT NULL AND (NEW.orchestration_terminal_code IS DISTINCT FROM OLD.orchestration_terminal_code OR NEW.orchestration_finalized_at IS DISTINCT FROM OLD.orchestration_finalized_at) THEN
      RAISE EXCEPTION 'AI extraction batch item terminal outcome is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.ai_extraction_request_id IS NULL AND NEW.ai_extraction_request_id IS NOT NULL AND NEW.request_relationship IS NULL THEN
      RAISE EXCEPTION 'AI extraction request links require a relationship' USING ERRCODE = '23514';
    END IF;
    IF OLD.orchestration_terminal_code IS NULL AND NEW.orchestration_terminal_code IS NOT NULL AND NEW.orchestration_finalized_at IS NULL THEN
      RAISE EXCEPTION 'AI extraction terminal outcomes require a finalization timestamp' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.ai_extraction_request_id IS NOT NULL THEN
    SELECT * INTO request_row FROM ai_extraction_requests WHERE project_id = NEW.project_id AND id = NEW.ai_extraction_request_id FOR UPDATE;
    IF request_row.id IS NULL OR request_row.paper_id IS DISTINCT FROM NEW.paper_id OR request_row.extraction_field_id IS DISTINCT FROM NEW.extraction_field_id THEN
      RAISE EXCEPTION 'AI extraction request link does not match the batch item Paper and field' USING ERRCODE = '23514';
    END IF;
    IF NEW.request_relationship = 'authoritative' AND (
      request_row.full_text_document_id IS DISTINCT FROM NEW.full_text_document_id
      OR request_row.document_text_extraction_id IS DISTINCT FROM NEW.document_text_extraction_id
      OR request_row.baseline_extraction_revision_id IS DISTINCT FROM NEW.expected_current_extraction_revision_id
      OR request_row.intent_hash IS DISTINCT FROM NEW.expected_request_intent_hash
      OR request_row.field_name_snapshot IS DISTINCT FROM NEW.field_name_snapshot
      OR request_row.field_description_snapshot IS DISTINCT FROM NEW.field_description_snapshot
      OR request_row.field_type IS DISTINCT FROM NEW.field_type_snapshot
      OR request_row.option_snapshot IS DISTINCT FROM NEW.field_option_snapshot
      OR request_row.configured_model IS DISTINCT FROM batch_row.configured_model
      OR request_row.configured_reasoning_effort IS DISTINCT FROM batch_row.configured_reasoning_effort
      OR request_row.prompt_version IS DISTINCT FROM 'extraction-suggestion-v1'
      OR request_row.response_schema_version IS DISTINCT FROM 'extraction-suggestion-response-v1'
      OR request_row.grounding_resolver_version IS DISTINCT FROM 'exact-page-quote-v1'
      OR request_row.context_selection_version IS DISTINCT FROM 'selected-pages-v1'
      OR request_row.source_character_count IS DISTINCT FROM NEW.source_character_count
      OR request_row.source_byte_size IS DISTINCT FROM NEW.source_byte_size + greatest(NEW.page_count - 1, 0)
      OR request_row.page_manifest_hash IS DISTINCT FROM NEW.page_manifest_hash
      OR request_row.disclosure_version IS DISTINCT FROM batch_row.request_disclosure_version
      OR request_row.external_transmission_acknowledged IS DISTINCT FROM TRUE
    ) THEN
      RAISE EXCEPTION 'Authoritative AI extraction request context does not match the batch item' USING ERRCODE = '23514';
    END IF;
    SELECT id INTO other_item FROM ai_extraction_batch_items WHERE project_id = NEW.project_id AND batch_id = NEW.batch_id AND ai_extraction_request_id = NEW.ai_extraction_request_id AND id IS DISTINCT FROM NEW.id FOR UPDATE;
    IF other_item IS NOT NULL THEN RAISE EXCEPTION 'An AI extraction request may be linked to only one batch item' USING ERRCODE = '23505'; END IF;
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER ai_extraction_batch_items_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON ai_extraction_batch_items
FOR EACH ROW EXECUTE FUNCTION prevent_ai_extraction_batch_item_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_ai_extraction_batch_item_manifest() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  page_entry jsonb;
  page_ordinal integer := 0;
  page_number integer := 0;
  previous_page_number integer := 0;
  character_count integer := 0;
  byte_size integer := 0;
BEGIN
  IF NEW.item_manifest_hash IS DISTINCT FROM ai_extraction_batch_item_manifest_hash(NEW) THEN
    RAISE EXCEPTION 'AI extraction batch item manifest hash does not match canonical bytes' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(NEW.field_option_snapshot) <> 'array' THEN
    RAISE EXCEPTION 'AI extraction batch option snapshot must be an array' USING ERRCODE = '23514';
  END IF;
  IF NEW.field_type_snapshot <> 'single_select' AND NEW.field_option_snapshot <> '[]'::jsonb THEN
    RAISE EXCEPTION 'Only single-select batch items may contain extraction options' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.field_option_snapshot) AS option_element(value)
    WHERE jsonb_typeof(option_element.value) <> 'object'
      OR (option_element.value - 'id' - 'label' - 'sortOrder') <> '{}'::jsonb
      OR jsonb_typeof(option_element.value->'id') <> 'string'
      OR (option_element.value->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR jsonb_typeof(option_element.value->'label') <> 'string'
      OR jsonb_typeof(option_element.value->'sortOrder') <> 'number'
      OR (option_element.value->>'sortOrder') !~ '^-?(?:0|[1-9][0-9]*)$'
  ) THEN
    RAISE EXCEPTION 'AI extraction batch option snapshots must contain canonical active option metadata' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.field_option_snapshot) AS option_element(value)
    GROUP BY lower(option_element.value->>'id') HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'AI extraction batch option snapshots cannot repeat an option' USING ERRCODE = '23514';
  END IF;
  IF NEW.option_snapshot_hash IS DISTINCT FROM ai_extraction_batch_option_snapshot_hash(NEW.field_option_snapshot) THEN
    RAISE EXCEPTION 'AI extraction batch option snapshot hash does not match its raw options' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(NEW.page_manifest) <> NEW.page_count THEN
    RAISE EXCEPTION 'AI extraction batch item page manifest count does not match page_count' USING ERRCODE = '23514';
  END IF;
  IF NEW.page_manifest_hash IS DISTINCT FROM ai_extraction_batch_page_manifest_hash(NEW) THEN
    RAISE EXCEPTION 'AI extraction batch page manifest hash does not match canonical page metadata' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.page_manifest) value
    GROUP BY value->>'pageId'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'AI extraction batch page manifests cannot repeat a page' USING ERRCODE = '23514';
  END IF;
  FOR page_entry IN SELECT value FROM jsonb_array_elements(NEW.page_manifest) LOOP
    IF page_entry ? 'text'
      OR (page_entry - 'pageId' - 'pageNumber' - 'pageOrdinal' - 'textSha256' - 'characterCount' - 'byteSize') <> '{}'::jsonb
      OR (page_entry->>'pageId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR jsonb_typeof(page_entry->'pageId') <> 'string'
      OR jsonb_typeof(page_entry->'pageNumber') <> 'number'
      OR jsonb_typeof(page_entry->'pageOrdinal') <> 'number'
      OR jsonb_typeof(page_entry->'textSha256') <> 'string'
      OR jsonb_typeof(page_entry->'characterCount') <> 'number'
      OR jsonb_typeof(page_entry->'byteSize') <> 'number'
      OR (page_entry->>'pageNumber') !~ '^-?(?:0|[1-9][0-9]*)$'
      OR (page_entry->>'pageOrdinal') !~ '^-?(?:0|[1-9][0-9]*)$'
      OR (page_entry->>'characterCount') !~ '^-?(?:0|[1-9][0-9]*)$'
      OR (page_entry->>'byteSize') !~ '^-?(?:0|[1-9][0-9]*)$'
      OR (page_entry->>'pageOrdinal')::integer IS DISTINCT FROM page_ordinal
      OR (page_entry->>'pageNumber')::integer <= 0
      OR (page_entry->>'textSha256') !~ '^[0-9a-f]{64}$'
      OR (page_entry->>'characterCount')::integer <= 0
      OR (page_entry->>'byteSize')::integer <= 0
      OR (page_entry->>'pageNumber')::integer <= previous_page_number THEN
      RAISE EXCEPTION 'AI extraction batch page manifests must contain ordered metadata-only pages' USING ERRCODE = '23514';
    END IF;
    page_number := (page_entry->>'pageNumber')::integer;
    character_count := character_count + (page_entry->>'characterCount')::integer;
    byte_size := byte_size + (page_entry->>'byteSize')::integer;
    previous_page_number := page_number;
    page_ordinal := page_ordinal + 1;
  END LOOP;
  IF character_count IS DISTINCT FROM NEW.source_character_count OR byte_size IS DISTINCT FROM NEW.source_byte_size THEN
    RAISE EXCEPTION 'AI extraction batch source counts do not match its page manifest' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ai_extraction_batch_items_manifest_complete
AFTER INSERT OR UPDATE ON ai_extraction_batch_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_ai_extraction_batch_item_manifest();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_ai_extraction_batch_row(p_batch ai_extraction_batches) RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  actual_count integer;
  actual_papers integer;
  actual_fields integer;
  actual_executable integer;
  minimum_ordinal integer;
  maximum_ordinal integer;
  reusable_or_executable integer;
BEGIN
  SELECT count(*)::integer,count(distinct paper_id)::integer,count(distinct extraction_field_id)::integer,
    count(*) FILTER (WHERE initial_disposition = 'executable')::integer,min(item_ordinal),max(item_ordinal),
    count(*) FILTER (WHERE initial_disposition in ('executable','reusable'))::integer
  INTO actual_count,actual_papers,actual_fields,actual_executable,minimum_ordinal,maximum_ordinal,reusable_or_executable
  FROM ai_extraction_batch_items WHERE project_id=p_batch.project_id AND batch_id=p_batch.id;
  IF actual_count <> p_batch.cell_count OR actual_papers <> p_batch.paper_count OR actual_fields <> p_batch.field_count OR actual_executable <> p_batch.executable_count OR reusable_or_executable < 1 OR minimum_ordinal IS DISTINCT FROM 0 OR maximum_ordinal IS DISTINCT FROM p_batch.cell_count - 1 THEN
    RAISE EXCEPTION 'AI extraction batch counts and dense ordinals do not match its manifest' USING ERRCODE = '23514';
  END IF;
  IF ai_extraction_batch_manifest_hash(p_batch) IS DISTINCT FROM p_batch.manifest_sha256 THEN
    RAISE EXCEPTION 'AI extraction batch manifest hash does not match canonical bytes' USING ERRCODE = '23514';
  END IF;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_ai_extraction_batch_from_batch() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM validate_ai_extraction_batch_row(NEW);
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ai_extraction_batches_manifest_complete
AFTER INSERT OR UPDATE ON ai_extraction_batches
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_ai_extraction_batch_from_batch();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_ai_extraction_batch_from_item() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  batch_row ai_extraction_batches;
BEGIN
  SELECT * INTO batch_row FROM ai_extraction_batches WHERE project_id=NEW.project_id AND id=NEW.batch_id;
  IF batch_row.id IS NOT NULL THEN
    PERFORM validate_ai_extraction_batch_row(batch_row);
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ai_extraction_batch_items_batch_manifest_complete
AFTER INSERT OR UPDATE ON ai_extraction_batch_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_ai_extraction_batch_from_item();
