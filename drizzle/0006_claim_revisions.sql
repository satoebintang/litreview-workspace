CREATE TABLE "claim_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "claim_revisions_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
  "project_id" uuid NOT NULL,
  "claim_id" uuid NOT NULL,
  "state" text DEFAULT 'active' NOT NULL,
  "claim_text" text,
  "researcher_note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finalized_at" timestamp with time zone,
  CONSTRAINT "claim_revisions_project_id_id_unique" UNIQUE("project_id","id"),
  CONSTRAINT "claim_revisions_project_claim_id_id_unique" UNIQUE("project_id","claim_id","id"),
  CONSTRAINT "claim_revisions_state_valid" CHECK ("state" in ('active', 'withdrawn')),
  CONSTRAINT "claim_revisions_claim_text_shape" CHECK ((
    ("state" = 'active' and "claim_text" is not null and btrim("claim_text") <> '')
    or ("state" = 'withdrawn' and "claim_text" is null)
  )),
  CONSTRAINT "claim_revisions_note_nonblank" CHECK ("researcher_note" is null or btrim("researcher_note") <> '')
);
--> statement-breakpoint
CREATE TABLE "claim_revision_evidence_supports" (
  "project_id" uuid NOT NULL,
  "claim_revision_id" uuid NOT NULL,
  "evidence_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "claim_revision_evidence_supports_project_id_claim_revision_id_evidence_id_pk" PRIMARY KEY("project_id","claim_revision_id","evidence_id")
);
--> statement-breakpoint
CREATE TABLE "claim_revision_extraction_supports" (
  "project_id" uuid NOT NULL,
  "claim_revision_id" uuid NOT NULL,
  "extraction_revision_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "claim_revision_extraction_supports_project_id_claim_revision_id_extraction_revision_id_pk" PRIMARY KEY("project_id","claim_revision_id","extraction_revision_id")
);
--> statement-breakpoint
CREATE TABLE "claim_revision_synthesis_supports" (
  "project_id" uuid NOT NULL,
  "claim_revision_id" uuid NOT NULL,
  "synthesis_revision_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "claim_revision_synthesis_supports_project_id_claim_revision_id_synthesis_revision_id_pk" PRIMARY KEY("project_id","claim_revision_id","synthesis_revision_id")
);
--> statement-breakpoint
ALTER TABLE "claim_revisions" ADD CONSTRAINT "claim_revisions_project_claim_fk" FOREIGN KEY ("project_id","claim_id") REFERENCES "public"."claims"("project_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "claim_revision_evidence_supports" ADD CONSTRAINT "claim_revision_evidence_supports_project_revision_fk" FOREIGN KEY ("project_id","claim_revision_id") REFERENCES "public"."claim_revisions"("project_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "claim_revision_evidence_supports" ADD CONSTRAINT "claim_revision_evidence_supports_project_evidence_fk" FOREIGN KEY ("project_id","evidence_id") REFERENCES "public"."evidence"("project_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "claim_revision_extraction_supports" ADD CONSTRAINT "claim_revision_extraction_supports_project_revision_fk" FOREIGN KEY ("project_id","claim_revision_id") REFERENCES "public"."claim_revisions"("project_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "claim_revision_extraction_supports" ADD CONSTRAINT "claim_revision_extraction_supports_project_extraction_revision_fk" FOREIGN KEY ("project_id","extraction_revision_id") REFERENCES "public"."extraction_value_revisions"("project_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "claim_revision_synthesis_supports" ADD CONSTRAINT "claim_revision_synthesis_supports_project_revision_fk" FOREIGN KEY ("project_id","claim_revision_id") REFERENCES "public"."claim_revisions"("project_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "claim_revision_synthesis_supports" ADD CONSTRAINT "claim_revision_synthesis_supports_project_synthesis_revision_fk" FOREIGN KEY ("project_id","synthesis_revision_id") REFERENCES "public"."synthesis_revisions"("project_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "claim_revision_evidence_supports_project_revision_idx" ON "claim_revision_evidence_supports" USING btree ("project_id","claim_revision_id");
--> statement-breakpoint
CREATE INDEX "claim_revision_evidence_supports_project_evidence_idx" ON "claim_revision_evidence_supports" USING btree ("project_id","evidence_id");
--> statement-breakpoint
CREATE INDEX "claim_revision_extraction_supports_project_revision_idx" ON "claim_revision_extraction_supports" USING btree ("project_id","claim_revision_id");
--> statement-breakpoint
CREATE INDEX "claim_revision_extraction_supports_project_extraction_revision_idx" ON "claim_revision_extraction_supports" USING btree ("project_id","extraction_revision_id");
--> statement-breakpoint
CREATE INDEX "claim_revision_synthesis_supports_project_revision_idx" ON "claim_revision_synthesis_supports" USING btree ("project_id","claim_revision_id");
--> statement-breakpoint
CREATE INDEX "claim_revision_synthesis_supports_project_synthesis_revision_idx" ON "claim_revision_synthesis_supports" USING btree ("project_id","synthesis_revision_id");
--> statement-breakpoint
CREATE INDEX "claim_revisions_project_claim_sequence_idx" ON "claim_revisions" USING btree ("project_id","claim_id","sequence");
--> statement-breakpoint
CREATE INDEX "claim_revisions_project_sequence_idx" ON "claim_revisions" USING btree ("project_id","sequence");
--> statement-breakpoint
INSERT INTO "claim_revisions" ("project_id", "claim_id", "state", "claim_text", "created_at", "finalized_at")
SELECT c."project_id", c."id", 'active', c."claim_text", c."created_at",
       GREATEST(c."updated_at", COALESCE(MAX(ce."created_at"), c."updated_at"))
FROM "claims" c
LEFT JOIN "claim_evidence" ce
  ON ce."project_id" = c."project_id" AND ce."claim_id" = c."id"
GROUP BY c."project_id", c."id", c."claim_text", c."created_at", c."updated_at";
--> statement-breakpoint
INSERT INTO "claim_revision_evidence_supports" ("project_id", "claim_revision_id", "evidence_id", "created_at")
SELECT ce."project_id", r."id", ce."evidence_id", ce."created_at"
FROM "claim_evidence" ce
JOIN "claim_revisions" r
  ON r."project_id" = ce."project_id" AND r."claim_id" = ce."claim_id";
--> statement-breakpoint
DO $$
DECLARE
  legacy_claims bigint;
  migrated_claims bigint;
  legacy_links bigint;
  migrated_links bigint;
  missing_revisions bigint;
  duplicate_revisions bigint;
  missing_support bigint;
BEGIN
  SELECT count(*) INTO legacy_claims FROM "claims";
  SELECT count(*) INTO migrated_claims FROM "claim_revisions";
  IF legacy_claims <> migrated_claims THEN
    RAISE EXCEPTION 'ClaimRevision migration count mismatch: legacy %, migrated %', legacy_claims, migrated_claims;
  END IF;
  SELECT count(*) INTO missing_revisions FROM "claims" c
  WHERE NOT EXISTS (SELECT 1 FROM "claim_revisions" r WHERE r."project_id" = c."project_id" AND r."claim_id" = c."id");
  IF missing_revisions <> 0 THEN
    RAISE EXCEPTION 'ClaimRevision migration has % claims without a revision', missing_revisions;
  END IF;
  SELECT count(*) INTO duplicate_revisions FROM (
    SELECT project_id, claim_id FROM claim_revisions GROUP BY project_id, claim_id HAVING count(*) <> 1
  ) duplicates;
  IF duplicate_revisions <> 0 THEN
    RAISE EXCEPTION 'ClaimRevision migration has % claims with a revision cardinality other than one', duplicate_revisions;
  END IF;
  SELECT count(*) INTO legacy_links FROM "claim_evidence";
  SELECT count(*) INTO migrated_links FROM "claim_revision_evidence_supports";
  IF legacy_links <> migrated_links THEN
    RAISE EXCEPTION 'direct Evidence support migration count mismatch: legacy %, migrated %', legacy_links, migrated_links;
  END IF;
  SELECT count(*) INTO missing_support FROM "claim_evidence" ce
  WHERE NOT EXISTS (
    SELECT 1 FROM "claim_revisions" r
    JOIN "claim_revision_evidence_supports" s
      ON s."project_id" = r."project_id" AND s."claim_revision_id" = r."id" AND s."evidence_id" = ce."evidence_id"
    WHERE r."project_id" = ce."project_id" AND r."claim_id" = ce."claim_id"
  );
  IF missing_support <> 0 THEN
    RAISE EXCEPTION 'direct Evidence support migration has % unmigrated links', missing_support;
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE "claim_evidence";
--> statement-breakpoint
ALTER TABLE "claims" DROP CONSTRAINT IF EXISTS "claims_text_nonblank";
--> statement-breakpoint
ALTER TABLE "claims" DROP COLUMN "claim_text";
--> statement-breakpoint
ALTER TABLE "claims" DROP COLUMN "updated_at";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_claim_revision_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.finalized_at IS NOT NULL THEN RAISE EXCEPTION 'Claim revisions must be finalized after creation'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Claim revisions are append-only'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.sequence IS DISTINCT FROM OLD.sequence OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.claim_id IS DISTINCT FROM OLD.claim_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Claim revision identity is immutable';
  END IF;
  IF OLD.finalized_at IS NOT NULL THEN
    IF NEW.finalized_at IS DISTINCT FROM OLD.finalized_at OR NEW.state IS DISTINCT FROM OLD.state OR NEW.claim_text IS DISTINCT FROM OLD.claim_text OR NEW.researcher_note IS DISTINCT FROM OLD.researcher_note THEN
      RAISE EXCEPTION 'Finalized Claim revisions are immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.finalized_at IS NOT NULL AND NEW.state = 'withdrawn' AND EXISTS (
    SELECT 1 FROM "claim_revision_evidence_supports" s WHERE s."project_id" = NEW."project_id" AND s."claim_revision_id" = NEW."id"
    UNION ALL SELECT 1 FROM "claim_revision_extraction_supports" s WHERE s."project_id" = NEW."project_id" AND s."claim_revision_id" = NEW."id"
    UNION ALL SELECT 1 FROM "claim_revision_synthesis_supports" s WHERE s."project_id" = NEW."project_id" AND s."claim_revision_id" = NEW."id"
  ) THEN RAISE EXCEPTION 'Withdrawn Claim revisions cannot have support'; END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER claim_revisions_append_only BEFORE INSERT OR UPDATE OR DELETE ON "claim_revisions" FOR EACH ROW EXECUTE FUNCTION prevent_claim_revision_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_claim_revision_support_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Claim revision supports are immutable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "claim_revisions" r WHERE r."project_id" = NEW."project_id" AND r."id" = NEW."claim_revision_id" AND r."state" = 'active' AND r."finalized_at" IS NULL) THEN
    RAISE EXCEPTION 'Support can only be added to an active draft Claim revision';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER claim_revision_evidence_supports_append_only BEFORE INSERT OR UPDATE OR DELETE ON "claim_revision_evidence_supports" FOR EACH ROW EXECUTE FUNCTION prevent_claim_revision_support_mutation();
--> statement-breakpoint
CREATE TRIGGER claim_revision_extraction_supports_append_only BEFORE INSERT OR UPDATE OR DELETE ON "claim_revision_extraction_supports" FOR EACH ROW EXECUTE FUNCTION prevent_claim_revision_support_mutation();
--> statement-breakpoint
CREATE TRIGGER claim_revision_synthesis_supports_append_only BEFORE INSERT OR UPDATE OR DELETE ON "claim_revision_synthesis_supports" FOR EACH ROW EXECUTE FUNCTION prevent_claim_revision_support_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_claim_revision_extraction_support() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "extraction_value_revisions" r
    JOIN LATERAL (SELECT d."decision" FROM "screening_decisions" d WHERE d."project_id" = r."project_id" AND d."paper_id" = r."paper_id" AND d."stage" = 'title_abstract' ORDER BY d."sequence" DESC LIMIT 1) current_screening
      ON current_screening."decision" = 'include'
    WHERE r."project_id" = NEW."project_id" AND r."id" = NEW."extraction_revision_id" AND r."finalized_at" IS NOT NULL AND r."value_state" <> 'cleared'
  ) THEN RAISE EXCEPTION 'Extraction support must reference a finalized non-cleared revision from an included Paper'; END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER claim_revision_extraction_supports_eligible BEFORE INSERT ON "claim_revision_extraction_supports" FOR EACH ROW EXECUTE FUNCTION validate_claim_revision_extraction_support();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_claim_revision_synthesis_support() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "synthesis_revisions" r
    WHERE r."project_id" = NEW."project_id" AND r."id" = NEW."synthesis_revision_id" AND r."state" = 'active' AND r."finalized_at" IS NOT NULL
      AND (SELECT current_r."state" FROM "synthesis_revisions" current_r WHERE current_r."project_id" = r."project_id" AND current_r."synthesis_statement_id" = r."synthesis_statement_id" AND current_r."finalized_at" IS NOT NULL ORDER BY current_r."sequence" DESC LIMIT 1) = 'active'
  ) THEN RAISE EXCEPTION 'Synthesis support must reference a finalized active revision whose statement is currently active'; END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER claim_revision_synthesis_supports_eligible BEFORE INSERT ON "claim_revision_synthesis_supports" FOR EACH ROW EXECUTE FUNCTION validate_claim_revision_synthesis_support();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_claim_delete() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN RAISE EXCEPTION 'Claims are append-only; withdraw instead'; END;
$function$;
--> statement-breakpoint
CREATE TRIGGER claims_append_only BEFORE DELETE ON "claims" FOR EACH ROW EXECUTE FUNCTION prevent_claim_delete();
