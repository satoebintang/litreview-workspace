ALTER TABLE "full_text_documents" ADD COLUMN "storage_state" text DEFAULT 'ready';--> statement-breakpoint
ALTER TABLE "full_text_documents" ADD COLUMN "staged_storage_key" text;--> statement-breakpoint
ALTER TABLE "pdf_intakes" ADD COLUMN "storage_state" text DEFAULT 'ready';--> statement-breakpoint
ALTER TABLE "pdf_intakes" ADD COLUMN "staged_storage_key" text;--> statement-breakpoint
ALTER TABLE "full_text_documents" ALTER COLUMN "storage_state" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "full_text_documents" ALTER COLUMN "storage_state" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "pdf_intakes" ALTER COLUMN "storage_state" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pdf_intakes" ALTER COLUMN "storage_state" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "full_text_documents" ADD CONSTRAINT "full_text_documents_storage_state_valid" CHECK ("storage_state" IN ('pending', 'ready'));--> statement-breakpoint
ALTER TABLE "full_text_documents" ADD CONSTRAINT "full_text_documents_storage_state_stage_shape" CHECK (("storage_state" = 'ready' AND "staged_storage_key" IS NULL) OR ("storage_state" = 'pending' AND "staged_storage_key" ~ '^\.tmp/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.upload$'));--> statement-breakpoint
ALTER TABLE "pdf_intakes" ADD CONSTRAINT "pdf_intakes_storage_state_valid" CHECK ("storage_state" IN ('pending', 'ready'));--> statement-breakpoint
ALTER TABLE "pdf_intakes" ADD CONSTRAINT "pdf_intakes_storage_state_stage_shape" CHECK (("storage_state" = 'ready' AND "staged_storage_key" IS NULL) OR ("storage_state" = 'pending' AND "staged_storage_key" ~ '^\.pdf-intake/\.tmp/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.upload$'));--> statement-breakpoint
CREATE UNIQUE INDEX "full_text_documents_staged_storage_key_unique" ON "full_text_documents" ("staged_storage_key") WHERE "staged_storage_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "full_text_documents_pending_storage_idx" ON "full_text_documents" ("created_at", "id") WHERE "storage_state" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "pdf_intakes_staged_storage_key_unique" ON "pdf_intakes" ("staged_storage_key") WHERE "staged_storage_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pdf_intakes_pending_storage_idx" ON "pdf_intakes" ("created_at", "id") WHERE "storage_state" = 'pending';--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_full_text_document_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'full-text document artifacts are archive-only';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.paper_id IS DISTINCT FROM OLD.paper_id
    OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
    OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
    OR NEW.media_type IS DISTINCT FROM OLD.media_type
    OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.note IS DISTINCT FROM OLD.note
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'full-text document byte identity is immutable';
  END IF;

  IF OLD.storage_state = 'pending' THEN
    IF OLD.archived_at IS NOT NULL OR NEW.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'pending full-text documents cannot be archived';
    END IF;
    IF NEW.storage_state = 'pending'
      AND NEW.staged_storage_key IS DISTINCT FROM OLD.staged_storage_key
    THEN
      RETURN NEW;
    END IF;
    IF NEW.storage_state = 'ready'
      AND OLD.staged_storage_key IS NOT NULL
      AND NEW.staged_storage_key IS NULL
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'invalid full-text document storage transition';
  END IF;

  IF OLD.storage_state = 'ready'
    AND NEW.storage_state = 'ready'
    AND NEW.staged_storage_key IS NOT DISTINCT FROM OLD.staged_storage_key
    AND OLD.archived_at IS NULL
    AND NEW.archived_at IS NOT NULL
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ready full-text documents are immutable except for archival';
END;
$function$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_pdf_intake_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PDF intake source artifacts are immutable';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
    OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
    OR NEW.media_type IS DISTINCT FROM OLD.media_type
    OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'PDF intake byte identity is immutable';
  END IF;
  IF OLD.storage_state = 'pending'
    AND NEW.storage_state = 'pending'
    AND NEW.staged_storage_key IS DISTINCT FROM OLD.staged_storage_key
  THEN
    RETURN NEW;
  END IF;
  IF OLD.storage_state = 'pending'
    AND NEW.storage_state = 'ready'
    AND OLD.staged_storage_key IS NOT NULL
    AND NEW.staged_storage_key IS NULL
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid PDF intake storage transition';
END;
$function$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_preferred_full_text_document() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  document_archived_at timestamptz;
  document_storage_state text;
BEGIN
  -- Serialize preference changes with archival and pending-to-ready changes.
  -- Without the row lock, concurrent archive/preference statements could
  -- both validate against the other's uncommitted state.
  SELECT doc.archived_at, doc.storage_state
  INTO document_archived_at, document_storage_state
  FROM full_text_documents doc
  WHERE doc.project_id = NEW.project_id
    AND doc.paper_id = NEW.paper_id
    AND doc.id = NEW.full_text_document_id
  FOR UPDATE;
  IF FOUND AND (document_archived_at IS NOT NULL OR document_storage_state <> 'ready') THEN
    RAISE EXCEPTION 'archived or non-ready full-text documents cannot become preferred';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_document_text_extraction_document() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  document_archived_at timestamptz;
  document_storage_state text;
BEGIN
  SELECT archived_at, storage_state INTO document_archived_at, document_storage_state
  FROM full_text_documents
  WHERE project_id = NEW.project_id
    AND paper_id = NEW.paper_id
    AND id = NEW.full_text_document_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'full-text document does not belong to the extraction paper';
  END IF;
  IF document_storage_state <> 'ready' THEN
    RAISE EXCEPTION 'new extraction cannot reference a non-ready full-text document';
  END IF;
  IF document_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'new extraction cannot reference an archived full-text document';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_evidence_document_retargeting() RETURNS trigger
LANGUAGE plpgsql AS $function$
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
      AND (doc.archived_at IS NOT NULL OR doc.storage_state <> 'ready')
  ) THEN
    RAISE EXCEPTION 'new Evidence cannot reference an archived or non-ready full-text document';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_pdf_intake_resolution_consistency() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  intake_sha256 text;
  intake_storage_state text;
  result_intake_id uuid;
  document_paper_id uuid;
  document_sha256 text;
  document_storage_state text;
  intake_byte_size bigint;
  document_byte_size bigint;
BEGIN
  SELECT i.sha256, i.byte_size, i.storage_state INTO intake_sha256, intake_byte_size, intake_storage_state
  FROM pdf_intakes i
  WHERE i.project_id = NEW.project_id AND i.id = NEW.intake_id
  FOR UPDATE;
  IF intake_sha256 IS NULL THEN
    RAISE EXCEPTION 'PDF intake resolution must reference a project-owned intake' USING ERRCODE = '23503';
  END IF;
  IF intake_storage_state <> 'ready' THEN
    RAISE EXCEPTION 'PDF intake resolution requires materialized source bytes' USING ERRCODE = '23514';
  END IF;

  SELECT r.intake_id INTO result_intake_id
  FROM pdf_intake_metadata_results r
  WHERE r.project_id = NEW.project_id AND r.id = NEW.metadata_result_id;
  IF result_intake_id IS NULL OR result_intake_id IS DISTINCT FROM NEW.intake_id THEN
    RAISE EXCEPTION 'PDF intake resolution metadata result must belong to the same intake' USING ERRCODE = '23514';
  END IF;

  SELECT d.paper_id, d.sha256, d.byte_size, d.storage_state INTO document_paper_id, document_sha256, document_byte_size, document_storage_state
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
  IF NEW.materialization_kind = 'reused_document' AND document_storage_state <> 'ready' THEN
    RAISE EXCEPTION 'reused PDF resolution documents must be ready' USING ERRCODE = '23514';
  END IF;
  IF NEW.materialization_kind = 'created_document' AND document_storage_state NOT IN ('pending', 'ready') THEN
    RAISE EXCEPTION 'created PDF resolution documents must be pending or ready' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
