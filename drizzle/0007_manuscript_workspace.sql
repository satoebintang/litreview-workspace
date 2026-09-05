CREATE TABLE "manuscript_claim_placement_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "manuscript_claim_placement_events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"manuscript_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"placement_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"from_claim_revision_id" uuid,
	"to_claim_revision_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manuscript_claim_placement_events_placement_sequence_uq" UNIQUE("project_id","placement_id","sequence"),
	CONSTRAINT "manuscript_claim_placement_events_event_type_valid" CHECK ("manuscript_claim_placement_events"."event_type" in ('placed', 'replaced', 'removed')),
	CONSTRAINT "manuscript_claim_placement_events_shape_valid" CHECK ((
      ("manuscript_claim_placement_events"."event_type" = 'placed' and "manuscript_claim_placement_events"."from_claim_revision_id" is null and "manuscript_claim_placement_events"."to_claim_revision_id" is not null)
      or ("manuscript_claim_placement_events"."event_type" = 'replaced' and "manuscript_claim_placement_events"."from_claim_revision_id" is not null and "manuscript_claim_placement_events"."to_claim_revision_id" is not null and "manuscript_claim_placement_events"."from_claim_revision_id" <> "manuscript_claim_placement_events"."to_claim_revision_id")
      or ("manuscript_claim_placement_events"."event_type" = 'removed' and "manuscript_claim_placement_events"."from_claim_revision_id" is not null and "manuscript_claim_placement_events"."to_claim_revision_id" is null)
    ))
);
--> statement-breakpoint
CREATE TABLE "manuscript_claim_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"manuscript_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"claim_revision_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "manuscript_claim_placements_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "manuscript_claim_placements_project_section_id_id_unique" UNIQUE("project_id","section_id","id"),
	CONSTRAINT "manuscript_claim_placements_project_manuscript_id_id_unique" UNIQUE("project_id","manuscript_id","id"),
	CONSTRAINT "manuscript_claim_placements_claim_revision_uq" UNIQUE("project_id","claim_id","claim_revision_id","id"),
	CONSTRAINT "manuscript_claim_placements_sort_order_valid" CHECK ("manuscript_claim_placements"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "manuscript_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"manuscript_id" uuid NOT NULL,
	"title" text NOT NULL,
	"section_type" text DEFAULT 'custom' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "manuscript_sections_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "manuscript_sections_project_manuscript_id_id_unique" UNIQUE("project_id","manuscript_id","id"),
	CONSTRAINT "manuscript_sections_section_type_valid" CHECK ("manuscript_sections"."section_type" in ('introduction', 'methods', 'results', 'discussion', 'limitations', 'conclusion', 'custom')),
	CONSTRAINT "manuscript_sections_title_nonblank" CHECK (btrim("manuscript_sections"."title") <> ''),
	CONSTRAINT "manuscript_sections_sort_order_valid" CHECK ("manuscript_sections"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "manuscripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text DEFAULT 'Manuscript' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manuscripts_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "manuscripts_title_nonblank" CHECK (btrim("manuscripts"."title") <> '')
);
--> statement-breakpoint
ALTER TABLE "manuscript_claim_placement_events" ADD CONSTRAINT "manuscript_claim_placement_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_claim_placement_events" ADD CONSTRAINT "manuscript_claim_placement_events_project_placement_fk" FOREIGN KEY ("project_id","placement_id") REFERENCES "public"."manuscript_claim_placements"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_claim_placement_events" ADD CONSTRAINT "manuscript_claim_placement_events_project_manuscript_fk" FOREIGN KEY ("project_id","manuscript_id") REFERENCES "public"."manuscripts"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_claim_placement_events" ADD CONSTRAINT "manuscript_claim_placement_events_project_manuscript_section_fk" FOREIGN KEY ("project_id","manuscript_id","section_id") REFERENCES "public"."manuscript_sections"("project_id","manuscript_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_claim_placement_events" ADD CONSTRAINT "manuscript_claim_placement_events_project_claim_fk" FOREIGN KEY ("project_id","claim_id") REFERENCES "public"."claims"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_claim_placement_events" ADD CONSTRAINT "manuscript_claim_placement_events_project_from_revision_fk" FOREIGN KEY ("project_id","claim_id","from_claim_revision_id") REFERENCES "public"."claim_revisions"("project_id","claim_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_claim_placement_events" ADD CONSTRAINT "manuscript_claim_placement_events_project_to_revision_fk" FOREIGN KEY ("project_id","claim_id","to_claim_revision_id") REFERENCES "public"."claim_revisions"("project_id","claim_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_claim_placements" ADD CONSTRAINT "manuscript_claim_placements_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_claim_placements" ADD CONSTRAINT "manuscript_claim_placements_project_manuscript_section_fk" FOREIGN KEY ("project_id","manuscript_id","section_id") REFERENCES "public"."manuscript_sections"("project_id","manuscript_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_claim_placements" ADD CONSTRAINT "manuscript_claim_placements_project_claim_revision_fk" FOREIGN KEY ("project_id","claim_id","claim_revision_id") REFERENCES "public"."claim_revisions"("project_id","claim_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_sections" ADD CONSTRAINT "manuscript_sections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_sections" ADD CONSTRAINT "manuscript_sections_project_manuscript_fk" FOREIGN KEY ("project_id","manuscript_id") REFERENCES "public"."manuscripts"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscripts" ADD CONSTRAINT "manuscripts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "manuscript_claim_placement_events_project_placement_idx" ON "manuscript_claim_placement_events" USING btree ("project_id","placement_id","sequence");--> statement-breakpoint
CREATE INDEX "manuscript_claim_placements_project_section_order_idx" ON "manuscript_claim_placements" USING btree ("project_id","section_id","sort_order","id");--> statement-breakpoint
CREATE INDEX "manuscript_claim_placements_project_manuscript_order_idx" ON "manuscript_claim_placements" USING btree ("project_id","manuscript_id","sort_order","id");--> statement-breakpoint
CREATE UNIQUE INDEX "manuscript_claim_placements_active_revision_unique" ON "manuscript_claim_placements" USING btree ("project_id","section_id","claim_revision_id") WHERE "manuscript_claim_placements"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "manuscript_sections_project_manuscript_order_idx" ON "manuscript_sections" USING btree ("project_id","manuscript_id","sort_order","id");--> statement-breakpoint
CREATE INDEX "manuscripts_project_created_at_idx" ON "manuscripts" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "manuscripts_project_default_unique" ON "manuscripts" USING btree ("project_id") WHERE "manuscripts"."is_default" = true;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_manuscript_container_delete() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Manuscripts and Sections are not deleted; archive or retain their history';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER manuscripts_no_delete
BEFORE DELETE ON manuscripts
FOR EACH ROW EXECUTE FUNCTION prevent_manuscript_container_delete();
--> statement-breakpoint
CREATE TRIGGER manuscript_sections_no_delete
BEFORE DELETE ON manuscript_sections
FOR EACH ROW EXECUTE FUNCTION prevent_manuscript_container_delete();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_manuscript_claim_placement_target(
  target_project_id uuid,
  target_claim_id uuid,
  target_claim_revision_id uuid
) RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  latest_state text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM claim_revisions r
    WHERE r.project_id = target_project_id
      AND r.claim_id = target_claim_id
      AND r.id = target_claim_revision_id
      AND r.state = 'active'
      AND r.finalized_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Manuscript placement must reference a finalized active Claim revision';
  END IF;

  SELECT r.state INTO latest_state
  FROM claim_revisions r
  WHERE r.project_id = target_project_id
    AND r.claim_id = target_claim_id
    AND r.finalized_at IS NOT NULL
  ORDER BY r.sequence DESC
  LIMIT 1;

  IF latest_state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Manuscript placement requires a currently active Claim';
  END IF;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_manuscript_claim_placement_event_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' OR pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Manuscript placement events are append-only';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER manuscript_claim_placement_events_append_only
BEFORE INSERT OR UPDATE OR DELETE ON manuscript_claim_placement_events
FOR EACH ROW EXECUTE FUNCTION prevent_manuscript_claim_placement_event_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_manuscript_claim_placement_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Manuscript placements are removed by soft removal';
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM validate_manuscript_claim_placement_target(NEW.project_id, NEW.claim_id, NEW.claim_revision_id);
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.manuscript_id IS DISTINCT FROM OLD.manuscript_id
    OR NEW.section_id IS DISTINCT FROM OLD.section_id
    OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Manuscript placement identity is immutable';
  END IF;

  IF OLD.removed_at IS NOT NULL THEN
    IF NEW.sort_order IS DISTINCT FROM OLD.sort_order
      OR NEW.claim_revision_id IS DISTINCT FROM OLD.claim_revision_id
      OR NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
      RAISE EXCEPTION 'Removed manuscript placements cannot be restored, replaced, or reordered';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.claim_revision_id IS DISTINCT FROM OLD.claim_revision_id
    AND NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
    RAISE EXCEPTION 'Placement replacement and removal must be separate operations';
  END IF;

  IF NEW.sort_order IS DISTINCT FROM OLD.sort_order
    AND NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
    RAISE EXCEPTION 'Placement reorder and removal must be separate operations';
  END IF;

  IF NEW.claim_revision_id IS DISTINCT FROM OLD.claim_revision_id THEN
    PERFORM validate_manuscript_claim_placement_target(NEW.project_id, NEW.claim_id, NEW.claim_revision_id);
    IF NOT EXISTS (
      SELECT 1
      FROM claim_revisions old_revision
      JOIN claim_revisions new_revision
        ON new_revision.project_id = old_revision.project_id
       AND new_revision.claim_id = old_revision.claim_id
      WHERE old_revision.project_id = OLD.project_id
        AND old_revision.id = OLD.claim_revision_id
        AND new_revision.id = NEW.claim_revision_id
        AND new_revision.sequence > old_revision.sequence
    ) THEN
      RAISE EXCEPTION 'Placement replacement must target a higher Claim revision sequence';
    END IF;
  END IF;

  IF NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
    IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL THEN
      RAISE EXCEPTION 'Placement removal is a one-way NULL to timestamp transition';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER manuscript_claim_placements_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON manuscript_claim_placements
FOR EACH ROW EXECUTE FUNCTION enforce_manuscript_claim_placement_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_manuscript_claim_placement_event() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO manuscript_claim_placement_events (
      project_id, manuscript_id, section_id, placement_id, claim_id,
      event_type, from_claim_revision_id, to_claim_revision_id
    ) VALUES (
      NEW.project_id, NEW.manuscript_id, NEW.section_id, NEW.id, NEW.claim_id,
      'placed', NULL, NEW.claim_revision_id
    );
  ELSIF NEW.claim_revision_id IS DISTINCT FROM OLD.claim_revision_id THEN
    INSERT INTO manuscript_claim_placement_events (
      project_id, manuscript_id, section_id, placement_id, claim_id,
      event_type, from_claim_revision_id, to_claim_revision_id
    ) VALUES (
      NEW.project_id, NEW.manuscript_id, NEW.section_id, NEW.id, NEW.claim_id,
      'replaced', OLD.claim_revision_id, NEW.claim_revision_id
    );
  ELSIF NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
    INSERT INTO manuscript_claim_placement_events (
      project_id, manuscript_id, section_id, placement_id, claim_id,
      event_type, from_claim_revision_id, to_claim_revision_id
    ) VALUES (
      NEW.project_id, NEW.manuscript_id, NEW.section_id, NEW.id, NEW.claim_id,
      'removed', OLD.claim_revision_id, NULL
    );
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER manuscript_claim_placements_event_recorder
AFTER INSERT OR UPDATE ON manuscript_claim_placements
FOR EACH ROW EXECUTE FUNCTION record_manuscript_claim_placement_event();
