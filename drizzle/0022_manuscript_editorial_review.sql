CREATE TABLE "manuscript_review_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"manuscript_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"section_item_id" uuid NOT NULL,
	"target_item_type" text NOT NULL,
	"title" text NOT NULL,
	"opening_prose_text" text,
	"opening_claim_id" uuid,
	"opening_claim_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manuscript_review_threads_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "manuscript_review_threads_project_manuscript_id_id_unique" UNIQUE("project_id","manuscript_id","id"),
	CONSTRAINT "manuscript_review_threads_project_manuscript_section_id_id_unique" UNIQUE("project_id","manuscript_id","section_id","id"),
	CONSTRAINT "manuscript_review_threads_project_section_item_id_unique" UNIQUE("project_id","section_item_id","id"),
	CONSTRAINT "manuscript_review_threads_target_item_type_valid" CHECK ("manuscript_review_threads"."target_item_type" in ('claim', 'prose')),
	CONSTRAINT "manuscript_review_threads_title_nonblank" CHECK (btrim("manuscript_review_threads"."title") <> '' and char_length("manuscript_review_threads"."title") <= 300),
	CONSTRAINT "manuscript_review_threads_opening_shape" CHECK ((
      ("manuscript_review_threads"."target_item_type" = 'prose' and "manuscript_review_threads"."opening_prose_text" is not null and btrim("manuscript_review_threads"."opening_prose_text") <> '' and char_length("manuscript_review_threads"."opening_prose_text") <= 50000 and "manuscript_review_threads"."opening_claim_id" is null and "manuscript_review_threads"."opening_claim_revision_id" is null)
      or ("manuscript_review_threads"."target_item_type" = 'claim' and "manuscript_review_threads"."opening_prose_text" is null and "manuscript_review_threads"."opening_claim_id" is not null and "manuscript_review_threads"."opening_claim_revision_id" is not null)
    ))
);
--> statement-breakpoint
CREATE TABLE "manuscript_review_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "manuscript_review_events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"body" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manuscript_review_events_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "manuscript_review_events_project_thread_sequence_unique" UNIQUE("project_id","thread_id","sequence"),
	CONSTRAINT "manuscript_review_events_event_type_valid" CHECK ("manuscript_review_events"."event_type" in ('opened', 'commented', 'resolved', 'reopened')),
	CONSTRAINT "manuscript_review_events_body_shape" CHECK (
      ("manuscript_review_events"."event_type" in ('opened', 'commented') and "manuscript_review_events"."body" is not null and btrim("manuscript_review_events"."body") <> '' and char_length("manuscript_review_events"."body") <= 10000)
      or ("manuscript_review_events"."event_type" in ('resolved', 'reopened') and ("manuscript_review_events"."body" is null or (btrim("manuscript_review_events"."body") <> '' and char_length("manuscript_review_events"."body") <= 10000)))
    )
);
--> statement-breakpoint
ALTER TABLE "manuscript_review_threads" ADD CONSTRAINT "manuscript_review_threads_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_review_threads" ADD CONSTRAINT "manuscript_review_threads_project_manuscript_fk" FOREIGN KEY ("project_id","manuscript_id") REFERENCES "public"."manuscripts"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_review_threads" ADD CONSTRAINT "manuscript_review_threads_project_manuscript_section_fk" FOREIGN KEY ("project_id","manuscript_id","section_id") REFERENCES "public"."manuscript_sections"("project_id","manuscript_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_review_threads" ADD CONSTRAINT "manuscript_review_threads_project_section_item_fk" FOREIGN KEY ("project_id","manuscript_id","section_id","section_item_id","target_item_type") REFERENCES "public"."manuscript_section_items"("project_id","manuscript_id","section_id","id","item_type") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_review_threads" ADD CONSTRAINT "manuscript_review_threads_project_opening_claim_revision_fk" FOREIGN KEY ("project_id","opening_claim_id","opening_claim_revision_id") REFERENCES "public"."claim_revisions"("project_id","claim_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuscript_review_events" ADD CONSTRAINT "manuscript_review_events_project_thread_fk" FOREIGN KEY ("project_id","thread_id") REFERENCES "public"."manuscript_review_threads"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "manuscript_review_threads_project_target_idx" ON "manuscript_review_threads" USING btree ("project_id","manuscript_id","section_id","section_item_id");--> statement-breakpoint
CREATE INDEX "manuscript_review_events_project_thread_idx" ON "manuscript_review_events" USING btree ("project_id","thread_id","sequence");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_manuscript_review_thread_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Manuscript review threads are immutable';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER manuscript_review_threads_immutable
BEFORE UPDATE OR DELETE ON manuscript_review_threads
FOR EACH ROW EXECUTE FUNCTION prevent_manuscript_review_thread_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_manuscript_review_event_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Manuscript review events are append-only';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER manuscript_review_events_append_only
BEFORE UPDATE OR DELETE ON manuscript_review_events
FOR EACH ROW EXECUTE FUNCTION prevent_manuscript_review_event_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_manuscript_review_thread_target() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  section_archived_at timestamptz;
  item_removed_at timestamptz;
  item_type text;
  persisted_prose_text text;
  persisted_prose_section_id uuid;
  persisted_claim_id uuid;
  persisted_claim_revision_id uuid;
  persisted_placement_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF NEW.target_item_type = 'claim' THEN
    -- Claim replacement/removal both serialize on Placement first (removal's
    -- joined read also locks its SectionItem). Keep Placement as this target's
    -- mandatory first lock before taking the shared Section/SectionItem rows.
    SELECT c.placement_id
      INTO persisted_placement_id
    FROM manuscript_section_item_claims c
    WHERE c.project_id = NEW.project_id
      AND c.manuscript_id = NEW.manuscript_id
      AND c.section_id = NEW.section_id
      AND c.section_item_id = NEW.section_item_id
      AND c.item_type = 'claim';
    IF persisted_placement_id IS NULL THEN
      RAISE EXCEPTION 'Review target Claim SectionItem has no Claim placement';
    END IF;

    SELECT p.claim_id, p.claim_revision_id
      INTO persisted_claim_id, persisted_claim_revision_id
    FROM manuscript_claim_placements p
    WHERE p.project_id = NEW.project_id
      AND p.manuscript_id = NEW.manuscript_id
      AND p.section_id = NEW.section_id
      AND p.id = persisted_placement_id
      AND p.removed_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'New review threads require an active Claim placement';
    END IF;

    IF persisted_claim_id IS DISTINCT FROM NEW.opening_claim_id
      OR persisted_claim_revision_id IS DISTINCT FROM NEW.opening_claim_revision_id THEN
      RAISE EXCEPTION 'Opening Claim snapshot must match the exact current placement';
    END IF;
  ELSE
    -- The released section writer serializes Section before creating/ordering
    -- Prose rows. Read only the Section identity here; the exact text is read
    -- under the Section lock below before the SectionItem lock is taken.
    SELECT p.section_id
      INTO persisted_prose_section_id
    FROM manuscript_prose_blocks p
    WHERE p.project_id = NEW.project_id
      AND p.manuscript_id = NEW.manuscript_id
      AND p.section_id = NEW.section_id
      AND p.section_item_id = NEW.section_item_id
      AND p.item_type = 'prose';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Review target Prose SectionItem has no Prose block';
    END IF;
  END IF;

  -- Both target kinds take the Section lock before the shared SectionItem lock.
  -- Claim targets take their Placement lock before this point, matching
  -- released replacement/removal paths. Prose takes its subtype lock after
  -- Section, matching the released section writer's Section serialization.
  SELECT s.archived_at
    INTO section_archived_at
  FROM manuscript_sections s
  WHERE s.project_id = NEW.project_id
    AND s.manuscript_id = NEW.manuscript_id
    AND s.id = NEW.section_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Review target Section does not exist';
  END IF;
  IF section_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'New review threads require a non-archived Section';
  END IF;

  IF NEW.target_item_type = 'prose' THEN
    SELECT p.text
      INTO persisted_prose_text
    FROM manuscript_prose_blocks p
    WHERE p.project_id = NEW.project_id
      AND p.manuscript_id = NEW.manuscript_id
      AND p.section_id = NEW.section_id
      AND p.section_item_id = NEW.section_item_id
      AND p.item_type = 'prose'
    FOR UPDATE;
    IF NOT FOUND OR persisted_prose_section_id IS DISTINCT FROM NEW.section_id THEN
      RAISE EXCEPTION 'Review target Prose SectionItem has no Prose block';
    END IF;
    IF persisted_prose_text IS DISTINCT FROM NEW.opening_prose_text THEN
      RAISE EXCEPTION 'Opening Prose snapshot must match the exact persisted Prose text';
    END IF;
  END IF;

  SELECT i.removed_at, i.item_type
    INTO item_removed_at, item_type
  FROM manuscript_section_items i
  WHERE i.project_id = NEW.project_id
    AND i.manuscript_id = NEW.manuscript_id
    AND i.section_id = NEW.section_id
    AND i.id = NEW.section_item_id
  FOR UPDATE;
  IF NOT FOUND OR item_type IS DISTINCT FROM NEW.target_item_type THEN
    RAISE EXCEPTION 'Review target SectionItem identity does not match';
  END IF;
  IF item_removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'New review threads require an active SectionItem';
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER manuscript_review_threads_target_guard
BEFORE INSERT ON manuscript_review_threads
FOR EACH ROW EXECUTE FUNCTION validate_manuscript_review_thread_target();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_manuscript_review_event_transition() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  current_state text := 'open';
  has_opened boolean := false;
  prior_event record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- Serializing on the thread makes transition checks deterministic for
  -- concurrent writers. The deferred validator below rereads all rows.
  PERFORM 1
  FROM manuscript_review_threads t
  WHERE t.project_id = NEW.project_id AND t.id = NEW.thread_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Review event requires an existing thread';
  END IF;

  SELECT e.event_type
    INTO prior_event
  FROM manuscript_review_events e
  WHERE e.project_id = NEW.project_id
    AND e.thread_id = NEW.thread_id
    AND e.event_type IN ('opened', 'resolved', 'reopened')
    ORDER BY e.sequence DESC
    LIMIT 1;

  IF prior_event IS NULL THEN
    IF NEW.event_type <> 'opened' THEN
      RAISE EXCEPTION 'A review thread must begin with opened';
    END IF;
  ELSE
    has_opened := true;
    current_state := CASE
      WHEN prior_event.event_type IN ('opened', 'reopened') THEN 'open'
      ELSE 'resolved'
    END;
    IF NEW.event_type = 'opened' THEN
      RAISE EXCEPTION 'A review thread can only be opened once';
    ELSIF NEW.event_type = 'resolved' AND current_state <> 'open' THEN
      RAISE EXCEPTION 'Only an open review thread can be resolved';
    ELSIF NEW.event_type = 'reopened' AND current_state <> 'resolved' THEN
      RAISE EXCEPTION 'Only a resolved review thread can be reopened';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER manuscript_review_events_transition_guard
BEFORE INSERT ON manuscript_review_events
FOR EACH ROW EXECUTE FUNCTION enforce_manuscript_review_event_transition();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_manuscript_review_event_stream() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  event_row record;
  event_count integer;
  opened_count integer;
  current_state text := 'open';
  seen_opened boolean := false;
  target_project_id uuid;
  target_thread_id uuid;
BEGIN
  -- This constraint trigger is installed on both tables. Re-read the final
  -- persisted stream rather than relying on a stale NEW tuple shape.
  IF TG_TABLE_NAME = 'manuscript_review_threads' THEN
    target_project_id := NEW.project_id;
    target_thread_id := NEW.id;
  ELSE
    target_project_id := NEW.project_id;
    target_thread_id := NEW.thread_id;
  END IF;
  SELECT count(*)::integer, count(*) FILTER (WHERE e.event_type = 'opened')::integer
    INTO event_count, opened_count
  FROM manuscript_review_events e
  WHERE e.project_id = target_project_id AND e.thread_id = target_thread_id;

  IF event_count = 0 OR opened_count <> 1 THEN
    RAISE EXCEPTION 'Review thread must have exactly one opened event';
  END IF;

  FOR event_row IN
    SELECT e.event_type
    FROM manuscript_review_events e
    WHERE e.project_id = target_project_id AND e.thread_id = target_thread_id
    ORDER BY e.sequence
  LOOP
    IF NOT seen_opened THEN
      IF event_row.event_type <> 'opened' THEN
        RAISE EXCEPTION 'The first review event must be opened';
      END IF;
      seen_opened := true;
    ELSIF event_row.event_type = 'opened' THEN
      RAISE EXCEPTION 'A review thread can only be opened once';
    ELSIF event_row.event_type = 'resolved' THEN
      IF current_state <> 'open' THEN
        RAISE EXCEPTION 'Only an open review thread can be resolved';
      END IF;
      current_state := 'resolved';
    ELSIF event_row.event_type = 'reopened' THEN
      IF current_state <> 'resolved' THEN
        RAISE EXCEPTION 'Only a resolved review thread can be reopened';
      END IF;
      current_state := 'open';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER manuscript_review_threads_event_stream
AFTER INSERT ON manuscript_review_threads
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_manuscript_review_event_stream();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER manuscript_review_events_event_stream
AFTER INSERT ON manuscript_review_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_manuscript_review_event_stream();
