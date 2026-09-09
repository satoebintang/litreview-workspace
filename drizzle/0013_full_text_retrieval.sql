CREATE TABLE "full_text_retrieval_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "full_text_retrieval_attempts_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"method" text,
	"source_reference" text,
	"note" text,
	"attempted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "full_text_retrieval_attempts_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "full_text_retrieval_attempts_outcome_valid" CHECK ("full_text_retrieval_attempts"."outcome" in ('pending', 'unavailable', 'retrieved')),
	CONSTRAINT "full_text_retrieval_attempts_method_valid" CHECK ("full_text_retrieval_attempts"."method" is null or "full_text_retrieval_attempts"."method" in ('publisher', 'bibliographic_database', 'institutional_access', 'library', 'interlibrary_loan', 'author_contact', 'web', 'manual', 'other')),
	CONSTRAINT "full_text_retrieval_attempts_source_reference_nonblank" CHECK ("full_text_retrieval_attempts"."source_reference" is null or btrim("full_text_retrieval_attempts"."source_reference") <> ''),
	CONSTRAINT "full_text_retrieval_attempts_note_nonblank" CHECK ("full_text_retrieval_attempts"."note" is null or btrim("full_text_retrieval_attempts"."note") <> '')
);
--> statement-breakpoint
ALTER TABLE "full_text_retrieval_attempts" ADD CONSTRAINT "full_text_retrieval_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "full_text_retrieval_attempts" ADD CONSTRAINT "full_text_retrieval_attempts_project_paper_fk" FOREIGN KEY ("project_id","paper_id") REFERENCES "public"."papers"("project_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "full_text_retrieval_attempts_project_paper_sequence_idx" ON "full_text_retrieval_attempts" USING btree ("project_id","paper_id","sequence");
--> statement-breakpoint
CREATE FUNCTION prevent_full_text_retrieval_attempt_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'full-text retrieval attempts are append-only';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER full_text_retrieval_attempts_append_only
BEFORE UPDATE OR DELETE ON full_text_retrieval_attempts
FOR EACH ROW EXECUTE FUNCTION prevent_full_text_retrieval_attempt_mutation();
--> statement-breakpoint
CREATE FUNCTION validate_full_text_retrieval_attempt() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM 1 FROM papers p WHERE p.project_id = NEW.project_id AND p.id = NEW.paper_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'full-text retrieval attempt references an invalid project Paper';
  END IF;
  IF COALESCE((
    SELECT sd.decision = 'include' FROM screening_decisions sd
    WHERE sd.project_id = NEW.project_id
      AND sd.paper_id = NEW.paper_id
      AND sd.stage = 'title_abstract'
    ORDER BY sd.sequence DESC
    LIMIT 1
  ), false) IS NOT TRUE THEN
    RAISE EXCEPTION 'full-text retrieval requires a current title/abstract include decision';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER full_text_retrieval_attempts_validate
BEFORE INSERT ON full_text_retrieval_attempts
FOR EACH ROW EXECUTE FUNCTION validate_full_text_retrieval_attempt();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_full_text_screening_decision() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM 1 FROM papers p WHERE p.project_id = NEW.project_id AND p.id = NEW.paper_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'full-text screening decision references an invalid project Paper';
  END IF;
  IF COALESCE((
    SELECT sd.decision = 'include' FROM screening_decisions sd
    WHERE sd.project_id = NEW.project_id
      AND sd.paper_id = NEW.paper_id
      AND sd.stage = 'title_abstract'
    ORDER BY sd.sequence DESC
    LIMIT 1
  ), false) IS NOT TRUE THEN
    RAISE EXCEPTION 'full-text screening requires a current title/abstract include decision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM full_text_retrieval_attempts ra
    WHERE ra.project_id = NEW.project_id
      AND ra.paper_id = NEW.paper_id
      AND ra.sequence = (
        SELECT max(latest.sequence) FROM full_text_retrieval_attempts latest
        WHERE latest.project_id = NEW.project_id AND latest.paper_id = NEW.paper_id
      )
      AND ra.outcome = 'retrieved'
  ) THEN
    RAISE EXCEPTION 'full-text screening requires a current retrieved full-text retrieval attempt';
  END IF;
  IF NEW.decision = 'exclude' AND NOT EXISTS (
    SELECT 1 FROM full_text_screening_criteria c
    WHERE c.project_id = NEW.project_id
      AND c.id = NEW.exclusion_criterion_id
      AND c.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'full-text exclusion criterion must be active and project-owned';
  END IF;
  RETURN NEW;
END;
$function$;
