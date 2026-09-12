CREATE TABLE "research_question_answer_claim_contexts" (
	"project_id" uuid NOT NULL,
	"research_question_id" uuid NOT NULL,
	"answer_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"claim_revision_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_question_answer_claim_contexts_project_id_answer_id_claim_revision_id_pk" PRIMARY KEY("project_id","answer_id","claim_revision_id"),
	CONSTRAINT "research_question_answer_claim_contexts_answer_sort_order_unique" UNIQUE("project_id","answer_id","sort_order"),
	CONSTRAINT "research_question_answer_claim_contexts_sort_order_valid" CHECK ("research_question_answer_claim_contexts"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "research_question_answer_synthesis_contexts" (
	"project_id" uuid NOT NULL,
	"research_question_id" uuid NOT NULL,
	"answer_id" uuid NOT NULL,
	"synthesis_statement_id" uuid NOT NULL,
	"synthesis_revision_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_question_answer_synthesis_contexts_project_id_answer_id_synthesis_revision_id_pk" PRIMARY KEY("project_id","answer_id","synthesis_revision_id"),
	CONSTRAINT "research_question_answer_synthesis_contexts_answer_sort_order_unique" UNIQUE("project_id","answer_id","sort_order"),
	CONSTRAINT "research_question_answer_synthesis_contexts_sort_order_valid" CHECK ("research_question_answer_synthesis_contexts"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "research_question_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "research_question_answers_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"research_question_id" uuid NOT NULL,
	"answer_text" text NOT NULL,
	"researcher_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "research_question_answers_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "research_question_answers_project_question_id_id_unique" UNIQUE("project_id","research_question_id","id"),
	CONSTRAINT "research_question_answers_answer_text_shape" CHECK (btrim("research_question_answers"."answer_text") <> '' and char_length("research_question_answers"."answer_text") <= 20000),
	CONSTRAINT "research_question_answers_researcher_note_shape" CHECK ("research_question_answers"."researcher_note" is null or (btrim("research_question_answers"."researcher_note") <> '' and char_length("research_question_answers"."researcher_note") <= 20000))
);
--> statement-breakpoint
ALTER TABLE "research_question_answer_claim_contexts" ADD CONSTRAINT "research_question_answer_claim_contexts_answer_fk" FOREIGN KEY ("project_id","research_question_id","answer_id") REFERENCES "public"."research_question_answers"("project_id","research_question_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_question_answer_claim_contexts" ADD CONSTRAINT "research_question_answer_claim_contexts_revision_fk" FOREIGN KEY ("project_id","claim_id","claim_revision_id") REFERENCES "public"."claim_revisions"("project_id","claim_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_question_answer_synthesis_contexts" ADD CONSTRAINT "research_question_answer_synthesis_contexts_answer_fk" FOREIGN KEY ("project_id","research_question_id","answer_id") REFERENCES "public"."research_question_answers"("project_id","research_question_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_question_answer_synthesis_contexts" ADD CONSTRAINT "research_question_answer_synthesis_contexts_revision_fk" FOREIGN KEY ("project_id","synthesis_statement_id","synthesis_revision_id") REFERENCES "public"."synthesis_revisions"("project_id","synthesis_statement_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_question_answers" ADD CONSTRAINT "research_question_answers_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_question_answers" ADD CONSTRAINT "research_question_answers_project_question_fk" FOREIGN KEY ("project_id","research_question_id") REFERENCES "public"."research_questions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_question_answer_claim_contexts_answer_idx" ON "research_question_answer_claim_contexts" USING btree ("project_id","answer_id","sort_order");--> statement-breakpoint
CREATE INDEX "research_question_answer_claim_contexts_claim_idx" ON "research_question_answer_claim_contexts" USING btree ("project_id","claim_id");--> statement-breakpoint
CREATE INDEX "research_question_answer_claim_contexts_revision_idx" ON "research_question_answer_claim_contexts" USING btree ("project_id","claim_revision_id");--> statement-breakpoint
CREATE INDEX "research_question_answer_synthesis_contexts_answer_idx" ON "research_question_answer_synthesis_contexts" USING btree ("project_id","answer_id","sort_order");--> statement-breakpoint
CREATE INDEX "research_question_answer_synthesis_contexts_statement_idx" ON "research_question_answer_synthesis_contexts" USING btree ("project_id","synthesis_statement_id");--> statement-breakpoint
CREATE INDEX "research_question_answer_synthesis_contexts_revision_idx" ON "research_question_answer_synthesis_contexts" USING btree ("project_id","synthesis_revision_id");--> statement-breakpoint
CREATE INDEX "research_question_answers_project_question_sequence_idx" ON "research_question_answers" USING btree ("project_id","research_question_id","sequence");--> statement-breakpoint
CREATE INDEX "research_question_answers_project_sequence_idx" ON "research_question_answers" USING btree ("project_id","sequence");
--> statement-breakpoint
-- Current-link eligibility is intentionally latest-event-first.  The helper
-- selects the greatest global sequence for the exact typed pair before it
-- inspects the action; filtering action in the WHERE clause would make an
-- unlinked target appear linked again.
CREATE OR REPLACE FUNCTION research_question_answer_claim_context_eligible(
  p_project_id uuid,
  p_research_question_id uuid,
  p_claim_id uuid,
  p_claim_revision_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  latest_action text;
  revision_sequence bigint;
  revision_state text;
  revision_finalized_at timestamptz;
BEGIN
  SELECT e.action
  INTO latest_action
  FROM research_question_claim_events e
  WHERE e.project_id = p_project_id
    AND e.research_question_id = p_research_question_id
    AND e.claim_id = p_claim_id
  ORDER BY e.sequence DESC
  LIMIT 1;

  IF latest_action IS DISTINCT FROM 'linked' THEN
    RETURN false;
  END IF;

  SELECT r.sequence, r.state, r.finalized_at
  INTO revision_sequence, revision_state, revision_finalized_at
  FROM claim_revisions r
  WHERE r.project_id = p_project_id
    AND r.claim_id = p_claim_id
    AND r.id = p_claim_revision_id;

  IF NOT FOUND
    OR revision_finalized_at IS NULL
    OR revision_state <> 'active'
  THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM claim_revisions newer
    WHERE newer.project_id = p_project_id
      AND newer.claim_id = p_claim_id
      AND newer.finalized_at IS NOT NULL
      AND newer.sequence > revision_sequence
  ) THEN
    RETURN false;
  END IF;

  -- This is the released ClaimRevision support-status definition: an active
  -- revision with at least one row in any canonical Claim support table.
  IF NOT EXISTS (
    SELECT 1
    FROM claim_revision_evidence_supports s
    WHERE s.project_id = p_project_id
      AND s.claim_revision_id = p_claim_revision_id
    UNION ALL
    SELECT 1
    FROM claim_revision_extraction_supports s
    WHERE s.project_id = p_project_id
      AND s.claim_revision_id = p_claim_revision_id
    UNION ALL
    SELECT 1
    FROM claim_revision_synthesis_supports s
    WHERE s.project_id = p_project_id
      AND s.claim_revision_id = p_claim_revision_id
  ) THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION research_question_answer_synthesis_context_eligible(
  p_project_id uuid,
  p_research_question_id uuid,
  p_synthesis_statement_id uuid,
  p_synthesis_revision_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  latest_action text;
  revision_sequence bigint;
  revision_state text;
  revision_finalized_at timestamptz;
BEGIN
  SELECT e.action
  INTO latest_action
  FROM research_question_synthesis_statement_events e
  WHERE e.project_id = p_project_id
    AND e.research_question_id = p_research_question_id
    AND e.synthesis_statement_id = p_synthesis_statement_id
  ORDER BY e.sequence DESC
  LIMIT 1;

  IF latest_action IS DISTINCT FROM 'linked' THEN
    RETURN false;
  END IF;

  SELECT r.sequence, r.state, r.finalized_at
  INTO revision_sequence, revision_state, revision_finalized_at
  FROM synthesis_revisions r
  WHERE r.project_id = p_project_id
    AND r.synthesis_statement_id = p_synthesis_statement_id
    AND r.id = p_synthesis_revision_id;

  IF NOT FOUND
    OR revision_finalized_at IS NULL
    OR revision_state <> 'active'
  THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM synthesis_revisions newer
    WHERE newer.project_id = p_project_id
      AND newer.synthesis_statement_id = p_synthesis_statement_id
      AND newer.finalized_at IS NOT NULL
      AND newer.sequence > revision_sequence
  ) THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM synthesis_revision_supports s
    WHERE s.project_id = p_project_id
      AND s.synthesis_revision_id = p_synthesis_revision_id
  ) THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_research_question_answer_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.finalized_at IS NOT NULL THEN
      RAISE EXCEPTION 'Research Question Answers must be finalized after creation' USING ERRCODE = '23514';
    END IF;
    -- This lock is the DB serialization boundary shared with Slice 20
    -- traceability and ResearchQuestion archival.
    PERFORM 1
    FROM research_questions q
    WHERE q.project_id = NEW.project_id
      AND q.id = NEW.research_question_id
      AND q.archived_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      IF EXISTS (
        SELECT 1 FROM research_questions q
        WHERE q.project_id = NEW.project_id AND q.id = NEW.research_question_id
      ) THEN
        RAISE EXCEPTION 'Archived research questions cannot receive new Answers' USING ERRCODE = '23514';
      END IF;
      RAISE EXCEPTION 'Research question does not belong to this Project' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Research Question Answers are append-only' USING ERRCODE = '23514';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.sequence IS DISTINCT FROM OLD.sequence
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.research_question_id IS DISTINCT FROM OLD.research_question_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Research Question Answer identity is immutable' USING ERRCODE = '23514';
  END IF;

  IF OLD.finalized_at IS NOT NULL THEN
    IF NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
      OR NEW.answer_text IS DISTINCT FROM OLD.answer_text
      OR NEW.researcher_note IS DISTINCT FROM OLD.researcher_note
    THEN
      RAISE EXCEPTION 'Finalized Research Question Answers are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- Draft rows are database-only construction state.  The only permitted
  -- draft update is NULL -> finalization timestamp.
  IF NEW.answer_text IS DISTINCT FROM OLD.answer_text
    OR NEW.researcher_note IS DISTINCT FROM OLD.researcher_note
  THEN
    RAISE EXCEPTION 'Research Question Answer content is immutable before finalization' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER research_question_answers_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON research_question_answers
FOR EACH ROW EXECUTE FUNCTION prevent_research_question_answer_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_research_question_answer_context_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  answer_finalized_at timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Research Question Answer contexts are immutable' USING ERRCODE = '23514';
  END IF;

  SELECT a.finalized_at
  INTO answer_finalized_at
  FROM research_question_answers a
  WHERE a.project_id = NEW.project_id
    AND a.id = NEW.answer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Research Question Answer does not belong to this Project' USING ERRCODE = '23503';
  END IF;
  IF answer_finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'Contexts cannot be added to a finalized Research Question Answer' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER research_question_answer_claim_contexts_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON research_question_answer_claim_contexts
FOR EACH ROW EXECUTE FUNCTION prevent_research_question_answer_context_mutation();
--> statement-breakpoint
CREATE TRIGGER research_question_answer_synthesis_contexts_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON research_question_answer_synthesis_contexts
FOR EACH ROW EXECUTE FUNCTION prevent_research_question_answer_context_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_research_question_answer_finalization() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  current_project_id uuid;
  current_question_id uuid;
  current_finalized_at timestamptz;
  question_archived_at timestamptz;
  claim_context_count integer;
  synthesis_context_count integer;
  claim_to_lock uuid;
  synthesis_to_lock uuid;
  claim_context record;
  synthesis_context record;
BEGIN
  -- Use only the immutable trigger identity to find the persisted row.  A
  -- deferred trigger tuple can be stale after subsequent writes in the same
  -- transaction, so every validation input is re-read below.
  SELECT a.project_id, a.research_question_id, a.finalized_at
  INTO current_project_id, current_question_id, current_finalized_at
  FROM research_question_answers a
  WHERE a.project_id = NEW.project_id
    AND a.id = NEW.id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF current_finalized_at IS NULL THEN
    RAISE EXCEPTION 'Draft Research Question Answers cannot survive transaction commit' USING ERRCODE = '23514';
  END IF;

  -- Preserve the canonical lock order even for direct SQL: RQ first, then
  -- selected stable analytical parents.
  SELECT q.archived_at
  INTO question_archived_at
  FROM research_questions q
  WHERE q.project_id = current_project_id
    AND q.id = current_question_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Research question does not belong to this Project' USING ERRCODE = '23503';
  END IF;
  IF question_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Archived research questions cannot receive new Answers' USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer
  INTO claim_context_count
  FROM research_question_answer_claim_contexts c
  WHERE c.project_id = current_project_id
    AND c.research_question_id = current_question_id
    AND c.answer_id = NEW.id;

  SELECT count(*)::integer
  INTO synthesis_context_count
  FROM research_question_answer_synthesis_contexts s
  WHERE s.project_id = current_project_id
    AND s.research_question_id = current_question_id
    AND s.answer_id = NEW.id;

  IF claim_context_count > 100 THEN
    RAISE EXCEPTION 'Claim context count (%) exceeds operational limit of 100', claim_context_count USING ERRCODE = '23514';
  END IF;
  IF synthesis_context_count > 100 THEN
    RAISE EXCEPTION 'Synthesis context count (%) exceeds operational limit of 100', synthesis_context_count USING ERRCODE = '23514';
  END IF;
  IF claim_context_count + synthesis_context_count < 1 THEN
    RAISE EXCEPTION 'A finalized Research Question Answer must contain at least one context' USING ERRCODE = '23514';
  END IF;

  -- Lock all selected Claims in deterministic UUID order before any
  -- SynthesisStatement lock, preventing an inverse parent -> RQ path.
  FOR claim_to_lock IN
    SELECT DISTINCT ctx.claim_id
    FROM research_question_answer_claim_contexts ctx
    WHERE ctx.project_id = current_project_id
      AND ctx.answer_id = NEW.id
    ORDER BY ctx.claim_id
  LOOP
    PERFORM 1
    FROM claims c
    WHERE c.project_id = current_project_id
      AND c.id = claim_to_lock
    FOR UPDATE;
  END LOOP;

  FOR synthesis_to_lock IN
    SELECT DISTINCT ctx.synthesis_statement_id
    FROM research_question_answer_synthesis_contexts ctx
    WHERE ctx.project_id = current_project_id
      AND ctx.answer_id = NEW.id
    ORDER BY ctx.synthesis_statement_id
  LOOP
    PERFORM 1
    FROM synthesis_statements s
    WHERE s.project_id = current_project_id
      AND s.id = synthesis_to_lock
    FOR UPDATE;
  END LOOP;

  FOR claim_context IN
    SELECT c.project_id, c.research_question_id, c.claim_id, c.claim_revision_id
    FROM research_question_answer_claim_contexts c
    WHERE c.project_id = current_project_id
      AND c.research_question_id = current_question_id
      AND c.answer_id = NEW.id
    ORDER BY c.sort_order, c.claim_revision_id
  LOOP
    IF NOT research_question_answer_claim_context_eligible(
      claim_context.project_id,
      claim_context.research_question_id,
      claim_context.claim_id,
      claim_context.claim_revision_id
    ) THEN
      RAISE EXCEPTION 'Claim context (%) is not currently linked, current, active, and supported', claim_context.claim_revision_id USING ERRCODE = '23514';
    END IF;
  END LOOP;

  FOR synthesis_context IN
    SELECT s.project_id, s.research_question_id, s.synthesis_statement_id, s.synthesis_revision_id
    FROM research_question_answer_synthesis_contexts s
    WHERE s.project_id = current_project_id
      AND s.research_question_id = current_question_id
      AND s.answer_id = NEW.id
    ORDER BY s.sort_order, s.synthesis_revision_id
  LOOP
    IF NOT research_question_answer_synthesis_context_eligible(
      synthesis_context.project_id,
      synthesis_context.research_question_id,
      synthesis_context.synthesis_statement_id,
      synthesis_context.synthesis_revision_id
    ) THEN
      RAISE EXCEPTION 'Synthesis context (%) is not currently linked, current, active, and supported', synthesis_context.synthesis_revision_id USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER research_question_answers_finalization_validation
AFTER INSERT OR UPDATE ON research_question_answers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_research_question_answer_finalization();
