CREATE TABLE "synthesis_preparation_selections" (
	"project_id" uuid NOT NULL,
	"preparation_id" uuid NOT NULL,
	"extraction_revision_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "synthesis_preparation_selections_project_id_preparation_id_extraction_revision_id_pk" PRIMARY KEY("project_id","preparation_id","extraction_revision_id")
);
--> statement-breakpoint
CREATE TABLE "synthesis_preparations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"evidence_set_id" uuid NOT NULL,
	"evidence_set_composition_revision_id" uuid NOT NULL,
	"extraction_field_id" uuid NOT NULL,
	"working_title" text,
	"working_note" text,
	"target_synthesis_statement_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"finalized_synthesis_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone,
	CONSTRAINT "synthesis_preparations_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "synthesis_preparations_status_valid" CHECK ("synthesis_preparations"."status" in ('active', 'finalized', 'abandoned')),
	CONSTRAINT "synthesis_preparations_working_title_shape" CHECK ("synthesis_preparations"."working_title" is null or (btrim("synthesis_preparations"."working_title") <> '' and char_length("synthesis_preparations"."working_title") <= 500)),
	CONSTRAINT "synthesis_preparations_working_note_shape" CHECK ("synthesis_preparations"."working_note" is null or (btrim("synthesis_preparations"."working_note") <> '' and char_length("synthesis_preparations"."working_note") <= 10000)),
	CONSTRAINT "synthesis_preparations_status_integrity" CHECK ((
        ("synthesis_preparations"."status" = 'active' and "synthesis_preparations"."finalized_synthesis_revision_id" is null and "synthesis_preparations"."finalized_at" is null and "synthesis_preparations"."abandoned_at" is null)
        or ("synthesis_preparations"."status" = 'finalized' and "synthesis_preparations"."target_synthesis_statement_id" is not null and "synthesis_preparations"."finalized_synthesis_revision_id" is not null and "synthesis_preparations"."finalized_at" is not null and "synthesis_preparations"."abandoned_at" is null)
        or ("synthesis_preparations"."status" = 'abandoned' and "synthesis_preparations"."finalized_synthesis_revision_id" is null and "synthesis_preparations"."finalized_at" is null and "synthesis_preparations"."abandoned_at" is not null)
      ))
);
--> statement-breakpoint
ALTER TABLE "synthesis_preparation_selections" ADD CONSTRAINT "synthesis_preparation_selections_project_preparation_fk" FOREIGN KEY ("project_id","preparation_id") REFERENCES "public"."synthesis_preparations"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_preparation_selections" ADD CONSTRAINT "synthesis_preparation_selections_project_extraction_revision_fk" FOREIGN KEY ("project_id","extraction_revision_id") REFERENCES "public"."extraction_value_revisions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_preparations" ADD CONSTRAINT "synthesis_preparations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_preparations" ADD CONSTRAINT "synthesis_preparations_project_evidence_set_fk" FOREIGN KEY ("project_id","evidence_set_id") REFERENCES "public"."evidence_sets"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_preparations" ADD CONSTRAINT "synthesis_preparations_project_composition_revision_fk" FOREIGN KEY ("project_id","evidence_set_id","evidence_set_composition_revision_id") REFERENCES "public"."evidence_set_composition_revisions"("project_id","evidence_set_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_preparations" ADD CONSTRAINT "synthesis_preparations_project_field_fk" FOREIGN KEY ("project_id","extraction_field_id") REFERENCES "public"."extraction_fields"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_preparations" ADD CONSTRAINT "synthesis_preparations_project_target_statement_fk" FOREIGN KEY ("project_id","target_synthesis_statement_id") REFERENCES "public"."synthesis_statements"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_preparations" ADD CONSTRAINT "synthesis_preparations_project_finalized_revision_fk" FOREIGN KEY ("project_id","target_synthesis_statement_id","finalized_synthesis_revision_id") REFERENCES "public"."synthesis_revisions"("project_id","synthesis_statement_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "synthesis_preparation_selections_project_preparation_idx" ON "synthesis_preparation_selections" USING btree ("project_id","preparation_id");--> statement-breakpoint
CREATE INDEX "synthesis_preparation_selections_project_extraction_revision_idx" ON "synthesis_preparation_selections" USING btree ("project_id","extraction_revision_id");--> statement-breakpoint
CREATE INDEX "synthesis_preparations_project_created_at_idx" ON "synthesis_preparations" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "synthesis_preparations_project_status_idx" ON "synthesis_preparations" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "synthesis_preparations_project_set_idx" ON "synthesis_preparations" USING btree ("project_id","evidence_set_id");--> statement-breakpoint
CREATE INDEX "synthesis_preparations_project_field_idx" ON "synthesis_preparations" USING btree ("project_id","extraction_field_id");--> statement-breakpoint
CREATE UNIQUE INDEX "synthesis_preparations_finalized_revision_unique" ON "synthesis_preparations" USING btree ("project_id","finalized_synthesis_revision_id") WHERE "synthesis_preparations"."finalized_synthesis_revision_id" is not null;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_synthesis_preparation_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'synthesis preparations must be created with active status' USING ERRCODE = '23514';
    END IF;
    IF NEW.finalized_synthesis_revision_id IS NOT NULL OR NEW.finalized_at IS NOT NULL OR NEW.abandoned_at IS NOT NULL THEN
      RAISE EXCEPTION 'synthesis preparations cannot be created with finalized or abandoned state' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'synthesis preparations cannot be deleted' USING ERRCODE = '23514';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.evidence_set_id IS DISTINCT FROM OLD.evidence_set_id
    OR NEW.evidence_set_composition_revision_id IS DISTINCT FROM OLD.evidence_set_composition_revision_id
    OR NEW.extraction_field_id IS DISTINCT FROM OLD.extraction_field_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'synthesis preparation identity and pinning are immutable' USING ERRCODE = '23514';
  END IF;

  IF OLD.status IN ('finalized', 'abandoned') THEN
    RAISE EXCEPTION 'terminal synthesis preparations are immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (OLD.status = 'active' AND NEW.status IN ('finalized', 'abandoned')) THEN
      RAISE EXCEPTION 'synthesis preparations only support active -> finalized or active -> abandoned' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD.status = 'active' AND NEW.status = 'active' THEN
    IF NEW.finalized_synthesis_revision_id IS NOT NULL OR NEW.finalized_at IS NOT NULL OR NEW.abandoned_at IS NOT NULL THEN
      RAISE EXCEPTION 'active synthesis preparations cannot receive terminal attributes' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD.status = 'active' AND NEW.status = 'abandoned' THEN
    IF NEW.finalized_synthesis_revision_id IS NOT NULL OR NEW.finalized_at IS NOT NULL OR NEW.abandoned_at IS NULL THEN
      RAISE EXCEPTION 'abandoned synthesis preparations require abandoned_at without finalized revision' USING ERRCODE = '23514';
    END IF;
    IF NEW.working_title IS DISTINCT FROM OLD.working_title
      OR NEW.working_note IS DISTINCT FROM OLD.working_note
      OR NEW.target_synthesis_statement_id IS DISTINCT FROM OLD.target_synthesis_statement_id THEN
      RAISE EXCEPTION 'abandoning a synthesis preparation cannot alter working metadata' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD.status = 'active' AND NEW.status = 'finalized' THEN
    IF NEW.target_synthesis_statement_id IS NULL
      OR NEW.finalized_synthesis_revision_id IS NULL
      OR NEW.finalized_at IS NULL
      OR NEW.abandoned_at IS NOT NULL THEN
      RAISE EXCEPTION 'finalized synthesis preparations require target statement, finalized revision, and finalized_at' USING ERRCODE = '23514';
    END IF;
    IF NEW.working_title IS DISTINCT FROM OLD.working_title
      OR NEW.working_note IS DISTINCT FROM OLD.working_note THEN
      RAISE EXCEPTION 'finalizing a synthesis preparation cannot alter working metadata' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint

CREATE TRIGGER synthesis_preparations_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON synthesis_preparations
FOR EACH ROW EXECUTE FUNCTION prevent_synthesis_preparation_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION synthesis_preparation_selections_guard() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  prep_status text;
  prep_evidence_set_id uuid;
  prep_composition_revision_id uuid;
  prep_field_id uuid;
  rev_project_id uuid;
  rev_field_id uuid;
  rev_finalized_at timestamptz;
  is_reachable boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'synthesis preparation selections are immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT status INTO prep_status
    FROM synthesis_preparations
    WHERE project_id = OLD.project_id AND id = OLD.preparation_id
    FOR UPDATE;
    IF prep_status IS NULL THEN
      RAISE EXCEPTION 'synthesis preparation does not belong to this project' USING ERRCODE = '23503';
    END IF;
    IF prep_status <> 'active' THEN
      RAISE EXCEPTION 'selections cannot be removed from a terminal synthesis preparation' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT status, evidence_set_id, evidence_set_composition_revision_id, extraction_field_id
    INTO prep_status, prep_evidence_set_id, prep_composition_revision_id, prep_field_id
    FROM synthesis_preparations
    WHERE project_id = NEW.project_id AND id = NEW.preparation_id
    FOR UPDATE;
    IF prep_status IS NULL THEN
      RAISE EXCEPTION 'synthesis preparation does not belong to this project' USING ERRCODE = '23503';
    END IF;
    IF prep_status <> 'active' THEN
      RAISE EXCEPTION 'selections can only be added to an active synthesis preparation' USING ERRCODE = '23514';
    END IF;

    -- Check extraction revision ownership, finalized status, and EXACT field equality
    -- Join through extraction_value_revisions -> extraction_values -> extraction_fields
    SELECT r.project_id, r.field_id, r.finalized_at
    INTO rev_project_id, rev_field_id, rev_finalized_at
    FROM extraction_value_revisions r
    JOIN extraction_values v ON v.project_id = r.project_id AND v.id = r.extraction_value_id AND v.field_id = r.field_id
    WHERE r.project_id = NEW.project_id AND r.id = NEW.extraction_revision_id;

    IF rev_project_id IS NULL THEN
      RAISE EXCEPTION 'extraction revision does not belong to this project' USING ERRCODE = '23503';
    END IF;
    IF rev_finalized_at IS NULL THEN
      RAISE EXCEPTION 'only finalized extraction revisions can be selected' USING ERRCODE = '23514';
    END IF;
    IF rev_field_id IS DISTINCT FROM prep_field_id THEN
      RAISE EXCEPTION 'selected extraction revision does not match preparation extraction field' USING ERRCODE = '23514';
    END IF;

    -- Reachability through pinned EvidenceSet composition:
    -- pinned composition member → stable membership → Evidence → extraction_revision_evidence → ExtractionRevision
    SELECT EXISTS (
      SELECT 1
      FROM evidence_set_composition_members cm
      JOIN evidence_set_memberships m ON m.project_id = cm.project_id AND m.evidence_set_id = cm.evidence_set_id AND m.id = cm.membership_id
      JOIN evidence e ON e.project_id = m.project_id AND e.id = m.evidence_id
      JOIN extraction_revision_evidence ere ON ere.project_id = e.project_id AND ere.evidence_id = e.id AND ere.revision_id = NEW.extraction_revision_id
      WHERE cm.project_id = NEW.project_id
        AND cm.evidence_set_id = prep_evidence_set_id
        AND cm.composition_revision_id = prep_composition_revision_id
    ) INTO is_reachable;

    IF NOT is_reachable THEN
      RAISE EXCEPTION 'selected extraction revision is not reachable from pinned evidence set composition' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint

CREATE TRIGGER synthesis_preparation_selections_trigger
BEFORE INSERT OR UPDATE OR DELETE ON synthesis_preparation_selections
FOR EACH ROW EXECUTE FUNCTION synthesis_preparation_selections_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_synthesis_preparation_finalization() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  rev_state text;
  rev_finalized_at timestamptz;
  selection_count integer;
  support_count integer;
  has_mismatch boolean;
BEGIN
  IF NEW.status = 'finalized' THEN
    SELECT state, finalized_at
    INTO rev_state, rev_finalized_at
    FROM synthesis_revisions
    WHERE project_id = NEW.project_id
      AND synthesis_statement_id = NEW.target_synthesis_statement_id
      AND id = NEW.finalized_synthesis_revision_id;

    IF rev_state IS NULL THEN
      RAISE EXCEPTION 'finalized synthesis revision does not belong to target statement and project' USING ERRCODE = '23503';
    END IF;
    IF rev_state <> 'active' OR rev_finalized_at IS NULL THEN
      RAISE EXCEPTION 'finalized synthesis revision must be active and finalized' USING ERRCODE = '23514';
    END IF;

    SELECT count(*)::integer INTO selection_count
    FROM synthesis_preparation_selections
    WHERE project_id = NEW.project_id AND preparation_id = NEW.id;

    SELECT count(*)::integer INTO support_count
    FROM synthesis_revision_supports
    WHERE project_id = NEW.project_id AND synthesis_revision_id = NEW.finalized_synthesis_revision_id;

    IF selection_count <> support_count THEN
      RAISE EXCEPTION 'preparation selections count (%) does not match finalized synthesis revision supports count (%)', selection_count, support_count USING ERRCODE = '23514';
    END IF;

    SELECT (
      EXISTS (
        SELECT extraction_revision_id FROM synthesis_preparation_selections
        WHERE project_id = NEW.project_id AND preparation_id = NEW.id
        EXCEPT
        SELECT extraction_revision_id FROM synthesis_revision_supports
        WHERE project_id = NEW.project_id AND synthesis_revision_id = NEW.finalized_synthesis_revision_id
      )
      OR
      EXISTS (
        SELECT extraction_revision_id FROM synthesis_revision_supports
        WHERE project_id = NEW.project_id AND synthesis_revision_id = NEW.finalized_synthesis_revision_id
        EXCEPT
        SELECT extraction_revision_id FROM synthesis_preparation_selections
        WHERE project_id = NEW.project_id AND preparation_id = NEW.id
      )
    ) INTO has_mismatch;

    IF has_mismatch THEN
      RAISE EXCEPTION 'preparation selections must exactly match finalized synthesis revision supports' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER synthesis_preparations_finalization_validation
AFTER INSERT OR UPDATE ON synthesis_preparations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_synthesis_preparation_finalization();
