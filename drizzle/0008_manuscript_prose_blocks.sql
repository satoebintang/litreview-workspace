CREATE TABLE "manuscript_prose_blocks" (
 	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"manuscript_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
 	"section_item_id" uuid NOT NULL,
	"item_type" text DEFAULT 'prose' NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manuscript_prose_blocks_item_type_valid" CHECK ("manuscript_prose_blocks"."item_type" = 'prose'),
	CONSTRAINT "manuscript_prose_blocks_text_nonblank" CHECK (btrim("manuscript_prose_blocks"."text") <> ''),
 	CONSTRAINT "manuscript_prose_blocks_text_length_valid" CHECK (char_length("manuscript_prose_blocks"."text") <= 50000),
 	CONSTRAINT "manuscript_prose_blocks_section_item_unique" UNIQUE("section_item_id")
);
--> statement-breakpoint
CREATE TABLE "manuscript_section_item_claims" (
 "section_item_id" uuid PRIMARY KEY NOT NULL,
 "project_id" uuid NOT NULL,
 "manuscript_id" uuid NOT NULL,
 "section_id" uuid NOT NULL,
 "item_type" text DEFAULT 'claim' NOT NULL,
	"placement_id" uuid NOT NULL,
	CONSTRAINT "manuscript_section_item_claims_id_matches_placement" CHECK ("manuscript_section_item_claims"."section_item_id" = "manuscript_section_item_claims"."placement_id"),
	CONSTRAINT "manuscript_section_item_claims_item_type_valid" CHECK ("manuscript_section_item_claims"."item_type" = 'claim')
);
--> statement-breakpoint
CREATE TABLE "manuscript_section_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"manuscript_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "manuscript_section_items_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "manuscript_section_items_project_id_id_type_unique" UNIQUE("project_id","id","item_type"),
	CONSTRAINT "manuscript_section_items_project_manuscript_section_id_unique" UNIQUE("project_id","manuscript_id","section_id","id"),
	CONSTRAINT "manuscript_section_items_project_manuscript_section_id_type_unique" UNIQUE("project_id","manuscript_id","section_id","id","item_type"),
	CONSTRAINT "manuscript_section_items_item_type_valid" CHECK ("manuscript_section_items"."item_type" in ('claim', 'prose')),
	CONSTRAINT "manuscript_section_items_sort_order_valid" CHECK ("manuscript_section_items"."sort_order" >= 0)
);
--> statement-breakpoint
-- Slice 6 placements remain the source of truth for this one-time backfill.
-- Removed placements intentionally receive no SectionItem: Slice 7 does not
-- reconstruct historical full-manuscript ordering for pre-migration removals.
INSERT INTO "manuscript_section_items" (
  id, project_id, manuscript_id, section_id, item_type, sort_order, created_at
)
SELECT
  p.id,
  p.project_id,
  p.manuscript_id,
  p.section_id,
  'claim',
  row_number() OVER (
    PARTITION BY p.project_id, p.manuscript_id, p.section_id
    ORDER BY p.sort_order, p.id
  ) - 1,
  p.created_at
FROM "manuscript_claim_placements" p
WHERE p.removed_at IS NULL;
--> statement-breakpoint
INSERT INTO "manuscript_section_item_claims" (
  section_item_id, project_id, manuscript_id, section_id, item_type, placement_id
)
SELECT p.id, p.project_id, p.manuscript_id, p.section_id, 'claim', p.id
FROM "manuscript_claim_placements" p
WHERE p.removed_at IS NULL;
--> statement-breakpoint
DO $function$
DECLARE
  expected_count bigint;
  actual_count bigint;
  mismatch_count bigint;
BEGIN
  SELECT count(*) INTO expected_count
  FROM "manuscript_claim_placements"
  WHERE removed_at IS NULL;

  SELECT count(*) INTO actual_count
  FROM "manuscript_section_item_claims" c
  JOIN "manuscript_section_items" i ON i.id = c.section_item_id
  WHERE i.item_type = 'claim' AND i.removed_at IS NULL;

  IF expected_count <> actual_count THEN
    RAISE EXCEPTION 'Slice 7 Claim SectionItem backfill count mismatch: expected %, got %', expected_count, actual_count;
  END IF;

  SELECT count(*) INTO mismatch_count
  FROM (
    SELECT p.id,
      row_number() OVER (
        PARTITION BY p.project_id, p.manuscript_id, p.section_id
        ORDER BY p.sort_order, p.id
      ) - 1 AS expected_order,
      i.sort_order AS actual_order
    FROM "manuscript_claim_placements" p
    JOIN "manuscript_section_items" i
      ON i.id = p.id
     AND i.project_id = p.project_id
     AND i.manuscript_id = p.manuscript_id
     AND i.section_id = p.section_id
     AND i.item_type = 'claim'
    WHERE p.removed_at IS NULL
  ) mapped
  WHERE mapped.expected_order <> mapped.actual_order;

  IF mismatch_count <> 0 THEN
    RAISE EXCEPTION 'Slice 7 Claim SectionItem backfill ordering mismatch: % rows', mismatch_count;
  END IF;

  SELECT count(*) INTO mismatch_count
  FROM "manuscript_claim_placements" p
  WHERE p.removed_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM "manuscript_section_items" i WHERE i.id = p.id);

  IF mismatch_count <> 0 THEN
    RAISE EXCEPTION 'Slice 7 backfill created items for % pre-migration removed placements', mismatch_count;
  END IF;
END;
$function$;
--> statement-breakpoint
-- Replace the Slice 6 guard before removing its legacy ordering column.
CREATE OR REPLACE FUNCTION enforce_manuscript_claim_placement_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Manuscript placements are removed by soft removal';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'New manuscript placements must start active';
    END IF;
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
    IF NEW.claim_revision_id IS DISTINCT FROM OLD.claim_revision_id
      OR NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
      RAISE EXCEPTION 'Removed manuscript placements cannot be restored or replaced';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.claim_revision_id IS DISTINCT FROM OLD.claim_revision_id
    AND NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
    RAISE EXCEPTION 'Placement replacement and removal must be separate operations';
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
ALTER TABLE "manuscript_claim_placements" ADD CONSTRAINT "manuscript_claim_placements_project_manuscript_section_id_unique" UNIQUE("project_id","manuscript_id","section_id","id");
--> statement-breakpoint
ALTER TABLE "manuscript_claim_placements" DROP CONSTRAINT "manuscript_claim_placements_sort_order_valid";--> statement-breakpoint
DROP INDEX "manuscript_claim_placements_project_section_order_idx";--> statement-breakpoint
DROP INDEX "manuscript_claim_placements_project_manuscript_order_idx";--> statement-breakpoint
ALTER TABLE "manuscript_prose_blocks" ADD CONSTRAINT "manuscript_prose_blocks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_prose_blocks" ADD CONSTRAINT "manuscript_prose_blocks_parent_fk" FOREIGN KEY ("project_id","manuscript_id","section_id","section_item_id","item_type") REFERENCES "public"."manuscript_section_items"("project_id","manuscript_id","section_id","id","item_type") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_section_item_claims" ADD CONSTRAINT "manuscript_section_item_claims_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_section_item_claims" ADD CONSTRAINT "manuscript_section_item_claims_parent_fk" FOREIGN KEY ("project_id","manuscript_id","section_id","section_item_id","item_type") REFERENCES "public"."manuscript_section_items"("project_id","manuscript_id","section_id","id","item_type") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_section_item_claims" ADD CONSTRAINT "manuscript_section_item_claims_placement_fk" FOREIGN KEY ("project_id","manuscript_id","section_id","placement_id") REFERENCES "public"."manuscript_claim_placements"("project_id","manuscript_id","section_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_section_items" ADD CONSTRAINT "manuscript_section_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_section_items" ADD CONSTRAINT "manuscript_section_items_project_manuscript_section_fk" FOREIGN KEY ("project_id","manuscript_id","section_id") REFERENCES "public"."manuscript_sections"("project_id","manuscript_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "manuscript_section_items_project_manuscript_section_order_idx" ON "manuscript_section_items" USING btree ("project_id","manuscript_id","section_id","sort_order","id");--> statement-breakpoint
ALTER TABLE "manuscript_claim_placements" DROP COLUMN "sort_order";--> statement-breakpoint
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_manuscript_section_item_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Manuscript SectionItems are retained; remove the target content instead';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'New manuscript SectionItems must start active';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.manuscript_id IS DISTINCT FROM OLD.manuscript_id
    OR NEW.section_id IS DISTINCT FROM OLD.section_id
    OR NEW.item_type IS DISTINCT FROM OLD.item_type
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Manuscript SectionItem identity is immutable';
  END IF;

  IF OLD.removed_at IS NOT NULL THEN
    IF NEW.removed_at IS DISTINCT FROM OLD.removed_at
      OR NEW.sort_order IS DISTINCT FROM OLD.sort_order THEN
      RAISE EXCEPTION 'Removed manuscript SectionItems cannot be restored or reordered';
    END IF;
  ELSIF NEW.removed_at IS NOT NULL AND NEW.removed_at < OLD.created_at THEN
    RAISE EXCEPTION 'SectionItem removal timestamp must follow creation';
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER manuscript_section_items_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON manuscript_section_items
FOR EACH ROW EXECUTE FUNCTION prevent_manuscript_section_item_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_manuscript_section_item_subtype_delete() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Manuscript SectionItem subtype rows are retained';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER manuscript_section_item_claims_no_delete
BEFORE DELETE ON manuscript_section_item_claims
FOR EACH ROW EXECUTE FUNCTION prevent_manuscript_section_item_subtype_delete();
--> statement-breakpoint
CREATE TRIGGER manuscript_prose_blocks_no_delete
BEFORE DELETE ON manuscript_prose_blocks
FOR EACH ROW EXECUTE FUNCTION prevent_manuscript_section_item_subtype_delete();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_manuscript_prose_block_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Manuscript prose blocks are removed by soft removal';
  END IF;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF NEW.section_item_id IS DISTINCT FROM OLD.section_item_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.manuscript_id IS DISTINCT FROM OLD.manuscript_id
    OR NEW.section_id IS DISTINCT FROM OLD.section_id
    OR NEW.item_type IS DISTINCT FROM OLD.item_type
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Manuscript prose block identity is immutable';
  END IF;

  IF EXISTS (
    SELECT 1 FROM manuscript_section_items i
    WHERE i.id = OLD.section_item_id AND i.removed_at IS NOT NULL
  ) AND (NEW.text IS DISTINCT FROM OLD.text OR NEW.updated_at IS DISTINCT FROM OLD.updated_at) THEN
    RAISE EXCEPTION 'Removed manuscript prose blocks cannot be edited';
  END IF;

  IF NEW.text IS DISTINCT FROM OLD.text AND NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Prose block updated_at cannot move backwards';
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER manuscript_prose_blocks_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON manuscript_prose_blocks
FOR EACH ROW EXECUTE FUNCTION enforce_manuscript_prose_block_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_manuscript_section_item_complete() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  parent_item_id uuid;
  parent_project uuid;
  parent_type text;
  claim_count integer;
  prose_count integer;
BEGIN
  IF TG_TABLE_NAME = 'manuscript_section_items' THEN
    parent_item_id := NEW.id;
    parent_project := NEW.project_id;
    parent_type := NEW.item_type;
  ELSIF TG_TABLE_NAME = 'manuscript_section_item_claims' THEN
    parent_item_id := NEW.section_item_id;
    SELECT i.project_id, i.item_type
      INTO parent_project, parent_type
    FROM manuscript_section_items i
    WHERE i.id = NEW.section_item_id;
    IF parent_type IS NULL THEN
      RAISE EXCEPTION 'SectionItem subtype requires an existing parent';
    END IF;
  ELSE
    parent_item_id := NEW.section_item_id;
    SELECT i.project_id, i.item_type
      INTO parent_project, parent_type
    FROM manuscript_section_items i
    WHERE i.id = NEW.section_item_id;
    IF parent_type IS NULL THEN
      RAISE EXCEPTION 'SectionItem subtype requires an existing parent';
    END IF;
  END IF;

  SELECT count(*) INTO claim_count
  FROM manuscript_section_item_claims c
  WHERE c.project_id = parent_project
    AND c.section_item_id = parent_item_id;

  SELECT count(*) INTO prose_count
  FROM manuscript_prose_blocks p
  WHERE p.project_id = parent_project
    AND p.section_item_id = parent_item_id;

  IF parent_type = 'claim' AND (claim_count <> 1 OR prose_count <> 0) THEN
    RAISE EXCEPTION 'Claim SectionItem must have exactly one claim subtype and no prose subtype';
  ELSIF parent_type = 'prose' AND (prose_count <> 1 OR claim_count <> 0) THEN
    RAISE EXCEPTION 'Prose SectionItem must have exactly one prose subtype and no claim subtype';
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER manuscript_section_items_complete
AFTER INSERT OR UPDATE ON manuscript_section_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_manuscript_section_item_complete();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER manuscript_section_item_claims_complete
AFTER INSERT OR UPDATE ON manuscript_section_item_claims
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_manuscript_section_item_complete();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER manuscript_prose_blocks_complete
AFTER INSERT OR UPDATE ON manuscript_prose_blocks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_manuscript_section_item_complete();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_manuscript_claim_placement_section_item() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  target_item_id uuid;
  target_project_id uuid;
  item_removed_at timestamptz;
  item_type text;
  placement_removed_at timestamptz;
  placement_exists boolean;
BEGIN
  target_item_id := NEW.id;
  target_project_id := NEW.project_id;

  SELECT i.removed_at, i.item_type
    INTO item_removed_at, item_type
  FROM manuscript_section_items i
  WHERE i.id = target_item_id
    AND i.project_id = target_project_id;

  SELECT EXISTS (
    SELECT 1 FROM manuscript_claim_placements p
    WHERE p.id = target_item_id
      AND p.project_id = target_project_id
  ), (
    SELECT p.removed_at
    FROM manuscript_claim_placements p
    WHERE p.id = target_item_id
      AND p.project_id = target_project_id
  ) INTO placement_exists, placement_removed_at;

  IF item_type IS NOT NULL AND item_type <> 'claim' THEN
    RETURN NEW;
  END IF;

  IF NEW.removed_at IS NULL AND item_type IS NULL THEN
    RAISE EXCEPTION 'Active ClaimPlacement must have a Claim SectionItem';
  END IF;

  IF item_type IS NOT NULL AND item_removed_at IS DISTINCT FROM NEW.removed_at THEN
    RAISE EXCEPTION 'ClaimPlacement and Claim SectionItem removal markers must match';
  END IF;

  IF item_type = 'claim' AND (NOT placement_exists OR placement_removed_at IS DISTINCT FROM item_removed_at) THEN
    RAISE EXCEPTION 'Claim SectionItem and ClaimPlacement removal markers must match';
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER manuscript_claim_placements_section_item_parity
AFTER INSERT OR UPDATE ON manuscript_claim_placements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_manuscript_claim_placement_section_item();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER manuscript_section_items_claim_placement_parity
AFTER INSERT OR UPDATE ON manuscript_section_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_manuscript_claim_placement_section_item();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_manuscript_section_archive_with_items() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM manuscript_section_items i
      WHERE i.project_id = NEW.project_id
        AND i.manuscript_id = NEW.manuscript_id
        AND i.section_id = NEW.id
        AND i.removed_at IS NULL
    ) THEN
    RAISE EXCEPTION 'Sections with active manuscript items cannot be archived';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER manuscript_sections_archive_guard
BEFORE UPDATE OF archived_at ON manuscript_sections
FOR EACH ROW EXECUTE FUNCTION prevent_manuscript_section_archive_with_items();
