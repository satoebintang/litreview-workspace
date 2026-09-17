-- Slice 24: immutable manuscript Prose content history.
-- The first row for each existing ProseBlock is a reconstructed baseline. Its
-- created_at is the best available timestamp associated with the content
-- present at this migration (legacy updated_at); it is not proof of original
-- creation, historical Revision 1, or complete pre-Slice-24 edit history.
ALTER TABLE "manuscript_prose_blocks"
  ADD CONSTRAINT "manuscript_prose_blocks_project_id_id_unique" UNIQUE ("project_id", "id");
--> statement-breakpoint
DO $function$
DECLARE identity_mismatch_count bigint;
BEGIN
  SELECT count(*) INTO identity_mismatch_count
  FROM manuscript_prose_blocks
  WHERE id IS DISTINCT FROM section_item_id;
  IF identity_mismatch_count <> 0 THEN
    RAISE EXCEPTION 'Slice 24 Prose identity validation failed before constraint installation';
  END IF;
END;
$function$;
--> statement-breakpoint
ALTER TABLE "manuscript_prose_blocks"
  ADD CONSTRAINT "manuscript_prose_blocks_id_matches_section_item" CHECK ("id" = "section_item_id");
--> statement-breakpoint
CREATE TABLE "manuscript_prose_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sequence" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "project_id" uuid NOT NULL,
  "prose_block_id" uuid NOT NULL,
  "prose_text" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "manuscript_prose_revisions_project_id_id_unique" UNIQUE ("project_id", "id"),
  CONSTRAINT "manuscript_prose_revisions_project_block_id_id_unique" UNIQUE ("project_id", "prose_block_id", "id"),
  CONSTRAINT "manuscript_prose_revisions_prose_text_nonblank" CHECK (btrim("prose_text") <> ''),
  CONSTRAINT "manuscript_prose_revisions_prose_text_length_valid" CHECK (char_length("prose_text") <= 50000)
);
--> statement-breakpoint
ALTER TABLE "manuscript_prose_revisions"
  ADD CONSTRAINT "manuscript_prose_revisions_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "manuscript_prose_revisions"
  ADD CONSTRAINT "manuscript_prose_revisions_project_block_fk"
  FOREIGN KEY ("project_id", "prose_block_id")
  REFERENCES "public"."manuscript_prose_blocks"("project_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "manuscript_prose_revisions_project_block_sequence_idx"
  ON "manuscript_prose_revisions" USING btree ("project_id", "prose_block_id", "sequence");
--> statement-breakpoint
COMMENT ON COLUMN "manuscript_prose_revisions"."created_at" IS
  'For Slice 24 backfills, the best available timestamp associated with the content present at migration; not proof of original creation or complete prior history.';
--> statement-breakpoint
INSERT INTO "manuscript_prose_revisions" ("project_id", "prose_block_id", "prose_text", "created_at")
SELECT p."project_id", p."id", p."text", p."updated_at"
FROM "manuscript_prose_blocks" p;
--> statement-breakpoint
DO $function$
DECLARE block_count bigint; revision_count bigint; mismatch_count bigint;
BEGIN
  SELECT count(*) INTO block_count FROM manuscript_prose_blocks;
  SELECT count(*) INTO revision_count FROM manuscript_prose_revisions;
  SELECT count(*) INTO mismatch_count FROM manuscript_prose_blocks p
    LEFT JOIN manuscript_prose_revisions r ON r.project_id = p.project_id AND r.prose_block_id = p.id
    WHERE r.id IS NULL OR r.prose_text IS DISTINCT FROM p.text OR r.created_at IS DISTINCT FROM p.updated_at;
  IF block_count <> revision_count OR mismatch_count <> 0 THEN
    RAISE EXCEPTION 'Slice 24 Prose baseline backfill verification failed';
  END IF;
END;
$function$;
--> statement-breakpoint
ALTER TABLE "manuscript_review_threads" ADD COLUMN "opening_prose_revision_id" uuid;
--> statement-breakpoint
ALTER TABLE "manuscript_review_threads"
  ADD CONSTRAINT "manuscript_review_threads_project_opening_prose_revision_fk"
  FOREIGN KEY ("project_id", "section_item_id", "opening_prose_revision_id")
  REFERENCES "public"."manuscript_prose_revisions" ("project_id", "prose_block_id", "id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "manuscript_review_threads" DROP CONSTRAINT "manuscript_review_threads_opening_shape";
--> statement-breakpoint
ALTER TABLE "manuscript_review_threads" ADD CONSTRAINT "manuscript_review_threads_opening_shape" CHECK ((
  ("target_item_type" = 'prose' AND "opening_prose_text" IS NOT NULL AND btrim("opening_prose_text") <> ''
    AND char_length("opening_prose_text") <= 50000 AND "opening_claim_id" IS NULL AND "opening_claim_revision_id" IS NULL)
  OR ("target_item_type" = 'claim' AND "opening_prose_text" IS NULL AND "opening_prose_revision_id" IS NULL
    AND "opening_claim_id" IS NOT NULL AND "opening_claim_revision_id" IS NOT NULL)
));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_manuscript_prose_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Manuscript prose block identity is immutable; content is stored in Prose revisions';
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_manuscript_prose_revision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN RAISE EXCEPTION 'Manuscript Prose revisions are append-only'; END;
$function$;
--> statement-breakpoint
CREATE TRIGGER manuscript_prose_revisions_append_only
BEFORE UPDATE OR DELETE ON manuscript_prose_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_manuscript_prose_revision_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_manuscript_prose_revision_insert() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  target_removed_at timestamptz;
  target_section_archived_at timestamptz;
  current_text text;
  target_manuscript_id uuid;
  target_section_id uuid;
  target_section_item_id uuid;
  target_item_type text;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Manuscript Prose revisions are append-only'; END IF;

  -- Discover the stable containment keys, then acquire the canonical locks in
  -- Section -> ProseBlock -> SectionItem order before reading target state.
  SELECT p.manuscript_id, p.section_id, p.section_item_id, p.item_type
    INTO target_manuscript_id, target_section_id, target_section_item_id, target_item_type
  FROM manuscript_prose_blocks p
  WHERE p.project_id = NEW.project_id AND p.id = NEW.prose_block_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Prose revision target does not belong to this project'; END IF;
  SELECT s.archived_at INTO target_section_archived_at
  FROM manuscript_sections s
  WHERE s.project_id = NEW.project_id AND s.manuscript_id = target_manuscript_id AND s.id = target_section_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Prose revision target Section does not belong to this project'; END IF;
  IF target_section_archived_at IS NOT NULL THEN RAISE EXCEPTION 'Archived manuscript Sections cannot receive Prose revisions'; END IF;
  SELECT p.item_type INTO target_item_type
  FROM manuscript_prose_blocks p
  WHERE p.project_id = NEW.project_id AND p.id = NEW.prose_block_id
  FOR UPDATE;
  IF target_item_type IS DISTINCT FROM 'prose'
    OR NEW.prose_block_id IS DISTINCT FROM target_section_item_id THEN
    RAISE EXCEPTION 'Prose revision target is not a Prose block';
  END IF;
  SELECT i.removed_at, i.item_type INTO target_removed_at, target_item_type
  FROM manuscript_section_items i
  WHERE i.project_id = NEW.project_id AND i.manuscript_id = target_manuscript_id
    AND i.section_id = target_section_id AND i.id = target_section_item_id
  FOR UPDATE;
  IF NOT FOUND OR target_item_type IS DISTINCT FROM 'prose' THEN
    RAISE EXCEPTION 'Prose revision target SectionItem does not belong to this project';
  END IF;
  IF target_removed_at IS NOT NULL THEN RAISE EXCEPTION 'Removed manuscript Prose blocks cannot be revised'; END IF;
  SELECT r.prose_text INTO current_text FROM manuscript_prose_revisions r
    WHERE r.project_id = NEW.project_id AND r.prose_block_id = NEW.prose_block_id
    ORDER BY r.sequence DESC LIMIT 1;
  IF FOUND AND current_text IS NOT DISTINCT FROM NEW.prose_text THEN
    RAISE EXCEPTION 'A Prose revision must differ from the exact current revision text';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER manuscript_prose_revisions_insert_guard
BEFORE INSERT ON manuscript_prose_revisions
FOR EACH ROW EXECUTE FUNCTION validate_manuscript_prose_revision_insert();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_manuscript_prose_block_revision_complete() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE target_project_id uuid; target_block_id uuid; revision_count bigint;
BEGIN
  -- Re-read persisted rows at commit; NEW alone cannot prove sibling presence.
  IF TG_TABLE_NAME = 'manuscript_prose_blocks' THEN
    target_project_id := NEW.project_id; target_block_id := NEW.id;
  ELSE
    target_project_id := NEW.project_id; target_block_id := NEW.prose_block_id;
  END IF;
  SELECT count(*) INTO revision_count FROM manuscript_prose_revisions
    WHERE project_id = target_project_id AND prose_block_id = target_block_id;
  IF revision_count < 1 THEN RAISE EXCEPTION 'Every manuscript Prose block must have at least one persisted revision'; END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER manuscript_prose_blocks_revision_complete AFTER INSERT OR UPDATE ON manuscript_prose_blocks
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_manuscript_prose_block_revision_complete();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER manuscript_prose_revisions_block_complete AFTER INSERT ON manuscript_prose_revisions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_manuscript_prose_block_revision_complete();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_manuscript_review_thread_target() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE section_archived_at timestamptz; item_removed_at timestamptz; item_type text;
  persisted_prose_block_id uuid; persisted_prose_revision_id uuid; persisted_prose_text text;
  persisted_placement_id uuid; persisted_claim_id uuid; persisted_claim_revision_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.target_item_type = 'claim' THEN
    -- Preserve Slice 23's Claim Placement-first lock order.
    SELECT c.placement_id INTO persisted_placement_id FROM manuscript_section_item_claims c
      WHERE c.project_id = NEW.project_id AND c.manuscript_id = NEW.manuscript_id AND c.section_id = NEW.section_id
        AND c.section_item_id = NEW.section_item_id AND c.item_type = 'claim';
    IF persisted_placement_id IS NULL THEN RAISE EXCEPTION 'Review target Claim SectionItem has no Claim placement'; END IF;
    SELECT p.claim_id, p.claim_revision_id INTO persisted_claim_id, persisted_claim_revision_id
      FROM manuscript_claim_placements p WHERE p.project_id = NEW.project_id AND p.manuscript_id = NEW.manuscript_id
        AND p.section_id = NEW.section_id AND p.id = persisted_placement_id AND p.removed_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'New review threads require an active Claim placement'; END IF;
    IF persisted_claim_id IS DISTINCT FROM NEW.opening_claim_id OR persisted_claim_revision_id IS DISTINCT FROM NEW.opening_claim_revision_id THEN
      RAISE EXCEPTION 'Opening Claim snapshot must match the exact current placement';
    END IF;
  END IF;
  -- Prose operations take Section -> ProseBlock -> SectionItem.
  SELECT s.archived_at INTO section_archived_at FROM manuscript_sections s
    WHERE s.project_id = NEW.project_id AND s.manuscript_id = NEW.manuscript_id AND s.id = NEW.section_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Review target Section does not exist'; END IF;
  IF section_archived_at IS NOT NULL THEN RAISE EXCEPTION 'New review threads require a non-archived Section'; END IF;
  IF NEW.target_item_type = 'prose' THEN
    SELECT p.id INTO persisted_prose_block_id FROM manuscript_prose_blocks p
      WHERE p.project_id = NEW.project_id AND p.manuscript_id = NEW.manuscript_id AND p.section_id = NEW.section_id
        AND p.id = NEW.section_item_id AND p.section_item_id = NEW.section_item_id AND p.item_type = 'prose' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Review target Prose SectionItem has no Prose block'; END IF;
    SELECT r.id, r.prose_text INTO persisted_prose_revision_id, persisted_prose_text FROM manuscript_prose_revisions r
      WHERE r.project_id = NEW.project_id AND r.prose_block_id = persisted_prose_block_id
      ORDER BY r.sequence DESC LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Opening Prose snapshot has no current Prose revision';
    END IF;
    IF persisted_prose_text IS DISTINCT FROM NEW.opening_prose_text THEN
      RAISE EXCEPTION 'Opening Prose snapshot must match the exact persisted Prose text';
    END IF;
    IF persisted_prose_revision_id IS DISTINCT FROM NEW.opening_prose_revision_id THEN
      RAISE EXCEPTION 'Opening Prose snapshot must match the exact current Prose revision';
    END IF;
  END IF;
  SELECT i.removed_at, i.item_type INTO item_removed_at, item_type FROM manuscript_section_items i
    WHERE i.project_id = NEW.project_id AND i.manuscript_id = NEW.manuscript_id AND i.section_id = NEW.section_id
      AND i.id = NEW.section_item_id FOR UPDATE;
  IF NOT FOUND OR item_type IS DISTINCT FROM NEW.target_item_type THEN RAISE EXCEPTION 'Review target SectionItem identity does not match'; END IF;
  IF item_removed_at IS NOT NULL THEN RAISE EXCEPTION 'New review threads require an active SectionItem'; END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
ALTER TABLE "manuscript_prose_blocks" DROP CONSTRAINT "manuscript_prose_blocks_text_nonblank";
--> statement-breakpoint
ALTER TABLE "manuscript_prose_blocks" DROP CONSTRAINT "manuscript_prose_blocks_text_length_valid";
--> statement-breakpoint
ALTER TABLE "manuscript_prose_blocks" DROP COLUMN "text";
--> statement-breakpoint
ALTER TABLE "manuscript_prose_blocks" DROP COLUMN "updated_at";
--> statement-breakpoint
DO $function$
DECLARE legacy_thread_count bigint;
BEGIN
  SELECT count(*) INTO legacy_thread_count FROM manuscript_review_threads
    WHERE target_item_type = 'prose' AND opening_prose_revision_id IS NOT NULL;
  IF legacy_thread_count <> 0 THEN RAISE EXCEPTION 'Pre-Slice-24 Prose review threads must retain NULL revision identity'; END IF;
END;
$function$;
