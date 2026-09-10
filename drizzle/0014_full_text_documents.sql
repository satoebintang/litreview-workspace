CREATE TABLE "full_text_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "paper_id" uuid NOT NULL,
  "storage_key" text NOT NULL,
  "original_filename" text NOT NULL,
  "media_type" text NOT NULL,
  "byte_size" bigint NOT NULL,
  "sha256" text NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived_at" timestamp with time zone,
  CONSTRAINT "full_text_documents_project_id_id_unique" UNIQUE("project_id", "id"),
  CONSTRAINT "full_text_documents_project_paper_id_id_unique" UNIQUE("project_id", "paper_id", "id"),
  CONSTRAINT "full_text_documents_storage_key_unique" UNIQUE("storage_key"),
  CONSTRAINT "full_text_documents_storage_key_nonblank" CHECK (btrim("storage_key") <> ''),
  CONSTRAINT "full_text_documents_storage_key_format" CHECK ("storage_key" ~ '^projects/[0-9a-f-]{36}/papers/[0-9a-f-]{36}/documents/[0-9a-f-]{36}/source\.pdf$'),
  CONSTRAINT "full_text_documents_filename_nonblank" CHECK (btrim("original_filename") <> ''),
  CONSTRAINT "full_text_documents_media_type_pdf" CHECK ("media_type" = 'application/pdf'),
  CONSTRAINT "full_text_documents_byte_size_positive" CHECK ("byte_size" > 0),
  CONSTRAINT "full_text_documents_sha256_format" CHECK ("sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "full_text_documents"
  ADD CONSTRAINT "full_text_documents_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "full_text_documents"
  ADD CONSTRAINT "full_text_documents_project_paper_fk"
  FOREIGN KEY ("project_id", "paper_id") REFERENCES "public"."papers"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "full_text_documents_active_content_unique"
  ON "full_text_documents" USING btree ("project_id", "paper_id", "sha256")
  WHERE "archived_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "paper_full_text_preferences" (
  "project_id" uuid NOT NULL,
  "paper_id" uuid NOT NULL,
  "full_text_document_id" uuid NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "paper_full_text_preferences_project_id_paper_id_pk" PRIMARY KEY("project_id", "paper_id")
);
--> statement-breakpoint
ALTER TABLE "paper_full_text_preferences"
  ADD CONSTRAINT "paper_full_text_preferences_project_paper_fk"
  FOREIGN KEY ("project_id", "paper_id") REFERENCES "public"."papers"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "paper_full_text_preferences"
  ADD CONSTRAINT "paper_full_text_preferences_document_fk"
  FOREIGN KEY ("project_id", "paper_id", "full_text_document_id") REFERENCES "public"."full_text_documents"("project_id", "paper_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION validate_preferred_full_text_document() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM full_text_documents doc
    WHERE doc.project_id = NEW.project_id
      AND doc.paper_id = NEW.paper_id
      AND doc.id = NEW.full_text_document_id
      AND doc.archived_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'archived full-text documents cannot become preferred';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER paper_full_text_preferences_active_document
BEFORE INSERT OR UPDATE ON paper_full_text_preferences
FOR EACH ROW EXECUTE FUNCTION validate_preferred_full_text_document();
--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "full_text_document_id" uuid;
--> statement-breakpoint
ALTER TABLE "evidence"
  ADD CONSTRAINT "evidence_project_paper_document_fk"
  FOREIGN KEY ("project_id", "paper_id", "full_text_document_id") REFERENCES "public"."full_text_documents"("project_id", "paper_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION prevent_full_text_document_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'full-text document artifacts are archive-only';
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.paper_id IS DISTINCT FROM OLD.paper_id
    OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
    OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
    OR NEW.media_type IS DISTINCT FROM OLD.media_type
    OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.note IS DISTINCT FROM OLD.note
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.archived_at IS NOT NULL AND NEW.archived_at IS DISTINCT FROM OLD.archived_at)
    OR (OLD.archived_at IS NULL AND NEW.archived_at IS NULL)
  THEN
    RAISE EXCEPTION 'full-text document byte identity is immutable';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER full_text_documents_archive_only
BEFORE UPDATE OR DELETE ON full_text_documents
FOR EACH ROW EXECUTE FUNCTION prevent_full_text_document_mutation();
--> statement-breakpoint
CREATE FUNCTION validate_full_text_document_state() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.archived_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM paper_full_text_preferences pref
    WHERE pref.project_id = NEW.project_id
      AND pref.paper_id = NEW.paper_id
      AND pref.full_text_document_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'preferred full-text document must be changed or cleared before archival'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER full_text_documents_validate_state
BEFORE UPDATE ON full_text_documents
FOR EACH ROW EXECUTE FUNCTION validate_full_text_document_state();
--> statement-breakpoint
CREATE FUNCTION prevent_evidence_document_retargeting() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.paper_id IS DISTINCT FROM OLD.paper_id
    OR NEW.full_text_document_id IS DISTINCT FROM OLD.full_text_document_id
  ) THEN
    RAISE EXCEPTION 'Evidence document provenance is immutable';
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
CREATE TRIGGER evidence_document_provenance_guard
BEFORE INSERT OR UPDATE ON evidence
FOR EACH ROW EXECUTE FUNCTION prevent_evidence_document_retargeting();
