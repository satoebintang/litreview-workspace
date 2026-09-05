CREATE FUNCTION prevent_screening_criterion_delete() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'screening criteria are archive-only';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER screening_criteria_archive_only
BEFORE DELETE ON screening_criteria
FOR EACH ROW EXECUTE FUNCTION prevent_screening_criterion_delete();
--> statement-breakpoint
CREATE FUNCTION validate_active_screening_criterion() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.decision = 'exclude' THEN
    IF NOT EXISTS (
      SELECT 1 FROM screening_criteria c
      WHERE c.project_id = NEW.project_id
        AND c.id = NEW.exclusion_criterion_id
        AND c.type = 'exclusion'
        AND c.archived_at IS NULL
    ) THEN
      RAISE EXCEPTION 'exclusion criterion must be active and project-owned';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER screening_decisions_active_criterion
BEFORE INSERT ON screening_decisions
FOR EACH ROW EXECUTE FUNCTION validate_active_screening_criterion();
