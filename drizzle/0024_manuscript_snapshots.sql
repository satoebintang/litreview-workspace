-- Slice 25: immutable whole-manuscript snapshots.
CREATE TABLE "manuscript_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sequence" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "project_id" uuid NOT NULL,
  "manuscript_id" uuid NOT NULL,
  "title" text NOT NULL,
  "citation_style" text NOT NULL,
  "schema_version" integer NOT NULL,
  "renderer_version" text NOT NULL,
  "captured_at" timestamp with time zone NOT NULL,
  "rendered_markdown" text NOT NULL,
  "rendered_markdown_sha256" text NOT NULL,
  "expected_section_count" integer NOT NULL,
  "expected_item_count" integer NOT NULL,
  "expected_bibliography_count" integer NOT NULL,
  "expected_warning_count" integer NOT NULL,
  "finalized_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "manuscript_snapshots_project_id_id_unique" UNIQUE ("project_id", "id"),
  CONSTRAINT "manuscript_snapshots_project_manuscript_id_id_unique" UNIQUE ("project_id", "manuscript_id", "id"),
  CONSTRAINT "manuscript_snapshots_sequence_valid" CHECK ("sequence" > 0),
  CONSTRAINT "manuscript_snapshots_counts_valid" CHECK ("expected_section_count" >= 0 AND "expected_item_count" >= 0 AND "expected_bibliography_count" >= 0 AND "expected_warning_count" >= 0),
  CONSTRAINT "manuscript_snapshots_style_valid" CHECK ("citation_style" IN ('numeric', 'author_year')),
  CONSTRAINT "manuscript_snapshots_hash_shape" CHECK ("rendered_markdown_sha256" ~ '^[0-9a-f]{64}$')
);
CREATE TABLE "manuscript_snapshot_sections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL, "manuscript_id" uuid NOT NULL, "snapshot_id" uuid NOT NULL, "source_section_id" uuid NOT NULL,
  "title" text NOT NULL, "section_type" text NOT NULL, "section_position" integer NOT NULL, "source_sort_order" integer NOT NULL,
  CONSTRAINT "manuscript_snapshot_sections_project_snapshot_id_uq" UNIQUE ("project_id","snapshot_id","id"),
  CONSTRAINT "manuscript_snapshot_sections_project_snapshot_manuscript_id_uq" UNIQUE ("project_id","snapshot_id","manuscript_id","id"),
  CONSTRAINT "manuscript_snapshot_sections_snapshot_position_uq" UNIQUE ("project_id","snapshot_id","section_position"),
  CONSTRAINT "manuscript_snapshot_sections_snapshot_source_uq" UNIQUE ("project_id","snapshot_id","source_section_id"),
  CONSTRAINT "manuscript_snapshot_sections_position_valid" CHECK ("section_position" >= 0)
);
CREATE TABLE "manuscript_snapshot_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL, "manuscript_id" uuid NOT NULL, "snapshot_id" uuid NOT NULL, "snapshot_section_id" uuid NOT NULL,
  "source_section_id" uuid NOT NULL, "source_section_item_id" uuid NOT NULL, "item_type" text NOT NULL, "item_position" integer NOT NULL, "source_sort_order" integer NOT NULL,
  CONSTRAINT "manuscript_snapshot_items_project_snapshot_id_uq" UNIQUE ("project_id","snapshot_id","id"),
  CONSTRAINT "manuscript_snapshot_items_project_snapshot_manuscript_id_uq" UNIQUE ("project_id","manuscript_id","snapshot_id","id"),
  CONSTRAINT "manuscript_snapshot_items_snapshot_position_uq" UNIQUE ("project_id","snapshot_id","snapshot_section_id","item_position"),
  CONSTRAINT "manuscript_snapshot_items_snapshot_source_uq" UNIQUE ("project_id","snapshot_id","source_section_item_id"),
  CONSTRAINT "manuscript_snapshot_items_type_valid" CHECK ("item_type" IN ('claim','prose')),
  CONSTRAINT "manuscript_snapshot_items_position_valid" CHECK ("item_position" >= 0)
);
CREATE TABLE "manuscript_snapshot_prose_items" (
  "project_id" uuid NOT NULL, "manuscript_id" uuid NOT NULL, "snapshot_item_id" uuid PRIMARY KEY,
  "snapshot_id" uuid NOT NULL, "source_prose_block_id" uuid NOT NULL, "prose_revision_id" uuid NOT NULL, "prose_text" text NOT NULL,
  "source_section_id" uuid NOT NULL, "source_section_item_id" uuid NOT NULL,
  CONSTRAINT "manuscript_snapshot_prose_items_item_uq" UNIQUE ("project_id","snapshot_id","snapshot_item_id"),
  CONSTRAINT "manuscript_snapshot_prose_items_source_uq" UNIQUE ("project_id","snapshot_id","source_prose_block_id")
);
CREATE TABLE "manuscript_snapshot_claim_items" (
  "project_id" uuid NOT NULL, "manuscript_id" uuid NOT NULL, "snapshot_item_id" uuid PRIMARY KEY,
  "snapshot_id" uuid NOT NULL, "placement_id" uuid NOT NULL, "claim_id" uuid NOT NULL, "claim_revision_id" uuid NOT NULL,
  "source_section_id" uuid NOT NULL, "source_section_item_id" uuid NOT NULL,
  "claim_text" text, "rendered_citation_marker" text NOT NULL DEFAULT '',
  "capture_support_status" text NOT NULL, "capture_is_current_claim_revision" boolean NOT NULL,
  "capture_is_superseded" boolean NOT NULL, "capture_claim_lifecycle" text NOT NULL,
  CONSTRAINT "manuscript_snapshot_claim_items_item_uq" UNIQUE ("project_id","snapshot_id","snapshot_item_id"),
  CONSTRAINT "manuscript_snapshot_claim_items_placement_uq" UNIQUE ("project_id","snapshot_id","placement_id"),
  CONSTRAINT "manuscript_snapshot_claim_items_support_status_valid" CHECK ("capture_support_status" IN ('supported', 'unsupported')),
  CONSTRAINT "manuscript_snapshot_claim_items_lifecycle_valid" CHECK ("capture_claim_lifecycle" IN ('active', 'withdrawn'))
);
CREATE TABLE "manuscript_snapshot_bibliography_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL, "snapshot_id" uuid NOT NULL, "paper_id" uuid NOT NULL,
  "title" text NOT NULL, "authors" text[] NOT NULL, "publication_year" integer, "venue" text, "doi" text,
  "citation_number" integer NOT NULL, "bibliography_position" integer NOT NULL, "rendered_reference" text NOT NULL,
  CONSTRAINT "manuscript_snapshot_bibliography_entries_position_uq" UNIQUE ("project_id","snapshot_id","bibliography_position"),
  CONSTRAINT "manuscript_snapshot_bibliography_entries_project_snapshot_id_uq" UNIQUE ("project_id","snapshot_id","id"),
  CONSTRAINT "manuscript_snapshot_bibliography_entries_paper_uq" UNIQUE ("project_id","snapshot_id","paper_id"),
  CONSTRAINT "manuscript_snapshot_bibliography_entries_citation_uq" UNIQUE ("project_id","snapshot_id","citation_number"),
  CONSTRAINT "manuscript_snapshot_bibliography_entries_positions_valid" CHECK ("citation_number" > 0 AND "bibliography_position" >= 0)
);
CREATE TABLE "manuscript_snapshot_claim_bibliography_members" (
  "project_id" uuid NOT NULL, "snapshot_id" uuid NOT NULL, "snapshot_claim_item_id" uuid NOT NULL,
  "bibliography_entry_id" uuid NOT NULL, "marker_position" integer NOT NULL,
  PRIMARY KEY ("project_id","snapshot_id","snapshot_claim_item_id","bibliography_entry_id"),
  CONSTRAINT "manuscript_snapshot_claim_bibliography_members_position_uq" UNIQUE ("project_id","snapshot_id","snapshot_claim_item_id","marker_position"),
  CONSTRAINT "manuscript_snapshot_claim_bibliography_members_position_valid" CHECK ("marker_position" >= 0)
);
CREATE TABLE "manuscript_snapshot_warnings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL, "snapshot_id" uuid NOT NULL, "warning_position" integer NOT NULL,
  "section_id" uuid, "section_item_id" uuid, "placement_id" uuid, "claim_revision_id" uuid, "paper_id" uuid,
  "code" text NOT NULL, "message" text NOT NULL, "metadata_field" text,
  CONSTRAINT "manuscript_snapshot_warnings_position_uq" UNIQUE ("project_id","snapshot_id","warning_position"),
  CONSTRAINT "manuscript_snapshot_warnings_position_valid" CHECK ("warning_position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "manuscript_snapshots" ADD CONSTRAINT "manuscript_snapshots_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshots" ADD CONSTRAINT "manuscript_snapshots_manuscript_fk" FOREIGN KEY ("project_id","manuscript_id") REFERENCES "public"."manuscripts"("project_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_sections" ADD CONSTRAINT "manuscript_snapshot_sections_parent_fk" FOREIGN KEY ("project_id","snapshot_id") REFERENCES "public"."manuscript_snapshots"("project_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_sections" ADD CONSTRAINT "manuscript_snapshot_sections_parent_manuscript_fk" FOREIGN KEY ("project_id","manuscript_id","snapshot_id") REFERENCES "public"."manuscript_snapshots"("project_id","manuscript_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_sections" ADD CONSTRAINT "manuscript_snapshot_sections_source_manuscript_fk" FOREIGN KEY ("project_id","manuscript_id","source_section_id") REFERENCES "public"."manuscript_sections"("project_id","manuscript_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_items" ADD CONSTRAINT "manuscript_snapshot_items_parent_fk" FOREIGN KEY ("project_id","snapshot_id") REFERENCES "public"."manuscript_snapshots"("project_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_items" ADD CONSTRAINT "manuscript_snapshot_items_parent_manuscript_fk" FOREIGN KEY ("project_id","manuscript_id","snapshot_id") REFERENCES "public"."manuscript_snapshots"("project_id","manuscript_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_items" ADD CONSTRAINT "manuscript_snapshot_items_section_fk" FOREIGN KEY ("project_id","snapshot_id","manuscript_id","snapshot_section_id") REFERENCES "public"."manuscript_snapshot_sections"("project_id","snapshot_id","manuscript_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_items" ADD CONSTRAINT "manuscript_snapshot_items_source_manuscript_fk" FOREIGN KEY ("project_id","manuscript_id","source_section_id","source_section_item_id","item_type") REFERENCES "public"."manuscript_section_items"("project_id","manuscript_id","section_id","id","item_type") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_prose_items" ADD CONSTRAINT "manuscript_snapshot_prose_items_parent_fk" FOREIGN KEY ("project_id","snapshot_id","snapshot_item_id") REFERENCES "public"."manuscript_snapshot_items"("project_id","snapshot_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_prose_items" ADD CONSTRAINT "manuscript_snapshot_prose_items_parent_manuscript_fk" FOREIGN KEY ("project_id","manuscript_id","snapshot_id","snapshot_item_id") REFERENCES "public"."manuscript_snapshot_items"("project_id","manuscript_id","snapshot_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_prose_items" ADD CONSTRAINT "manuscript_snapshot_prose_items_source_item_fk" FOREIGN KEY ("project_id","manuscript_id","source_section_id","source_section_item_id") REFERENCES "public"."manuscript_section_items"("project_id","manuscript_id","section_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_bibliography_entries" ADD CONSTRAINT "manuscript_snapshot_bibliography_parent_fk" FOREIGN KEY ("project_id","snapshot_id") REFERENCES "public"."manuscript_snapshots"("project_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_claim_bibliography_members" ADD CONSTRAINT "manuscript_snapshot_members_parent_fk" FOREIGN KEY ("project_id","snapshot_id") REFERENCES "public"."manuscript_snapshots"("project_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_claim_bibliography_members" ADD CONSTRAINT "manuscript_snapshot_members_claim_fk" FOREIGN KEY ("project_id","snapshot_id","snapshot_claim_item_id") REFERENCES "public"."manuscript_snapshot_claim_items"("project_id","snapshot_id","snapshot_item_id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_claim_bibliography_members" ADD CONSTRAINT "manuscript_snapshot_members_bib_fk" FOREIGN KEY ("project_id","snapshot_id","bibliography_entry_id") REFERENCES "public"."manuscript_snapshot_bibliography_entries"("project_id","snapshot_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_warnings" ADD CONSTRAINT "manuscript_snapshot_warnings_parent_fk" FOREIGN KEY ("project_id","snapshot_id") REFERENCES "public"."manuscript_snapshots"("project_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_sections" ADD CONSTRAINT "manuscript_snapshot_sections_source_fk" FOREIGN KEY ("project_id","source_section_id") REFERENCES "public"."manuscript_sections"("project_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_items" ADD CONSTRAINT "manuscript_snapshot_items_source_fk" FOREIGN KEY ("project_id","source_section_item_id") REFERENCES "public"."manuscript_section_items"("project_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_prose_items" ADD CONSTRAINT "manuscript_snapshot_prose_items_revision_fk" FOREIGN KEY ("project_id","source_prose_block_id","prose_revision_id") REFERENCES "public"."manuscript_prose_revisions"("project_id","prose_block_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_claim_items" ADD CONSTRAINT "manuscript_snapshot_claim_items_parent_fk" FOREIGN KEY ("project_id","snapshot_id","snapshot_item_id") REFERENCES "public"."manuscript_snapshot_items"("project_id","snapshot_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_claim_items" ADD CONSTRAINT "manuscript_snapshot_claim_items_parent_manuscript_fk" FOREIGN KEY ("project_id","manuscript_id","snapshot_id","snapshot_item_id") REFERENCES "public"."manuscript_snapshot_items"("project_id","manuscript_id","snapshot_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_claim_items" ADD CONSTRAINT "manuscript_snapshot_claim_items_source_item_fk" FOREIGN KEY ("project_id","manuscript_id","source_section_id","source_section_item_id") REFERENCES "public"."manuscript_section_items"("project_id","manuscript_id","section_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_claim_items" ADD CONSTRAINT "manuscript_snapshot_claim_items_revision_fk" FOREIGN KEY ("project_id","claim_id","claim_revision_id") REFERENCES "public"."claim_revisions"("project_id","claim_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_claim_items" ADD CONSTRAINT "manuscript_snapshot_claim_items_placement_fk" FOREIGN KEY ("project_id","manuscript_id","source_section_id","placement_id") REFERENCES "public"."manuscript_claim_placements"("project_id","manuscript_id","section_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_bibliography_entries" ADD CONSTRAINT "manuscript_snapshot_bibliography_paper_fk" FOREIGN KEY ("project_id","paper_id") REFERENCES "public"."papers"("project_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_warnings" ADD CONSTRAINT "manuscript_snapshot_warnings_section_fk" FOREIGN KEY ("project_id","section_id") REFERENCES "public"."manuscript_sections"("project_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_warnings" ADD CONSTRAINT "manuscript_snapshot_warnings_claim_revision_fk" FOREIGN KEY ("project_id","claim_revision_id") REFERENCES "public"."claim_revisions"("project_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_warnings" ADD CONSTRAINT "manuscript_snapshot_warnings_paper_fk" FOREIGN KEY ("project_id","paper_id") REFERENCES "public"."papers"("project_id","id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_warnings" ADD CONSTRAINT "manuscript_snapshot_warnings_snapshot_section_fk" FOREIGN KEY ("project_id","snapshot_id","section_id") REFERENCES "public"."manuscript_snapshot_sections"("project_id","snapshot_id","source_section_id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_warnings" ADD CONSTRAINT "manuscript_snapshot_warnings_snapshot_item_fk" FOREIGN KEY ("project_id","snapshot_id","section_item_id") REFERENCES "public"."manuscript_snapshot_items"("project_id","snapshot_id","source_section_item_id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_warnings" ADD CONSTRAINT "manuscript_snapshot_warnings_snapshot_placement_fk" FOREIGN KEY ("project_id","snapshot_id","placement_id") REFERENCES "public"."manuscript_snapshot_claim_items"("project_id","snapshot_id","placement_id") ON DELETE restrict;
ALTER TABLE "manuscript_snapshot_warnings" ADD CONSTRAINT "manuscript_snapshot_warnings_snapshot_paper_fk" FOREIGN KEY ("project_id","snapshot_id","paper_id") REFERENCES "public"."manuscript_snapshot_bibliography_entries"("project_id","snapshot_id","paper_id") ON DELETE restrict;
CREATE INDEX "manuscript_snapshots_project_manuscript_sequence_idx" ON "manuscript_snapshots" ("project_id","manuscript_id","sequence");
CREATE INDEX "manuscript_snapshot_sections_order_idx" ON "manuscript_snapshot_sections" ("project_id","snapshot_id","section_position");
CREATE INDEX "manuscript_snapshot_items_order_idx" ON "manuscript_snapshot_items" ("project_id","snapshot_id","snapshot_section_id","item_position");
CREATE OR REPLACE FUNCTION prevent_manuscript_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  -- This trigger is shared by the parent and every typed child.  Use JSONB
  -- field access so a child row is never asked for the parent's finalized_at
  -- field while still allowing exactly one parent transition: NULL -> value.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'manuscript_snapshots'
     AND (to_jsonb(OLD)->>'finalized_at') IS NULL
     AND (to_jsonb(NEW)->>'finalized_at') IS NOT NULL
     AND (to_jsonb(OLD) - 'finalized_at') = (to_jsonb(NEW) - 'finalized_at') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Finalized manuscript snapshots and snapshot children are immutable';
END;
$function$;
CREATE TRIGGER manuscript_snapshots_immutable BEFORE UPDATE OR DELETE ON "manuscript_snapshots" FOR EACH ROW EXECUTE FUNCTION prevent_manuscript_snapshot_mutation();
CREATE TRIGGER manuscript_snapshot_sections_immutable BEFORE UPDATE OR DELETE ON "manuscript_snapshot_sections" FOR EACH ROW EXECUTE FUNCTION prevent_manuscript_snapshot_mutation();
CREATE TRIGGER manuscript_snapshot_items_immutable BEFORE UPDATE OR DELETE ON "manuscript_snapshot_items" FOR EACH ROW EXECUTE FUNCTION prevent_manuscript_snapshot_mutation();
CREATE TRIGGER manuscript_snapshot_prose_items_immutable BEFORE UPDATE OR DELETE ON "manuscript_snapshot_prose_items" FOR EACH ROW EXECUTE FUNCTION prevent_manuscript_snapshot_mutation();
CREATE TRIGGER manuscript_snapshot_claim_items_immutable BEFORE UPDATE OR DELETE ON "manuscript_snapshot_claim_items" FOR EACH ROW EXECUTE FUNCTION prevent_manuscript_snapshot_mutation();
CREATE TRIGGER manuscript_snapshot_bibliography_immutable BEFORE UPDATE OR DELETE ON "manuscript_snapshot_bibliography_entries" FOR EACH ROW EXECUTE FUNCTION prevent_manuscript_snapshot_mutation();
CREATE TRIGGER manuscript_snapshot_members_immutable BEFORE UPDATE OR DELETE ON "manuscript_snapshot_claim_bibliography_members" FOR EACH ROW EXECUTE FUNCTION prevent_manuscript_snapshot_mutation();
CREATE TRIGGER manuscript_snapshot_warnings_immutable BEFORE UPDATE OR DELETE ON "manuscript_snapshot_warnings" FOR EACH ROW EXECUTE FUNCTION prevent_manuscript_snapshot_mutation();
CREATE OR REPLACE FUNCTION prevent_finalized_snapshot_child_insert() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE sid uuid;
BEGIN sid := COALESCE(NEW.snapshot_id, (to_jsonb(NEW)->>'snapshot_id')::uuid); IF EXISTS (SELECT 1 FROM manuscript_snapshots WHERE id=sid AND finalized_at IS NOT NULL) THEN RAISE EXCEPTION 'Cannot mutate a finalized manuscript snapshot'; END IF; RETURN NEW; END;
$function$;
CREATE TRIGGER manuscript_snapshot_sections_finalized_insert BEFORE INSERT ON "manuscript_snapshot_sections" FOR EACH ROW EXECUTE FUNCTION prevent_finalized_snapshot_child_insert();
CREATE TRIGGER manuscript_snapshot_items_finalized_insert BEFORE INSERT ON "manuscript_snapshot_items" FOR EACH ROW EXECUTE FUNCTION prevent_finalized_snapshot_child_insert();
CREATE TRIGGER manuscript_snapshot_prose_finalized_insert BEFORE INSERT ON "manuscript_snapshot_prose_items" FOR EACH ROW EXECUTE FUNCTION prevent_finalized_snapshot_child_insert();
CREATE TRIGGER manuscript_snapshot_claim_finalized_insert BEFORE INSERT ON "manuscript_snapshot_claim_items" FOR EACH ROW EXECUTE FUNCTION prevent_finalized_snapshot_child_insert();
CREATE TRIGGER manuscript_snapshot_bib_finalized_insert BEFORE INSERT ON "manuscript_snapshot_bibliography_entries" FOR EACH ROW EXECUTE FUNCTION prevent_finalized_snapshot_child_insert();
CREATE TRIGGER manuscript_snapshot_member_finalized_insert BEFORE INSERT ON "manuscript_snapshot_claim_bibliography_members" FOR EACH ROW EXECUTE FUNCTION prevent_finalized_snapshot_child_insert();
CREATE TRIGGER manuscript_snapshot_warning_finalized_insert BEFORE INSERT ON "manuscript_snapshot_warnings" FOR EACH ROW EXECUTE FUNCTION prevent_finalized_snapshot_child_insert();
CREATE OR REPLACE FUNCTION prevent_manuscript_snapshot_parent_insert() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.finalized_at IS NOT NULL THEN RAISE EXCEPTION 'Snapshot parent must be finalized only after immutable children are constructed'; END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER manuscript_snapshots_draft_insert BEFORE INSERT ON "manuscript_snapshots" FOR EACH ROW EXECUTE FUNCTION prevent_manuscript_snapshot_parent_insert();
CREATE OR REPLACE FUNCTION assemble_manuscript_snapshot_markdown(p_project_id uuid, p_snapshot_id uuid) RETURNS text
LANGUAGE plpgsql STABLE AS $function$
DECLARE result text; section_row record; item_row record; bib_row record;
BEGIN
  SELECT '# ' || title INTO result FROM manuscript_snapshots WHERE project_id=p_project_id AND id=p_snapshot_id;
  IF result IS NULL THEN RAISE EXCEPTION 'Snapshot does not exist'; END IF;
  FOR section_row IN SELECT id,title FROM manuscript_snapshot_sections WHERE project_id=p_project_id AND snapshot_id=p_snapshot_id ORDER BY section_position LOOP
    result := result || E'\n\n## ' || section_row.title;
    FOR item_row IN SELECT i.item_type, COALESCE(p.prose_text, c.claim_text, '') AS body, COALESCE(c.rendered_citation_marker,'') AS marker FROM manuscript_snapshot_items i LEFT JOIN manuscript_snapshot_prose_items p ON p.project_id=i.project_id AND p.snapshot_id=i.snapshot_id AND p.snapshot_item_id=i.id LEFT JOIN manuscript_snapshot_claim_items c ON c.project_id=i.project_id AND c.snapshot_id=i.snapshot_id AND c.snapshot_item_id=i.id WHERE i.project_id=p_project_id AND i.snapshot_id=p_snapshot_id AND i.snapshot_section_id=section_row.id ORDER BY i.item_position LOOP
      IF item_row.item_type='claim' THEN result := result || E'\n\n' || regexp_replace(item_row.body, E'\r\n?', E'\n', 'g') || CASE WHEN item_row.marker <> '' THEN ' ' || item_row.marker ELSE '' END;
      ELSE result := result || E'\n\n' || regexp_replace(item_row.body, E'\r\n?', E'\n', 'g'); END IF;
    END LOOP;
  END LOOP;
  result := result || E'\n\n## References';
  FOR bib_row IN SELECT s.citation_style, b.rendered_reference FROM manuscript_snapshot_bibliography_entries b JOIN manuscript_snapshots s ON s.project_id=b.project_id AND s.id=b.snapshot_id WHERE b.project_id=p_project_id AND b.snapshot_id=p_snapshot_id ORDER BY b.bibliography_position LOOP
    result := result || E'\n\n' || CASE WHEN bib_row.citation_style='numeric' THEN regexp_replace(bib_row.rendered_reference, E'\r\n?', E'\n', 'g') ELSE '- ' || regexp_replace(bib_row.rendered_reference, E'\r\n?', E'\n', 'g') END;
  END LOOP;
  RETURN regexp_replace(result, E'\n+$', '') || E'\n';
END;
$function$;
CREATE OR REPLACE FUNCTION validate_manuscript_snapshot_finalization() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  persisted_parent manuscript_snapshots%ROWTYPE;
  persisted_finalized_at timestamptz;
  section_count integer;
  item_count integer;
  bibliography_count integer;
  warning_count integer;
  prose_count integer;
  claim_count integer;
  active_section_count integer;
  active_item_count integer;
  assembled text;
BEGIN
  -- Constraint triggers must inspect the rows that are actually persisted at
  -- commit.  In particular, do not use NEW to infer whether sibling rows were
  -- inserted: a parent INSERT event can fire after its finalization UPDATE.
  SELECT s.* INTO persisted_parent
  FROM manuscript_snapshots s
  WHERE s.project_id=NEW.project_id AND s.id=NEW.id;
  persisted_finalized_at := persisted_parent.finalized_at;
  IF persisted_parent.id IS NULL OR persisted_finalized_at IS NULL THEN
    IF TG_OP='INSERT' THEN RAISE EXCEPTION 'Incomplete manuscript snapshot construction'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' OR OLD.finalized_at IS NOT NULL OR persisted_parent.finalized_at IS NULL THEN RETURN NEW; END IF;

  SELECT count(*)::int INTO section_count FROM manuscript_snapshot_sections WHERE project_id=persisted_parent.project_id AND snapshot_id=persisted_parent.id;
  SELECT count(*)::int INTO item_count FROM manuscript_snapshot_items WHERE project_id=persisted_parent.project_id AND snapshot_id=persisted_parent.id;
  SELECT count(*)::int INTO bibliography_count FROM manuscript_snapshot_bibliography_entries WHERE project_id=persisted_parent.project_id AND snapshot_id=persisted_parent.id;
  SELECT count(*)::int INTO warning_count FROM manuscript_snapshot_warnings WHERE project_id=persisted_parent.project_id AND snapshot_id=persisted_parent.id;
  SELECT count(*)::int INTO prose_count FROM manuscript_snapshot_prose_items WHERE project_id=persisted_parent.project_id AND snapshot_id=persisted_parent.id;
  SELECT count(*)::int INTO claim_count FROM manuscript_snapshot_claim_items WHERE project_id=persisted_parent.project_id AND snapshot_id=persisted_parent.id;
  IF section_count<>persisted_parent.expected_section_count OR item_count<>persisted_parent.expected_item_count
     OR bibliography_count<>persisted_parent.expected_bibliography_count OR warning_count<>persisted_parent.expected_warning_count
     OR prose_count+claim_count<>item_count THEN
    RAISE EXCEPTION 'Incomplete manuscript snapshot construction';
  END IF;

  -- Dense positions are the historical ordering authority.  source_sort_order
  -- remains diagnostic metadata only.
  IF EXISTS (
    SELECT 1 FROM (
      SELECT section_position, row_number() OVER (ORDER BY section_position)-1 AS expected_position
      FROM manuscript_snapshot_sections WHERE project_id=persisted_parent.project_id AND snapshot_id=persisted_parent.id
    ) ordered WHERE ordered.section_position <> ordered.expected_position
  ) THEN RAISE EXCEPTION 'Snapshot Section positions are not dense'; END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT snapshot_section_id, item_position,
             row_number() OVER (PARTITION BY snapshot_section_id ORDER BY item_position)-1 AS expected_position
      FROM manuscript_snapshot_items WHERE project_id=persisted_parent.project_id AND snapshot_id=persisted_parent.id
    ) ordered WHERE ordered.item_position <> ordered.expected_position
  ) THEN RAISE EXCEPTION 'Snapshot item positions are not dense'; END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT snapshot_claim_item_id, marker_position,
             row_number() OVER (PARTITION BY snapshot_claim_item_id ORDER BY marker_position)-1 AS expected_position
      FROM manuscript_snapshot_claim_bibliography_members WHERE project_id=persisted_parent.project_id AND snapshot_id=persisted_parent.id
    ) ordered WHERE ordered.marker_position <> ordered.expected_position
  ) THEN RAISE EXCEPTION 'Snapshot citation marker positions are not dense'; END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT bibliography_position, row_number() OVER (ORDER BY bibliography_position)-1 AS expected_position
      FROM manuscript_snapshot_bibliography_entries WHERE project_id=persisted_parent.project_id AND snapshot_id=persisted_parent.id
    ) ordered WHERE ordered.bibliography_position <> ordered.expected_position
  ) OR EXISTS (
    SELECT 1 FROM (
      SELECT citation_number, row_number() OVER (ORDER BY citation_number) AS expected_position
      FROM manuscript_snapshot_bibliography_entries WHERE project_id=persisted_parent.project_id AND snapshot_id=persisted_parent.id
    ) ordered WHERE ordered.citation_number <> ordered.expected_position
  ) THEN RAISE EXCEPTION 'Snapshot bibliography positions are not dense'; END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT warning_position, row_number() OVER (ORDER BY warning_position)-1 AS expected_position
      FROM manuscript_snapshot_warnings WHERE project_id=persisted_parent.project_id AND snapshot_id=persisted_parent.id
    ) ordered WHERE ordered.warning_position <> ordered.expected_position
  ) THEN RAISE EXCEPTION 'Snapshot warning positions are not dense'; END IF;
  IF EXISTS (
    SELECT 1 FROM manuscript_snapshot_claim_items c
    WHERE c.project_id=persisted_parent.project_id AND c.snapshot_id=persisted_parent.id
      AND ((c.rendered_citation_marker <> '' AND NOT EXISTS (
        SELECT 1 FROM manuscript_snapshot_claim_bibliography_members m
        WHERE m.project_id=c.project_id AND m.snapshot_id=c.snapshot_id AND m.snapshot_claim_item_id=c.snapshot_item_id
      )) OR (c.rendered_citation_marker = '' AND EXISTS (
        SELECT 1 FROM manuscript_snapshot_claim_bibliography_members m
        WHERE m.project_id=c.project_id AND m.snapshot_id=c.snapshot_id AND m.snapshot_claim_item_id=c.snapshot_item_id
      )))
  ) THEN RAISE EXCEPTION 'Snapshot Claim citation membership is incomplete'; END IF;
  IF EXISTS (
    SELECT 1 FROM manuscript_snapshot_warnings w
    WHERE w.project_id=persisted_parent.project_id AND w.snapshot_id=persisted_parent.id
      AND ((w.section_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM manuscript_snapshot_sections ss
        WHERE ss.project_id=w.project_id AND ss.snapshot_id=w.snapshot_id AND ss.source_section_id=w.section_id
      )) OR (w.section_item_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM manuscript_snapshot_items si
        WHERE si.project_id=w.project_id AND si.snapshot_id=w.snapshot_id AND si.source_section_item_id=w.section_item_id
      )) OR (w.placement_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM manuscript_snapshot_claim_items ci
        WHERE ci.project_id=w.project_id AND ci.snapshot_id=w.snapshot_id AND ci.placement_id=w.placement_id
      )) OR (w.claim_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM manuscript_snapshot_claim_items ci
        WHERE ci.project_id=w.project_id AND ci.snapshot_id=w.snapshot_id AND ci.claim_revision_id=w.claim_revision_id
      )))
  ) THEN RAISE EXCEPTION 'Snapshot warning references are incomplete'; END IF;

  -- Start completeness from visible Sections, including empty Sections, then
  -- require every visible active SectionItem to appear exactly once.
  SELECT count(*)::int INTO active_section_count
  FROM manuscript_sections s
  WHERE s.project_id=persisted_parent.project_id AND s.manuscript_id=persisted_parent.manuscript_id AND s.archived_at IS NULL;
  SELECT count(*)::int INTO active_item_count
  FROM manuscript_section_items i
  JOIN manuscript_sections s ON s.project_id=i.project_id AND s.manuscript_id=i.manuscript_id AND s.id=i.section_id
  WHERE i.project_id=persisted_parent.project_id AND i.manuscript_id=persisted_parent.manuscript_id AND i.removed_at IS NULL AND s.archived_at IS NULL;
  IF section_count <> active_section_count OR item_count <> active_item_count THEN
    RAISE EXCEPTION 'Snapshot composition is incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM manuscript_snapshot_sections ss
    LEFT JOIN manuscript_sections s ON s.project_id=ss.project_id AND s.id=ss.source_section_id
    WHERE ss.project_id=persisted_parent.project_id AND ss.snapshot_id=persisted_parent.id
      AND (ss.manuscript_id IS DISTINCT FROM persisted_parent.manuscript_id OR s.id IS NULL OR s.manuscript_id IS DISTINCT FROM persisted_parent.manuscript_id OR s.archived_at IS NOT NULL
        OR ss.title IS DISTINCT FROM s.title OR ss.section_type IS DISTINCT FROM s.section_type OR ss.source_sort_order IS DISTINCT FROM s.sort_order)
  ) OR EXISTS (
    SELECT 1 FROM manuscript_sections s
    WHERE s.project_id=persisted_parent.project_id AND s.manuscript_id=persisted_parent.manuscript_id AND s.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM manuscript_snapshot_sections ss WHERE ss.project_id=persisted_parent.project_id AND ss.snapshot_id=persisted_parent.id AND ss.source_section_id=s.id)
  ) THEN RAISE EXCEPTION 'Snapshot Section composition does not match the visible manuscript'; END IF;
  IF EXISTS (
    SELECT 1 FROM manuscript_snapshot_items i
    JOIN manuscript_snapshot_sections ss ON ss.project_id=i.project_id AND ss.snapshot_id=i.snapshot_id AND ss.id=i.snapshot_section_id
    LEFT JOIN manuscript_section_items source_i ON source_i.project_id=i.project_id AND source_i.id=i.source_section_item_id
    WHERE i.project_id=persisted_parent.project_id AND i.snapshot_id=persisted_parent.id
      AND (i.manuscript_id IS DISTINCT FROM persisted_parent.manuscript_id OR i.source_section_id IS DISTINCT FROM ss.source_section_id
        OR source_i.id IS NULL OR source_i.manuscript_id IS DISTINCT FROM persisted_parent.manuscript_id OR source_i.section_id IS DISTINCT FROM ss.source_section_id
        OR source_i.removed_at IS NOT NULL OR source_i.item_type IS DISTINCT FROM i.item_type OR source_i.sort_order IS DISTINCT FROM i.source_sort_order)
  ) OR EXISTS (
    SELECT 1 FROM manuscript_section_items source_i
    JOIN manuscript_sections s ON s.project_id=source_i.project_id AND s.manuscript_id=source_i.manuscript_id AND s.id=source_i.section_id
    WHERE source_i.project_id=persisted_parent.project_id AND source_i.manuscript_id=persisted_parent.manuscript_id AND source_i.removed_at IS NULL AND s.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM manuscript_snapshot_items i JOIN manuscript_snapshot_sections ss ON ss.project_id=i.project_id AND ss.snapshot_id=i.snapshot_id AND ss.id=i.snapshot_section_id
        WHERE i.project_id=persisted_parent.project_id AND i.snapshot_id=persisted_parent.id AND i.source_section_item_id=source_i.id AND ss.source_section_id=source_i.section_id)
  ) THEN RAISE EXCEPTION 'Snapshot item composition does not match the visible manuscript'; END IF;

  -- Every item has exactly one typed immutable child.  The source identity and
  -- copied text are checked against the exact revision, while a Claim item is
  -- deliberately not compared with the placement's mutable current revision.
  IF EXISTS (
    SELECT 1 FROM manuscript_snapshot_items i
    LEFT JOIN manuscript_snapshot_prose_items p ON p.project_id=i.project_id AND p.snapshot_id=i.snapshot_id AND p.snapshot_item_id=i.id
    LEFT JOIN manuscript_snapshot_claim_items c ON c.project_id=i.project_id AND c.snapshot_id=i.snapshot_id AND c.snapshot_item_id=i.id
    WHERE i.project_id=persisted_parent.project_id AND i.snapshot_id=persisted_parent.id
      AND ((i.item_type='prose' AND (p.snapshot_item_id IS NULL OR c.snapshot_item_id IS NOT NULL))
        OR (i.item_type='claim' AND (c.snapshot_item_id IS NULL OR p.snapshot_item_id IS NOT NULL)))
  ) THEN RAISE EXCEPTION 'Snapshot item subtype is incomplete'; END IF;
  IF EXISTS (
    SELECT 1 FROM manuscript_snapshot_prose_items p
    JOIN manuscript_snapshot_items i ON i.project_id=p.project_id AND i.snapshot_id=p.snapshot_id AND i.id=p.snapshot_item_id
    JOIN manuscript_snapshot_sections ss ON ss.project_id=i.project_id AND ss.snapshot_id=i.snapshot_id AND ss.id=i.snapshot_section_id
    LEFT JOIN manuscript_prose_blocks b ON b.project_id=p.project_id AND b.id=p.source_prose_block_id
    LEFT JOIN manuscript_prose_revisions r ON r.project_id=p.project_id AND r.prose_block_id=p.source_prose_block_id AND r.id=p.prose_revision_id
    WHERE p.project_id=persisted_parent.project_id AND p.snapshot_id=persisted_parent.id
      AND (p.manuscript_id IS DISTINCT FROM persisted_parent.manuscript_id OR p.source_section_id IS DISTINCT FROM ss.source_section_id
        OR p.source_section_item_id IS DISTINCT FROM i.source_section_item_id OR b.id IS NULL OR b.manuscript_id IS DISTINCT FROM persisted_parent.manuscript_id OR b.section_id IS DISTINCT FROM ss.source_section_id
        OR b.section_item_id IS DISTINCT FROM i.source_section_item_id OR b.item_type IS DISTINCT FROM 'prose'
        OR r.id IS NULL OR p.prose_text IS DISTINCT FROM r.prose_text)
  ) THEN RAISE EXCEPTION 'Snapshot Prose identity or copied text is invalid'; END IF;
  IF EXISTS (
    SELECT 1 FROM manuscript_snapshot_claim_items c
    JOIN manuscript_snapshot_items i ON i.project_id=c.project_id AND i.snapshot_id=c.snapshot_id AND i.id=c.snapshot_item_id
    JOIN manuscript_snapshot_sections ss ON ss.project_id=i.project_id AND ss.snapshot_id=i.snapshot_id AND ss.id=i.snapshot_section_id
    LEFT JOIN manuscript_claim_placements p ON p.project_id=c.project_id AND p.id=c.placement_id
    LEFT JOIN claim_revisions r ON r.project_id=c.project_id AND r.claim_id=c.claim_id AND r.id=c.claim_revision_id
    WHERE c.project_id=persisted_parent.project_id AND c.snapshot_id=persisted_parent.id
      AND (c.manuscript_id IS DISTINCT FROM persisted_parent.manuscript_id OR c.source_section_id IS DISTINCT FROM ss.source_section_id
        OR c.source_section_item_id IS DISTINCT FROM i.source_section_item_id OR p.id IS NULL OR p.manuscript_id IS DISTINCT FROM persisted_parent.manuscript_id OR p.section_id IS DISTINCT FROM ss.source_section_id OR p.removed_at IS NOT NULL
        OR p.claim_id IS DISTINCT FROM c.claim_id OR r.id IS NULL OR r.claim_id IS DISTINCT FROM c.claim_id OR c.claim_text IS DISTINCT FROM r.claim_text)
  ) THEN RAISE EXCEPTION 'Snapshot Claim identity or copied text is invalid'; END IF;

  assembled := assemble_manuscript_snapshot_markdown(persisted_parent.project_id, persisted_parent.id);
  IF assembled IS DISTINCT FROM persisted_parent.rendered_markdown
     OR encode(sha256(convert_to(persisted_parent.rendered_markdown,'UTF8')),'hex') IS DISTINCT FROM persisted_parent.rendered_markdown_sha256 THEN
    RAISE EXCEPTION 'Snapshot rendered artifact integrity check failed';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE CONSTRAINT TRIGGER manuscript_snapshots_complete_at_commit AFTER UPDATE ON "manuscript_snapshots" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_manuscript_snapshot_finalization();
CREATE CONSTRAINT TRIGGER manuscript_snapshots_insert_complete_at_commit AFTER INSERT ON "manuscript_snapshots" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_manuscript_snapshot_finalization();
