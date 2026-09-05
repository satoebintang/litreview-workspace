CREATE TABLE "extraction_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"field_type" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "extraction_fields_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "extraction_fields_type_valid" CHECK ("extraction_fields"."field_type" in ('short_text', 'long_text', 'number', 'boolean', 'single_select')),
	CONSTRAINT "extraction_fields_name_nonblank" CHECK (btrim("extraction_fields"."name") <> ''),
	CONSTRAINT "extraction_fields_description_nonblank" CHECK ("extraction_fields"."description" is null or btrim("extraction_fields"."description") <> ''),
	CONSTRAINT "extraction_fields_sort_order_valid" CHECK ("extraction_fields"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "extraction_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "extraction_options_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "extraction_options_project_field_id_unique" UNIQUE("project_id","field_id","id"),
	CONSTRAINT "extraction_options_label_nonblank" CHECK (btrim("extraction_options"."label") <> ''),
	CONSTRAINT "extraction_options_sort_order_valid" CHECK ("extraction_options"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "extraction_revision_evidence" (
	"project_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extraction_revision_evidence_project_id_revision_id_evidence_id_pk" PRIMARY KEY("project_id","revision_id","evidence_id")
);
--> statement-breakpoint
CREATE TABLE "extraction_value_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "extraction_value_revisions_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"extraction_value_id" uuid NOT NULL,
	"field_type" text NOT NULL,
	"value_state" text NOT NULL,
	"text_value" text,
	"number_value" numeric(30, 10),
	"boolean_value" boolean,
	"option_id" uuid,
	"researcher_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "extraction_value_revisions_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "extraction_value_revisions_project_paper_id_unique" UNIQUE("project_id","paper_id","id"),
	CONSTRAINT "extraction_value_revisions_project_value_id_unique" UNIQUE("project_id","extraction_value_id","id"),
	CONSTRAINT "extraction_value_revisions_project_paper_value_id_unique" UNIQUE("project_id","paper_id","extraction_value_id","id"),
	CONSTRAINT "extraction_value_revisions_state_valid" CHECK ("extraction_value_revisions"."value_state" in ('present', 'not_reported', 'not_applicable', 'cleared')),
	CONSTRAINT "extraction_value_revisions_type_valid" CHECK ("extraction_value_revisions"."field_type" in ('short_text', 'long_text', 'number', 'boolean', 'single_select')),
	CONSTRAINT "extraction_value_revisions_value_shape" CHECK ((
      ("extraction_value_revisions"."value_state" <> 'present' and "extraction_value_revisions"."text_value" is null and "extraction_value_revisions"."number_value" is null and "extraction_value_revisions"."boolean_value" is null and "extraction_value_revisions"."option_id" is null)
      or ("extraction_value_revisions"."value_state" = 'present' and (
        ("extraction_value_revisions"."field_type" in ('short_text', 'long_text') and "extraction_value_revisions"."text_value" is not null and "extraction_value_revisions"."number_value" is null and "extraction_value_revisions"."boolean_value" is null and "extraction_value_revisions"."option_id" is null)
        or ("extraction_value_revisions"."field_type" = 'number' and "extraction_value_revisions"."text_value" is null and "extraction_value_revisions"."number_value" is not null and "extraction_value_revisions"."boolean_value" is null and "extraction_value_revisions"."option_id" is null)
        or ("extraction_value_revisions"."field_type" = 'boolean' and "extraction_value_revisions"."text_value" is null and "extraction_value_revisions"."number_value" is null and "extraction_value_revisions"."boolean_value" is not null and "extraction_value_revisions"."option_id" is null)
        or ("extraction_value_revisions"."field_type" = 'single_select' and "extraction_value_revisions"."text_value" is null and "extraction_value_revisions"."number_value" is null and "extraction_value_revisions"."boolean_value" is null and "extraction_value_revisions"."option_id" is not null)
      ))
    )),
	CONSTRAINT "extraction_value_revisions_note_nonblank" CHECK ("extraction_value_revisions"."researcher_note" is null or btrim("extraction_value_revisions"."researcher_note") <> '')
);
--> statement-breakpoint
CREATE TABLE "extraction_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extraction_values_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "extraction_values_project_paper_field_unique" UNIQUE("project_id","paper_id","field_id"),
	CONSTRAINT "extraction_values_project_paper_id_unique" UNIQUE("project_id","paper_id","id"),
	CONSTRAINT "extraction_values_project_paper_field_id_unique" UNIQUE("project_id","paper_id","id","field_id")
);
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_project_paper_id_unique" UNIQUE("project_id", "paper_id", "id");--> statement-breakpoint
ALTER TABLE "extraction_fields" ADD CONSTRAINT "extraction_fields_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_options" ADD CONSTRAINT "extraction_options_project_field_fk" FOREIGN KEY ("project_id","field_id") REFERENCES "public"."extraction_fields"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_revision_evidence" ADD CONSTRAINT "extraction_revision_evidence_revision_fk" FOREIGN KEY ("project_id","paper_id","revision_id") REFERENCES "public"."extraction_value_revisions"("project_id","paper_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_revision_evidence" ADD CONSTRAINT "extraction_revision_evidence_evidence_fk" FOREIGN KEY ("project_id","paper_id","evidence_id") REFERENCES "public"."evidence"("project_id","paper_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_value_revisions" ADD CONSTRAINT "extraction_value_revisions_value_fk" FOREIGN KEY ("project_id","paper_id","extraction_value_id","field_id") REFERENCES "public"."extraction_values"("project_id","paper_id","id","field_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_value_revisions" ADD CONSTRAINT "extraction_value_revisions_field_fk" FOREIGN KEY ("project_id","field_id") REFERENCES "public"."extraction_fields"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_value_revisions" ADD CONSTRAINT "extraction_value_revisions_option_fk" FOREIGN KEY ("project_id","field_id","option_id") REFERENCES "public"."extraction_options"("project_id","field_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_values" ADD CONSTRAINT "extraction_values_project_paper_fk" FOREIGN KEY ("project_id","paper_id") REFERENCES "public"."papers"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_values" ADD CONSTRAINT "extraction_values_project_field_fk" FOREIGN KEY ("project_id","field_id") REFERENCES "public"."extraction_fields"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extraction_fields_project_order_idx" ON "extraction_fields" USING btree ("project_id","sort_order","id");--> statement-breakpoint
CREATE INDEX "extraction_options_field_order_idx" ON "extraction_options" USING btree ("project_id","field_id","sort_order","id");--> statement-breakpoint
CREATE INDEX "extraction_revision_evidence_revision_idx" ON "extraction_revision_evidence" USING btree ("project_id","revision_id");--> statement-breakpoint
CREATE INDEX "extraction_revision_evidence_evidence_idx" ON "extraction_revision_evidence" USING btree ("project_id","paper_id","evidence_id");--> statement-breakpoint
CREATE INDEX "extraction_value_revisions_current_idx" ON "extraction_value_revisions" USING btree ("project_id","paper_id","field_id","sequence");--> statement-breakpoint
CREATE INDEX "extraction_values_project_paper_field_idx" ON "extraction_values" USING btree ("project_id","paper_id","field_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_extraction_revision_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'extraction revisions are append-only';
  END IF;
  IF OLD.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'finalized extraction revisions are immutable';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.sequence IS DISTINCT FROM OLD.sequence
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.paper_id IS DISTINCT FROM OLD.paper_id
    OR NEW.field_id IS DISTINCT FROM OLD.field_id
    OR NEW.extraction_value_id IS DISTINCT FROM OLD.extraction_value_id
    OR NEW.field_type IS DISTINCT FROM OLD.field_type
    OR NEW.value_state IS DISTINCT FROM OLD.value_state
    OR NEW.text_value IS DISTINCT FROM OLD.text_value
    OR NEW.number_value IS DISTINCT FROM OLD.number_value
    OR NEW.boolean_value IS DISTINCT FROM OLD.boolean_value
    OR NEW.option_id IS DISTINCT FROM OLD.option_id
    OR NEW.researcher_note IS DISTINCT FROM OLD.researcher_note
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.finalized_at IS NULL THEN
    RAISE EXCEPTION 'extraction revisions are immutable; finalize instead';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER extraction_revisions_append_only
BEFORE UPDATE OR DELETE ON extraction_value_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_extraction_revision_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_extraction_revision_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'revision Evidence links are append-only';
  END IF;
  IF EXISTS (SELECT 1 FROM extraction_value_revisions r WHERE r.project_id = NEW.project_id AND r.paper_id = NEW.paper_id AND r.id = NEW.revision_id AND r.finalized_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Evidence cannot be added to a finalized extraction revision';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER extraction_revision_evidence_append_only
BEFORE INSERT OR UPDATE OR DELETE ON extraction_revision_evidence
FOR EACH ROW EXECUTE FUNCTION prevent_extraction_revision_evidence_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_extraction_field_delete() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'extraction fields are archive-only';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER extraction_fields_archive_only
BEFORE DELETE ON extraction_fields
FOR EACH ROW EXECUTE FUNCTION prevent_extraction_field_delete();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_extraction_option_delete() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'extraction options are archive-only';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER extraction_options_archive_only
BEFORE DELETE ON extraction_options
FOR EACH ROW EXECUTE FUNCTION prevent_extraction_option_delete();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_used_extraction_field_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM extraction_values v WHERE v.project_id = OLD.project_id AND v.field_id = OLD.id)
    AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.name IS DISTINCT FROM OLD.name OR NEW.description IS DISTINCT FROM OLD.description OR NEW.field_type IS DISTINCT FROM OLD.field_type OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'used extraction fields cannot change definition';
  END IF;
  IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    RAISE EXCEPTION 'archived extraction fields cannot be unarchived';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER extraction_fields_immutable_used
BEFORE UPDATE ON extraction_fields
FOR EACH ROW EXECUTE FUNCTION prevent_used_extraction_field_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_used_extraction_option_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM extraction_value_revisions r WHERE r.project_id = OLD.project_id AND r.option_id = OLD.id)
    AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.field_id IS DISTINCT FROM OLD.field_id OR NEW.label IS DISTINCT FROM OLD.label OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'used extraction options cannot change definition';
  END IF;
  IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    RAISE EXCEPTION 'archived extraction options cannot be unarchived';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER extraction_options_immutable_used
BEFORE UPDATE ON extraction_options
FOR EACH ROW EXECUTE FUNCTION prevent_used_extraction_option_mutation();
