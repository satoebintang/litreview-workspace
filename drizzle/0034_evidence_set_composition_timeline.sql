LOCK TABLE evidence_sets, evidence_set_memberships, evidence_set_composition_revisions,
  evidence_set_composition_members, evidence_set_annotations IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint

ALTER TABLE evidence_set_composition_revisions
  DROP CONSTRAINT evidence_set_composition_revisions_operation_kind_valid;--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ADD COLUMN set_ordinal bigint;--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ADD COLUMN previous_revision_id uuid;--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ADD COLUMN head_membership_id uuid;--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ADD COLUMN tail_membership_id uuid;--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ADD COLUMN member_count integer;--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ADD COLUMN distinct_paper_count integer;--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ADD COLUMN target_membership_id uuid;--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ADD COLUMN move_direction text;--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ADD COLUMN transition_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id();--> statement-breakpoint

CREATE TABLE evidence_set_membership_order_versions (
  project_id uuid NOT NULL,
  evidence_set_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  next_membership_id uuid,
  valid_from_ordinal bigint NOT NULL,
  valid_to_ordinal bigint,
  CONSTRAINT evidence_set_membership_order_versions_pk
    PRIMARY KEY (project_id, evidence_set_id, membership_id, valid_from_ordinal),
  CONSTRAINT evidence_set_membership_order_versions_interval_valid
    CHECK (valid_to_ordinal IS NULL OR valid_to_ordinal > valid_from_ordinal),
  CONSTRAINT evidence_set_membership_order_versions_no_self_link
    CHECK (next_membership_id IS NULL OR next_membership_id <> membership_id)
);--> statement-breakpoint

CREATE TABLE evidence_set_paper_member_counts (
  project_id uuid NOT NULL,
  evidence_set_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  member_count integer NOT NULL,
  CONSTRAINT evidence_set_paper_member_counts_pk
    PRIMARY KEY (project_id, evidence_set_id, paper_id),
  CONSTRAINT evidence_set_paper_member_counts_member_count_valid
    CHECK (member_count > 0)
);--> statement-breakpoint

DROP TRIGGER evidence_set_composition_revisions_append_only ON evidence_set_composition_revisions;--> statement-breakpoint
WITH ranked AS (
  SELECT r.project_id, r.evidence_set_id, r.id,
    row_number() OVER (PARTITION BY r.project_id, r.evidence_set_id ORDER BY r.sequence)::bigint AS set_ordinal,
    lag(r.id) OVER (PARTITION BY r.project_id, r.evidence_set_id ORDER BY r.sequence) AS previous_revision_id
  FROM evidence_set_composition_revisions r
), summaries AS (
  SELECT r.project_id, r.evidence_set_id, r.id,
    count(cm.membership_id)::integer AS member_count,
    count(DISTINCT e.paper_id)::integer AS distinct_paper_count
  FROM evidence_set_composition_revisions r
  LEFT JOIN evidence_set_composition_members cm
    ON cm.project_id = r.project_id AND cm.evidence_set_id = r.evidence_set_id
   AND cm.composition_revision_id = r.id
  LEFT JOIN evidence_set_memberships m
    ON m.project_id = cm.project_id AND m.evidence_set_id = cm.evidence_set_id
   AND m.id = cm.membership_id
  LEFT JOIN evidence e ON e.project_id = m.project_id AND e.id = m.evidence_id
  GROUP BY r.project_id, r.evidence_set_id, r.id
), roots AS (
  SELECT r.project_id, r.evidence_set_id, r.id,
    (SELECT cm.membership_id FROM evidence_set_composition_members cm
      WHERE cm.project_id = r.project_id AND cm.evidence_set_id = r.evidence_set_id
        AND cm.composition_revision_id = r.id
      ORDER BY cm.sort_order LIMIT 1) AS head_membership_id,
    (SELECT cm.membership_id FROM evidence_set_composition_members cm
      WHERE cm.project_id = r.project_id AND cm.evidence_set_id = r.evidence_set_id
        AND cm.composition_revision_id = r.id
      ORDER BY cm.sort_order DESC LIMIT 1) AS tail_membership_id
  FROM evidence_set_composition_revisions r
), targets AS (
  SELECT r.project_id, r.evidence_set_id, r.id,
    CASE
      WHEN r.operation_kind IN ('added', 'readded') THEN (
        SELECT current_member.membership_id
        FROM evidence_set_composition_members current_member
        WHERE current_member.project_id = r.project_id
          AND current_member.evidence_set_id = r.evidence_set_id
          AND current_member.composition_revision_id = r.id
          AND NOT EXISTS (
            SELECT 1 FROM evidence_set_composition_members previous_member
            WHERE previous_member.project_id = r.project_id
              AND previous_member.evidence_set_id = r.evidence_set_id
              AND previous_member.composition_revision_id = (
                SELECT previous_revision.id FROM evidence_set_composition_revisions previous_revision
                WHERE previous_revision.project_id = r.project_id
                  AND previous_revision.evidence_set_id = r.evidence_set_id
                  AND previous_revision.sequence < r.sequence
                ORDER BY previous_revision.sequence DESC LIMIT 1
              )
              AND previous_member.membership_id = current_member.membership_id
          ) LIMIT 1
      )
      WHEN r.operation_kind = 'removed' THEN (
        SELECT previous_member.membership_id
        FROM evidence_set_composition_members previous_member
        WHERE previous_member.project_id = r.project_id
          AND previous_member.evidence_set_id = r.evidence_set_id
          AND previous_member.composition_revision_id = (
            SELECT previous_revision.id FROM evidence_set_composition_revisions previous_revision
            WHERE previous_revision.project_id = r.project_id
              AND previous_revision.evidence_set_id = r.evidence_set_id
              AND previous_revision.sequence < r.sequence
            ORDER BY previous_revision.sequence DESC LIMIT 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM evidence_set_composition_members current_member
            WHERE current_member.project_id = r.project_id
              AND current_member.evidence_set_id = r.evidence_set_id
              AND current_member.composition_revision_id = r.id
              AND current_member.membership_id = previous_member.membership_id
          ) LIMIT 1
      )
      ELSE NULL
    END AS target_membership_id
  FROM evidence_set_composition_revisions r
)
UPDATE evidence_set_composition_revisions r
SET set_ordinal = ranked.set_ordinal,
    previous_revision_id = ranked.previous_revision_id,
    head_membership_id = roots.head_membership_id,
    tail_membership_id = roots.tail_membership_id,
    member_count = summaries.member_count,
    distinct_paper_count = summaries.distinct_paper_count,
    target_membership_id = targets.target_membership_id
FROM ranked
JOIN summaries ON summaries.project_id = ranked.project_id
  AND summaries.evidence_set_id = ranked.evidence_set_id AND summaries.id = ranked.id
JOIN roots ON roots.project_id = ranked.project_id
  AND roots.evidence_set_id = ranked.evidence_set_id AND roots.id = ranked.id
JOIN targets ON targets.project_id = ranked.project_id
  AND targets.evidence_set_id = ranked.evidence_set_id AND targets.id = ranked.id
WHERE r.project_id = ranked.project_id AND r.evidence_set_id = ranked.evidence_set_id
  AND r.id = ranked.id;--> statement-breakpoint
CREATE TRIGGER evidence_set_composition_revisions_append_only
BEFORE UPDATE OR DELETE ON evidence_set_composition_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_evidence_set_history_mutation();--> statement-breakpoint

ALTER TABLE evidence_set_composition_revisions
  ALTER COLUMN set_ordinal SET NOT NULL;--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ALTER COLUMN member_count SET NOT NULL;--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ALTER COLUMN distinct_paper_count SET NOT NULL;--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ADD CONSTRAINT evidence_set_composition_revisions_project_set_ordinal_unique
    UNIQUE (project_id, evidence_set_id, set_ordinal);--> statement-breakpoint
CREATE UNIQUE INDEX evidence_set_composition_revisions_project_set_previous_unique
  ON evidence_set_composition_revisions (project_id, evidence_set_id, previous_revision_id)
  WHERE previous_revision_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX evidence_set_composition_revisions_project_set_created_unique
  ON evidence_set_composition_revisions (project_id, evidence_set_id)
  WHERE operation_kind = 'created';--> statement-breakpoint
CREATE INDEX evidence_set_composition_revisions_project_set_target_idx
  ON evidence_set_composition_revisions (project_id, evidence_set_id, target_membership_id, set_ordinal);--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ADD CONSTRAINT evidence_set_composition_revisions_project_set_previous_fk
    FOREIGN KEY (project_id, evidence_set_id, previous_revision_id)
    REFERENCES evidence_set_composition_revisions (project_id, evidence_set_id, id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ADD CONSTRAINT evidence_set_composition_revisions_project_set_head_membership_fk
    FOREIGN KEY (project_id, evidence_set_id, head_membership_id)
    REFERENCES evidence_set_memberships (project_id, evidence_set_id, id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ADD CONSTRAINT evidence_set_composition_revisions_project_set_tail_membership_fk
    FOREIGN KEY (project_id, evidence_set_id, tail_membership_id)
    REFERENCES evidence_set_memberships (project_id, evidence_set_id, id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ADD CONSTRAINT evidence_set_composition_revisions_project_set_target_membership_fk
    FOREIGN KEY (project_id, evidence_set_id, target_membership_id)
    REFERENCES evidence_set_memberships (project_id, evidence_set_id, id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ADD CONSTRAINT evidence_set_composition_revisions_member_summary_valid
    CHECK (member_count >= 0 AND distinct_paper_count >= 0 AND distinct_paper_count <= member_count);--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ADD CONSTRAINT evidence_set_composition_revisions_move_direction_valid
    CHECK (move_direction IS NULL OR move_direction IN ('up', 'down'));--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ADD CONSTRAINT evidence_set_composition_revisions_operation_shape
    CHECK (
      (operation_kind = 'created' AND previous_revision_id IS NULL AND target_membership_id IS NULL AND move_direction IS NULL)
      OR (operation_kind IN ('added', 'readded', 'removed') AND previous_revision_id IS NOT NULL AND target_membership_id IS NOT NULL AND move_direction IS NULL)
      OR (operation_kind = 'moved' AND previous_revision_id IS NOT NULL AND target_membership_id IS NOT NULL AND move_direction IS NOT NULL)
      OR (operation_kind = 'reordered' AND previous_revision_id IS NOT NULL AND target_membership_id IS NULL AND move_direction IS NULL)
    );--> statement-breakpoint
ALTER TABLE evidence_set_composition_revisions
  ADD CONSTRAINT evidence_set_composition_revisions_operation_kind_valid
    CHECK (operation_kind IN ('created', 'added', 'readded', 'removed', 'reordered', 'moved'));--> statement-breakpoint

WITH latest_revisions AS (
  SELECT DISTINCT ON (project_id, evidence_set_id)
    project_id, evidence_set_id, id
  FROM evidence_set_composition_revisions
  ORDER BY project_id, evidence_set_id, set_ordinal DESC
)
INSERT INTO evidence_set_paper_member_counts (project_id, evidence_set_id, paper_id, member_count)
SELECT latest.project_id, latest.evidence_set_id, e.paper_id, count(*)::integer
FROM latest_revisions latest
JOIN evidence_set_composition_members cm
  ON cm.project_id = latest.project_id AND cm.evidence_set_id = latest.evidence_set_id
 AND cm.composition_revision_id = latest.id
JOIN evidence_set_memberships m
  ON m.project_id = cm.project_id AND m.evidence_set_id = cm.evidence_set_id
 AND m.id = cm.membership_id
JOIN evidence e ON e.project_id = m.project_id AND e.id = m.evidence_id
GROUP BY latest.project_id, latest.evidence_set_id, e.paper_id;--> statement-breakpoint

WITH snapshots AS (
  SELECT cm.project_id, cm.evidence_set_id, cm.membership_id,
    r.set_ordinal,
    lead(cm.membership_id) OVER (
      PARTITION BY cm.project_id, cm.evidence_set_id, cm.composition_revision_id
      ORDER BY cm.sort_order
    ) AS next_membership_id
  FROM evidence_set_composition_members cm
  JOIN evidence_set_composition_revisions r
    ON r.project_id = cm.project_id AND r.evidence_set_id = cm.evidence_set_id
   AND r.id = cm.composition_revision_id
), lagged AS (
  SELECT snapshots.*,
    lag(set_ordinal) OVER (PARTITION BY project_id, evidence_set_id, membership_id ORDER BY set_ordinal) AS previous_ordinal,
    lag(next_membership_id) OVER (PARTITION BY project_id, evidence_set_id, membership_id ORDER BY set_ordinal) AS previous_next_membership_id,
    max(set_ordinal) OVER (PARTITION BY project_id, evidence_set_id) AS latest_ordinal
  FROM snapshots
), runs AS (
  SELECT lagged.*,
    sum(CASE WHEN previous_ordinal = set_ordinal - 1
                  AND previous_next_membership_id IS NOT DISTINCT FROM next_membership_id
             THEN 0 ELSE 1 END)
      OVER (PARTITION BY project_id, evidence_set_id, membership_id ORDER BY set_ordinal) AS run_id
  FROM lagged
), intervals AS (
  SELECT project_id, evidence_set_id, membership_id, next_membership_id,
    min(set_ordinal) AS valid_from_ordinal,
    CASE WHEN max(set_ordinal) = max(latest_ordinal) THEN NULL::bigint ELSE max(set_ordinal) + 1 END AS valid_to_ordinal
  FROM runs
  GROUP BY project_id, evidence_set_id, membership_id, next_membership_id, run_id
)
INSERT INTO evidence_set_membership_order_versions
  (project_id, evidence_set_id, membership_id, next_membership_id, valid_from_ordinal, valid_to_ordinal)
SELECT project_id, evidence_set_id, membership_id, next_membership_id, valid_from_ordinal, valid_to_ordinal
FROM intervals;--> statement-breakpoint

ALTER TABLE evidence_set_membership_order_versions
  ADD CONSTRAINT evidence_set_membership_order_versions_project_set_membership_fk
    FOREIGN KEY (project_id, evidence_set_id, membership_id)
    REFERENCES evidence_set_memberships (project_id, evidence_set_id, id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE evidence_set_membership_order_versions
  ADD CONSTRAINT evidence_set_membership_order_versions_project_set_next_membership_fk
    FOREIGN KEY (project_id, evidence_set_id, next_membership_id)
    REFERENCES evidence_set_memberships (project_id, evidence_set_id, id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE evidence_set_membership_order_versions
  ADD CONSTRAINT evidence_set_membership_order_versions_project_set_valid_from_revision_fk
    FOREIGN KEY (project_id, evidence_set_id, valid_from_ordinal)
    REFERENCES evidence_set_composition_revisions (project_id, evidence_set_id, set_ordinal) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE evidence_set_membership_order_versions
  ADD CONSTRAINT evidence_set_membership_order_versions_project_set_valid_to_revision_fk
    FOREIGN KEY (project_id, evidence_set_id, valid_to_ordinal)
    REFERENCES evidence_set_composition_revisions (project_id, evidence_set_id, set_ordinal) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE evidence_set_paper_member_counts
  ADD CONSTRAINT evidence_set_paper_member_counts_project_set_fk
    FOREIGN KEY (project_id, evidence_set_id) REFERENCES evidence_sets (project_id, id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE evidence_set_paper_member_counts
  ADD CONSTRAINT evidence_set_paper_member_counts_project_paper_fk
    FOREIGN KEY (project_id, paper_id) REFERENCES papers (project_id, id) ON DELETE RESTRICT;--> statement-breakpoint

CREATE INDEX evidence_set_membership_order_versions_project_set_member_from_idx
  ON evidence_set_membership_order_versions (project_id, evidence_set_id, membership_id, valid_from_ordinal);--> statement-breakpoint
CREATE INDEX evidence_set_membership_order_versions_project_set_next_from_idx
  ON evidence_set_membership_order_versions (project_id, evidence_set_id, next_membership_id, valid_from_ordinal);--> statement-breakpoint
CREATE UNIQUE INDEX evidence_set_membership_order_versions_open_member_unique
  ON evidence_set_membership_order_versions (project_id, evidence_set_id, membership_id)
  WHERE valid_to_ordinal IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX evidence_set_membership_order_versions_open_successor_unique
  ON evidence_set_membership_order_versions (project_id, evidence_set_id, next_membership_id)
  WHERE valid_to_ordinal IS NULL AND next_membership_id IS NOT NULL;--> statement-breakpoint

DO $migration_equivalence$
DECLARE
  revision_row record;
  old_members uuid[];
  new_members uuid[];
  reconstructed_tail uuid;
BEGIN
  FOR revision_row IN
    SELECT r.project_id, r.evidence_set_id, r.id, r.set_ordinal,
      r.head_membership_id, r.tail_membership_id, r.member_count, r.distinct_paper_count
    FROM evidence_set_composition_revisions r
    ORDER BY r.project_id, r.evidence_set_id, r.set_ordinal
  LOOP
    SELECT coalesce(array_agg(cm.membership_id ORDER BY cm.sort_order), ARRAY[]::uuid[])
      INTO old_members
    FROM evidence_set_composition_members cm
    WHERE cm.project_id = revision_row.project_id AND cm.evidence_set_id = revision_row.evidence_set_id
      AND cm.composition_revision_id = revision_row.id;

    WITH RECURSIVE walk(membership_id, next_membership_id, depth, path) AS (
      SELECT v.membership_id, v.next_membership_id, 1,
        ARRAY[v.membership_id]::uuid[]
      FROM evidence_set_membership_order_versions v
      WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
        AND v.membership_id = revision_row.head_membership_id
        AND v.valid_from_ordinal <= revision_row.set_ordinal
        AND (v.valid_to_ordinal IS NULL OR revision_row.set_ordinal < v.valid_to_ordinal)
      UNION ALL
      SELECT next_version.membership_id, next_version.next_membership_id,
        walk.depth + 1, walk.path || next_version.membership_id
      FROM walk
      JOIN evidence_set_membership_order_versions next_version
        ON next_version.project_id = revision_row.project_id
       AND next_version.evidence_set_id = revision_row.evidence_set_id
       AND next_version.membership_id = walk.next_membership_id
       AND next_version.valid_from_ordinal <= revision_row.set_ordinal
       AND (next_version.valid_to_ordinal IS NULL OR revision_row.set_ordinal < next_version.valid_to_ordinal)
      WHERE walk.next_membership_id IS NOT NULL
        AND NOT walk.next_membership_id = ANY(walk.path)
    )
    SELECT coalesce(array_agg(walk.membership_id ORDER BY walk.depth), ARRAY[]::uuid[]),
      (array_agg(walk.membership_id ORDER BY walk.depth DESC))[1]
      INTO new_members, reconstructed_tail
    FROM walk;

    IF old_members IS DISTINCT FROM new_members THEN
      RAISE EXCEPTION 'Evidence Set temporal backfill equivalence failed for Set %, revision %',
        revision_row.evidence_set_id, revision_row.id USING ERRCODE = '23514';
    END IF;
    IF cardinality(new_members) <> revision_row.member_count
      OR (revision_row.member_count = 0 AND (revision_row.head_membership_id IS NOT NULL OR revision_row.tail_membership_id IS NOT NULL))
      OR (revision_row.member_count = 1 AND (revision_row.head_membership_id IS DISTINCT FROM revision_row.tail_membership_id OR reconstructed_tail IS DISTINCT FROM revision_row.tail_membership_id))
      OR (revision_row.member_count > 1 AND (revision_row.head_membership_id IS NULL OR revision_row.tail_membership_id IS NULL OR reconstructed_tail IS DISTINCT FROM revision_row.tail_membership_id))
    THEN
      RAISE EXCEPTION 'Evidence Set temporal root or member count failed for Set %, revision %',
        revision_row.evidence_set_id, revision_row.id USING ERRCODE = '23514';
    END IF;
    IF reconstructed_tail IS NOT NULL AND EXISTS (
      SELECT 1 FROM evidence_set_membership_order_versions tail_version
      WHERE tail_version.project_id = revision_row.project_id
        AND tail_version.evidence_set_id = revision_row.evidence_set_id
        AND tail_version.membership_id = reconstructed_tail
        AND tail_version.valid_from_ordinal <= revision_row.set_ordinal
        AND (tail_version.valid_to_ordinal IS NULL OR revision_row.set_ordinal < tail_version.valid_to_ordinal)
        AND tail_version.next_membership_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Evidence Set reconstructed tail is not terminal for Set %, revision %',
        revision_row.evidence_set_id, revision_row.id USING ERRCODE = '23514';
    END IF;
  END LOOP;
END;
$migration_equivalence$;--> statement-breakpoint

CREATE INDEX evidence_set_membership_order_versions_project_set_member_to_idx
  ON evidence_set_membership_order_versions (project_id, evidence_set_id, membership_id, valid_to_ordinal);--> statement-breakpoint
CREATE INDEX evidence_set_membership_order_versions_project_set_next_to_idx
  ON evidence_set_membership_order_versions (project_id, evidence_set_id, next_membership_id, valid_to_ordinal);--> statement-breakpoint

CREATE OR REPLACE FUNCTION evidence_set_transition_old_next(
  p_project_id uuid,
  p_evidence_set_id uuid,
  p_revision_id uuid,
  p_membership_id uuid
) RETURNS uuid
LANGUAGE sql STABLE
AS $function$
  SELECT v.next_membership_id
  FROM evidence_set_membership_order_versions v
  JOIN evidence_set_composition_revisions r
    ON r.project_id = v.project_id AND r.evidence_set_id = v.evidence_set_id
   AND r.id = p_revision_id
  WHERE v.project_id = p_project_id AND v.evidence_set_id = p_evidence_set_id
    AND v.membership_id = p_membership_id
    AND v.valid_from_ordinal < r.set_ordinal
    AND (v.valid_to_ordinal IS NULL OR v.valid_to_ordinal >= r.set_ordinal)
  ORDER BY v.valid_from_ordinal DESC
  LIMIT 1
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION evidence_set_transition_old_predecessor(
  p_project_id uuid,
  p_evidence_set_id uuid,
  p_revision_id uuid,
  p_membership_id uuid
) RETURNS uuid
LANGUAGE sql STABLE
AS $function$
  SELECT v.membership_id
  FROM evidence_set_membership_order_versions v
  JOIN evidence_set_composition_revisions r
    ON r.project_id = v.project_id AND r.evidence_set_id = v.evidence_set_id
   AND r.id = p_revision_id
  WHERE v.project_id = p_project_id AND v.evidence_set_id = p_evidence_set_id
    AND v.next_membership_id = p_membership_id
    AND v.valid_from_ordinal < r.set_ordinal
    AND (v.valid_to_ordinal IS NULL OR v.valid_to_ordinal >= r.set_ordinal)
  ORDER BY v.valid_from_ordinal DESC
  LIMIT 1
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION evidence_set_transition_old_is_active(
  p_project_id uuid,
  p_evidence_set_id uuid,
  p_revision_id uuid,
  p_membership_id uuid
) RETURNS boolean
LANGUAGE sql STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM evidence_set_membership_order_versions v
    JOIN evidence_set_composition_revisions r
      ON r.project_id = v.project_id AND r.evidence_set_id = v.evidence_set_id
     AND r.id = p_revision_id
    WHERE v.project_id = p_project_id AND v.evidence_set_id = p_evidence_set_id
      AND v.membership_id = p_membership_id
      AND v.valid_from_ordinal < r.set_ordinal
      AND (v.valid_to_ordinal IS NULL OR v.valid_to_ordinal >= r.set_ordinal)
  )
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION evidence_set_expected_link_after_transition(
  p_project_id uuid,
  p_evidence_set_id uuid,
  p_revision_id uuid,
  p_membership_id uuid
) RETURNS TABLE(allowed boolean, expected_next_membership_id uuid)
LANGUAGE plpgsql STABLE
AS $function$
DECLARE
  revision_row record;
  previous_tail uuid;
  target_previous uuid;
  target_next uuid;
  before_previous uuid;
  after_next uuid;
  old_left uuid;
  old_right uuid;
BEGIN
  SELECT r.operation_kind, r.target_membership_id, r.move_direction,
         p.id AS previous_id, p.tail_membership_id
    INTO revision_row
    FROM evidence_set_composition_revisions r
    LEFT JOIN evidence_set_composition_revisions p
      ON p.project_id = r.project_id AND p.evidence_set_id = r.evidence_set_id
     AND p.id = r.previous_revision_id
   WHERE r.project_id = p_project_id AND r.evidence_set_id = p_evidence_set_id
     AND r.id = p_revision_id;
  IF NOT FOUND OR revision_row.previous_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::uuid;
    RETURN;
  END IF;

  IF revision_row.operation_kind IN ('added', 'readded') THEN
    previous_tail := revision_row.tail_membership_id;
    IF p_membership_id = revision_row.target_membership_id THEN
      RETURN QUERY SELECT true, NULL::uuid;
      RETURN;
    END IF;
    IF previous_tail IS NOT NULL AND p_membership_id = previous_tail THEN
      RETURN QUERY SELECT true, revision_row.target_membership_id;
      RETURN;
    END IF;
  ELSIF revision_row.operation_kind = 'removed' THEN
    target_next := evidence_set_transition_old_next(
      p_project_id, p_evidence_set_id, p_revision_id, revision_row.target_membership_id
    );
    target_previous := evidence_set_transition_old_predecessor(
      p_project_id, p_evidence_set_id, p_revision_id, revision_row.target_membership_id
    );
    IF target_previous IS NOT NULL AND p_membership_id = target_previous THEN
      RETURN QUERY SELECT true, target_next;
      RETURN;
    END IF;
  ELSIF revision_row.operation_kind = 'moved' AND revision_row.move_direction = 'up' THEN
    target_previous := evidence_set_transition_old_predecessor(
      p_project_id, p_evidence_set_id, p_revision_id, revision_row.target_membership_id
    );
    target_next := evidence_set_transition_old_next(
      p_project_id, p_evidence_set_id, p_revision_id, revision_row.target_membership_id
    );
    IF target_previous IS NOT NULL THEN
      before_previous := evidence_set_transition_old_predecessor(
        p_project_id, p_evidence_set_id, p_revision_id, target_previous
      );
      IF p_membership_id = revision_row.target_membership_id THEN
        RETURN QUERY SELECT true, target_previous;
        RETURN;
      END IF;
      IF p_membership_id = target_previous THEN
        RETURN QUERY SELECT true, target_next;
        RETURN;
      END IF;
      IF before_previous IS NOT NULL AND p_membership_id = before_previous THEN
        RETURN QUERY SELECT true, revision_row.target_membership_id;
        RETURN;
      END IF;
    END IF;
  ELSIF revision_row.operation_kind = 'moved' AND revision_row.move_direction = 'down' THEN
    target_previous := evidence_set_transition_old_predecessor(
      p_project_id, p_evidence_set_id, p_revision_id, revision_row.target_membership_id
    );
    target_next := evidence_set_transition_old_next(
      p_project_id, p_evidence_set_id, p_revision_id, revision_row.target_membership_id
    );
    IF target_next IS NOT NULL THEN
      after_next := evidence_set_transition_old_next(
        p_project_id, p_evidence_set_id, p_revision_id, target_next
      );
      IF target_previous IS NOT NULL AND p_membership_id = target_previous THEN
        RETURN QUERY SELECT true, target_next;
        RETURN;
      END IF;
      IF p_membership_id = target_next THEN
        RETURN QUERY SELECT true, revision_row.target_membership_id;
        RETURN;
      END IF;
      IF p_membership_id = revision_row.target_membership_id THEN
        RETURN QUERY SELECT true, after_next;
        RETURN;
      END IF;
    END IF;
  ELSIF revision_row.operation_kind = 'reordered'
    AND evidence_set_transition_old_is_active(
      p_project_id, p_evidence_set_id, p_revision_id, p_membership_id
    ) THEN
    RETURN QUERY SELECT true, NULL::uuid;
    RETURN;
  END IF;

  RETURN QUERY SELECT false, NULL::uuid;
END;
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_evidence_set_composition_revision_insert() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  set_archived_at timestamptz;
  latest_revision record;
  target_paper_id uuid;
  target_created_at timestamptz;
  target_is_active boolean;
  target_next uuid;
  target_previous uuid;
  previous_of_previous uuid;
  next_after_target uuid;
  previous_count integer;
  previous_distinct_paper_count integer;
  paper_active_count integer;
  has_prior_activation boolean;
  expected_head uuid;
  expected_tail uuid;
  expected_count integer;
  expected_distinct_paper_count integer;
BEGIN
  SELECT s.archived_at INTO set_archived_at
  FROM evidence_sets s
  WHERE s.project_id = NEW.project_id AND s.id = NEW.evidence_set_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evidence Set does not belong to this Project' USING ERRCODE = '23503';
  END IF;
  IF set_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Archived Evidence Sets cannot receive composition history' USING ERRCODE = '23514';
  END IF;

  SELECT r.id, r.set_ordinal, r.head_membership_id, r.tail_membership_id,
         r.member_count, r.distinct_paper_count
    INTO latest_revision
    FROM evidence_set_composition_revisions r
   WHERE r.project_id = NEW.project_id AND r.evidence_set_id = NEW.evidence_set_id
   ORDER BY r.set_ordinal DESC
   LIMIT 1;

  IF FOUND THEN
    IF NEW.operation_kind = 'created' THEN
      RAISE EXCEPTION 'created Evidence Set composition must be the sole initial revision' USING ERRCODE = '23514';
    END IF;
    IF NEW.set_ordinal IS NOT NULL AND NEW.set_ordinal <> latest_revision.set_ordinal + 1 THEN
      RAISE EXCEPTION 'Evidence Set revision ordinal must immediately follow the current revision' USING ERRCODE = '23514';
    END IF;
    IF NEW.previous_revision_id IS NOT NULL AND NEW.previous_revision_id IS DISTINCT FROM latest_revision.id THEN
      RAISE EXCEPTION 'Evidence Set revision predecessor must be the exact current revision' USING ERRCODE = '23514';
    END IF;
    NEW.set_ordinal := latest_revision.set_ordinal + 1;
    NEW.previous_revision_id := latest_revision.id;
    previous_count := latest_revision.member_count;
    previous_distinct_paper_count := latest_revision.distinct_paper_count;
    expected_count := previous_count;
    expected_distinct_paper_count := previous_distinct_paper_count;
    expected_head := latest_revision.head_membership_id;
    expected_tail := latest_revision.tail_membership_id;

    IF NEW.operation_kind IN ('added', 'readded', 'removed', 'moved') THEN
      IF NEW.target_membership_id IS NULL THEN
        RAISE EXCEPTION 'Evidence Set transition requires a target membership' USING ERRCODE = '23514';
      END IF;
      SELECT e.paper_id, m.created_at INTO target_paper_id, target_created_at
      FROM evidence_set_memberships m
      JOIN evidence e ON e.project_id = m.project_id AND e.id = m.evidence_id
      WHERE m.project_id = NEW.project_id AND m.evidence_set_id = NEW.evidence_set_id
        AND m.id = NEW.target_membership_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Evidence Set target membership does not belong to this Set and Project' USING ERRCODE = '23503';
      END IF;
      SELECT v.next_membership_id INTO target_next
      FROM evidence_set_membership_order_versions v
      WHERE v.project_id = NEW.project_id AND v.evidence_set_id = NEW.evidence_set_id
        AND v.membership_id = NEW.target_membership_id AND v.valid_to_ordinal IS NULL;
      target_is_active := FOUND;
      SELECT v.membership_id INTO target_previous
      FROM evidence_set_membership_order_versions v
      WHERE v.project_id = NEW.project_id AND v.evidence_set_id = NEW.evidence_set_id
        AND v.next_membership_id = NEW.target_membership_id AND v.valid_to_ordinal IS NULL;

      IF NEW.operation_kind IN ('added', 'readded') THEN
        IF target_is_active THEN
          RAISE EXCEPTION 'Evidence is already active in this Evidence Set' USING ERRCODE = '23514';
        END IF;
        SELECT EXISTS (
          SELECT 1 FROM evidence_set_membership_order_versions v
          WHERE v.project_id = NEW.project_id AND v.evidence_set_id = NEW.evidence_set_id
            AND v.membership_id = NEW.target_membership_id
            AND v.valid_from_ordinal < NEW.set_ordinal
        ) INTO has_prior_activation;
        IF NEW.operation_kind = 'added' AND has_prior_activation THEN
          RAISE EXCEPTION 'added transition requires a never-before-active membership' USING ERRCODE = '23514';
        ELSIF NEW.operation_kind = 'readded' AND NOT has_prior_activation THEN
          RAISE EXCEPTION 'readded transition requires a previously active membership' USING ERRCODE = '23514';
        END IF;
        IF NEW.operation_kind = 'added' AND target_created_at IS DISTINCT FROM transaction_timestamp() THEN
          RAISE EXCEPTION 'first activation must create its stable membership in the same transaction' USING ERRCODE = '23514';
        END IF;
        SELECT c.member_count INTO paper_active_count
        FROM evidence_set_paper_member_counts c
        WHERE c.project_id = NEW.project_id AND c.evidence_set_id = NEW.evidence_set_id
          AND c.paper_id = target_paper_id;
        paper_active_count := coalesce(paper_active_count, 0);
        expected_count := previous_count + 1;
        expected_distinct_paper_count := previous_distinct_paper_count + CASE WHEN paper_active_count = 0 THEN 1 ELSE 0 END;
        expected_head := coalesce(latest_revision.head_membership_id, NEW.target_membership_id);
        expected_tail := NEW.target_membership_id;
      ELSIF NEW.operation_kind = 'removed' THEN
        IF NOT target_is_active OR previous_count = 0 THEN
          RAISE EXCEPTION 'removed transition target is not currently active' USING ERRCODE = '23514';
        END IF;
        SELECT c.member_count INTO paper_active_count
        FROM evidence_set_paper_member_counts c
        WHERE c.project_id = NEW.project_id AND c.evidence_set_id = NEW.evidence_set_id
          AND c.paper_id = target_paper_id;
        IF coalesce(paper_active_count, 0) < 1 THEN
          RAISE EXCEPTION 'Evidence Set Paper counter is inconsistent with active membership' USING ERRCODE = '23514';
        END IF;
        expected_count := previous_count - 1;
        expected_distinct_paper_count := previous_distinct_paper_count - CASE WHEN paper_active_count = 1 THEN 1 ELSE 0 END;
        IF latest_revision.head_membership_id = NEW.target_membership_id THEN
          expected_head := target_next;
        END IF;
        IF latest_revision.tail_membership_id = NEW.target_membership_id THEN
          expected_tail := target_previous;
        END IF;
        IF expected_count = 0 THEN
          expected_head := NULL;
          expected_tail := NULL;
        END IF;
      ELSIF NEW.operation_kind = 'moved' THEN
        IF NOT target_is_active THEN
          RAISE EXCEPTION 'moved transition target is not currently active' USING ERRCODE = '23514';
        END IF;
        IF NEW.move_direction = 'up' THEN
          IF target_previous IS NULL THEN
            RAISE EXCEPTION 'boundary move cannot create a composition revision' USING ERRCODE = '23514';
          END IF;
          SELECT v.membership_id INTO previous_of_previous
          FROM evidence_set_membership_order_versions v
          WHERE v.project_id = NEW.project_id AND v.evidence_set_id = NEW.evidence_set_id
            AND v.next_membership_id = target_previous AND v.valid_to_ordinal IS NULL;
          IF target_previous = latest_revision.head_membership_id THEN
            expected_head := NEW.target_membership_id;
          END IF;
          IF NEW.target_membership_id = latest_revision.tail_membership_id THEN
            expected_tail := target_previous;
          END IF;
        ELSIF NEW.move_direction = 'down' THEN
          IF target_next IS NULL THEN
            RAISE EXCEPTION 'boundary move cannot create a composition revision' USING ERRCODE = '23514';
          END IF;
          SELECT v.next_membership_id INTO next_after_target
          FROM evidence_set_membership_order_versions v
          WHERE v.project_id = NEW.project_id AND v.evidence_set_id = NEW.evidence_set_id
            AND v.membership_id = target_next AND v.valid_to_ordinal IS NULL;
          IF NEW.target_membership_id = latest_revision.head_membership_id THEN
            expected_head := target_next;
          END IF;
          IF target_next = latest_revision.tail_membership_id THEN
            expected_tail := NEW.target_membership_id;
          END IF;
        ELSE
          RAISE EXCEPTION 'moved transition requires direction up or down' USING ERRCODE = '23514';
        END IF;
      END IF;
    ELSIF NEW.operation_kind = 'reordered' THEN
      IF NEW.target_membership_id IS NOT NULL OR NEW.move_direction IS NOT NULL OR previous_count = 0 THEN
        RAISE EXCEPTION 'reordered transition has invalid operation metadata' USING ERRCODE = '23514';
      END IF;
      IF NEW.member_count IS NOT NULL AND NEW.member_count <> previous_count THEN
        RAISE EXCEPTION 'reordered transition cannot change member count' USING ERRCODE = '23514';
      END IF;
      IF NEW.distinct_paper_count IS NOT NULL AND NEW.distinct_paper_count <> previous_distinct_paper_count THEN
        RAISE EXCEPTION 'reordered transition cannot change distinct Paper count' USING ERRCODE = '23514';
      END IF;
      expected_count := previous_count;
      expected_distinct_paper_count := previous_distinct_paper_count;
      expected_head := NEW.head_membership_id;
      expected_tail := NEW.tail_membership_id;
      IF expected_head IS NULL OR expected_tail IS NULL THEN
        RAISE EXCEPTION 'reordered transition requires a proposed head and tail' USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'Unsupported Evidence Set composition operation' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.operation_kind <> 'created' THEN
      RAISE EXCEPTION 'first Evidence Set composition revision must be created' USING ERRCODE = '23514';
    END IF;
    IF NEW.set_ordinal IS NOT NULL AND NEW.set_ordinal <> 1 THEN
      RAISE EXCEPTION 'created Evidence Set composition must have ordinal 1' USING ERRCODE = '23514';
    END IF;
    IF NEW.previous_revision_id IS NOT NULL OR NEW.target_membership_id IS NOT NULL OR NEW.move_direction IS NOT NULL
      OR NEW.head_membership_id IS NOT NULL OR NEW.tail_membership_id IS NOT NULL
      OR (NEW.member_count IS NOT NULL AND NEW.member_count <> 0)
      OR (NEW.distinct_paper_count IS NOT NULL AND NEW.distinct_paper_count <> 0) THEN
      RAISE EXCEPTION 'created Evidence Set composition must be the empty root revision' USING ERRCODE = '23514';
    END IF;
    NEW.set_ordinal := 1;
    NEW.previous_revision_id := NULL;
    expected_head := NULL;
    expected_tail := NULL;
    expected_count := 0;
    expected_distinct_paper_count := 0;
  END IF;

  IF NEW.head_membership_id IS NOT NULL AND NEW.head_membership_id IS DISTINCT FROM expected_head THEN
    RAISE EXCEPTION 'Evidence Set revision head does not match its transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.tail_membership_id IS NOT NULL AND NEW.tail_membership_id IS DISTINCT FROM expected_tail THEN
    RAISE EXCEPTION 'Evidence Set revision tail does not match its transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.member_count IS NOT NULL AND NEW.member_count IS DISTINCT FROM expected_count THEN
    RAISE EXCEPTION 'Evidence Set revision member count does not match its transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.distinct_paper_count IS NOT NULL AND NEW.distinct_paper_count IS DISTINCT FROM expected_distinct_paper_count THEN
    RAISE EXCEPTION 'Evidence Set revision Paper count does not match its transition' USING ERRCODE = '23514';
  END IF;
  NEW.head_membership_id := expected_head;
  NEW.tail_membership_id := expected_tail;
  NEW.member_count := expected_count;
  NEW.distinct_paper_count := expected_distinct_paper_count;
  RETURN NEW;
END;
$function$;--> statement-breakpoint

DROP TRIGGER evidence_set_composition_revisions_active_guard ON evidence_set_composition_revisions;--> statement-breakpoint
CREATE TRIGGER evidence_set_composition_revisions_transition_guard
BEFORE INSERT ON evidence_set_composition_revisions
FOR EACH ROW EXECUTE FUNCTION guard_evidence_set_composition_revision_insert();--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_evidence_set_membership_insert() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.created_at IS DISTINCT FROM transaction_timestamp() THEN
    RAISE EXCEPTION 'stable membership identity must be created in its first-add transaction' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
DROP TRIGGER evidence_set_memberships_active_guard ON evidence_set_memberships;--> statement-breakpoint
CREATE TRIGGER evidence_set_memberships_active_guard
BEFORE INSERT ON evidence_set_memberships
FOR EACH ROW EXECUTE FUNCTION guard_evidence_set_history_insert();--> statement-breakpoint
CREATE TRIGGER evidence_set_memberships_creation_time_guard
BEFORE INSERT ON evidence_set_memberships
FOR EACH ROW EXECUTE FUNCTION guard_evidence_set_membership_insert();--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_evidence_set_membership_first_add() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM evidence_set_composition_revisions r
    WHERE r.project_id = NEW.project_id AND r.evidence_set_id = NEW.evidence_set_id
      AND r.target_membership_id = NEW.id AND r.operation_kind = 'added'
      AND r.created_at = NEW.created_at
  ) THEN
    RAISE EXCEPTION 'stable Evidence Set membership requires a first-add composition revision in the same transaction' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER evidence_set_memberships_first_add_validation
AFTER INSERT ON evidence_set_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_evidence_set_membership_first_add();--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_evidence_set_order_version_insert() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  revision_row record;
  expected_row record;
  set_archived_at timestamptz;
BEGIN
  IF NEW.valid_to_ordinal IS NOT NULL THEN
    RAISE EXCEPTION 'new Evidence Set order versions must be open' USING ERRCODE = '23514';
  END IF;
  SELECT r.operation_kind, r.set_ordinal, r.previous_revision_id, r.transition_transaction_id
    INTO revision_row
    FROM evidence_set_composition_revisions r
   WHERE r.project_id = NEW.project_id AND r.evidence_set_id = NEW.evidence_set_id
     AND r.set_ordinal = NEW.valid_from_ordinal;
  IF NOT FOUND OR revision_row.previous_revision_id IS NULL
    OR revision_row.transition_transaction_id IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'order version must start at a non-created composition revision' USING ERRCODE = '23514';
  END IF;
  SELECT s.archived_at INTO set_archived_at
  FROM evidence_sets s
  WHERE s.project_id = NEW.project_id AND s.id = NEW.evidence_set_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evidence Set does not belong to this Project' USING ERRCODE = '23503';
  END IF;
  IF set_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Archived Evidence Sets cannot receive order versions' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO expected_row
  FROM evidence_set_expected_link_after_transition(
    NEW.project_id, NEW.evidence_set_id,
    (SELECT r.id FROM evidence_set_composition_revisions r
      WHERE r.project_id = NEW.project_id AND r.evidence_set_id = NEW.evidence_set_id
        AND r.set_ordinal = NEW.valid_from_ordinal),
    NEW.membership_id
  );
  IF NOT coalesce(expected_row.allowed, false) THEN
    RAISE EXCEPTION 'order version is outside the bounded Evidence Set transition neighborhood' USING ERRCODE = '23514';
  END IF;
  IF revision_row.operation_kind <> 'reordered'
    AND NEW.next_membership_id IS DISTINCT FROM expected_row.expected_next_membership_id THEN
    RAISE EXCEPTION 'order version link does not match the Evidence Set transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_evidence_set_order_version_update() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  revision_row record;
  allowed_close boolean;
  expected_predecessor uuid;
  expected_successor uuid;
  expected_outer uuid;
  previous_tail uuid;
  set_archived_at timestamptz;
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.evidence_set_id IS DISTINCT FROM OLD.evidence_set_id
    OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
    OR NEW.next_membership_id IS DISTINCT FROM OLD.next_membership_id
    OR NEW.valid_from_ordinal IS DISTINCT FROM OLD.valid_from_ordinal
    OR OLD.valid_to_ordinal IS NOT NULL THEN
    RAISE EXCEPTION 'Evidence Set order versions are immutable except for one close' USING ERRCODE = '23514';
  END IF;
  SELECT r.id, r.operation_kind, r.set_ordinal, r.previous_revision_id, r.target_membership_id,
         r.move_direction,
         r.transition_transaction_id
    INTO revision_row
    FROM evidence_set_composition_revisions r
   WHERE r.project_id = NEW.project_id AND r.evidence_set_id = NEW.evidence_set_id
     AND r.set_ordinal = NEW.valid_to_ordinal;
  IF NOT FOUND OR revision_row.previous_revision_id IS NULL OR OLD.valid_from_ordinal >= revision_row.set_ordinal
    OR revision_row.transition_transaction_id IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'order version closure must occur at the immediate next composition revision' USING ERRCODE = '23514';
  END IF;
  SELECT s.archived_at INTO set_archived_at
  FROM evidence_sets s
  WHERE s.project_id = NEW.project_id AND s.id = NEW.evidence_set_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evidence Set does not belong to this Project' USING ERRCODE = '23503';
  END IF;
  IF set_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Archived Evidence Sets cannot close order versions' USING ERRCODE = '23514';
  END IF;

  allowed_close := false;
  IF revision_row.operation_kind IN ('added', 'readded') THEN
    SELECT p.tail_membership_id INTO previous_tail
    FROM evidence_set_composition_revisions p
    WHERE p.project_id = NEW.project_id AND p.evidence_set_id = NEW.evidence_set_id
      AND p.id = revision_row.previous_revision_id;
    allowed_close := OLD.membership_id = previous_tail
      AND evidence_set_transition_old_is_active(
        NEW.project_id, NEW.evidence_set_id, revision_row.id, OLD.membership_id
      );
  ELSIF revision_row.operation_kind = 'removed' THEN
    expected_predecessor := evidence_set_transition_old_predecessor(
      NEW.project_id, NEW.evidence_set_id, revision_row.id, revision_row.target_membership_id
    );
    allowed_close := evidence_set_transition_old_is_active(
      NEW.project_id, NEW.evidence_set_id, revision_row.id, OLD.membership_id
    ) AND (
      OLD.membership_id = revision_row.target_membership_id
      OR (expected_predecessor IS NOT NULL AND OLD.membership_id = expected_predecessor)
    );
  ELSIF revision_row.operation_kind = 'moved' AND revision_row.move_direction = 'up' THEN
    expected_predecessor := evidence_set_transition_old_predecessor(
      NEW.project_id, NEW.evidence_set_id, revision_row.id, revision_row.target_membership_id
    );
    expected_outer := evidence_set_transition_old_predecessor(
      NEW.project_id, NEW.evidence_set_id, revision_row.id, expected_predecessor
    );
    allowed_close := evidence_set_transition_old_is_active(
      NEW.project_id, NEW.evidence_set_id, revision_row.id, OLD.membership_id
    ) AND (
      OLD.membership_id = revision_row.target_membership_id
      OR OLD.membership_id = expected_predecessor
      OR OLD.membership_id = expected_outer
    );
  ELSIF revision_row.operation_kind = 'moved' AND revision_row.move_direction = 'down' THEN
    expected_predecessor := evidence_set_transition_old_predecessor(
      NEW.project_id, NEW.evidence_set_id, revision_row.id, revision_row.target_membership_id
    );
    expected_successor := evidence_set_transition_old_next(
      NEW.project_id, NEW.evidence_set_id, revision_row.id, revision_row.target_membership_id
    );
    allowed_close := evidence_set_transition_old_is_active(
      NEW.project_id, NEW.evidence_set_id, revision_row.id, OLD.membership_id
    ) AND (
      OLD.membership_id = revision_row.target_membership_id
      OR OLD.membership_id = expected_successor
      OR OLD.membership_id = expected_predecessor
    );
  ELSIF revision_row.operation_kind = 'reordered' THEN
    -- Full reorder is the retained O(N) compatibility operation.
    allowed_close := evidence_set_transition_old_is_active(
      NEW.project_id, NEW.evidence_set_id, revision_row.id, OLD.membership_id
    );
  END IF;
  IF NOT coalesce(allowed_close, false) THEN
    RAISE EXCEPTION 'order version closure is outside the bounded Evidence Set transition neighborhood' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_evidence_set_order_version_delete() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Evidence Set order versions cannot be deleted';
END;
$function$;--> statement-breakpoint
CREATE TRIGGER evidence_set_order_versions_insert_guard
BEFORE INSERT ON evidence_set_membership_order_versions
FOR EACH ROW EXECUTE FUNCTION guard_evidence_set_order_version_insert();--> statement-breakpoint
CREATE TRIGGER evidence_set_order_versions_update_guard
BEFORE UPDATE ON evidence_set_membership_order_versions
FOR EACH ROW EXECUTE FUNCTION guard_evidence_set_order_version_update();--> statement-breakpoint
CREATE TRIGGER evidence_set_order_versions_delete_guard
BEFORE DELETE ON evidence_set_membership_order_versions
FOR EACH ROW EXECUTE FUNCTION prevent_evidence_set_order_version_delete();--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_evidence_set_paper_count_write() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Evidence Set Paper counters are maintained by composition transitions' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER evidence_set_paper_member_counts_guard
BEFORE INSERT OR UPDATE OR DELETE ON evidence_set_paper_member_counts
FOR EACH ROW EXECUTE FUNCTION guard_evidence_set_paper_count_write();--> statement-breakpoint

CREATE OR REPLACE FUNCTION maintain_evidence_set_paper_member_count() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  target_paper_id uuid;
  affected_rows integer;
BEGIN
  IF NEW.operation_kind IN ('added', 'readded', 'removed') THEN
    SELECT e.paper_id INTO target_paper_id
    FROM evidence_set_memberships m
    JOIN evidence e ON e.project_id = m.project_id AND e.id = m.evidence_id
    WHERE m.project_id = NEW.project_id AND m.evidence_set_id = NEW.evidence_set_id
      AND m.id = NEW.target_membership_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Evidence Set transition target has no same-Project Paper' USING ERRCODE = '23503';
    END IF;
    IF NEW.operation_kind IN ('added', 'readded') THEN
      INSERT INTO evidence_set_paper_member_counts (project_id, evidence_set_id, paper_id, member_count)
      VALUES (NEW.project_id, NEW.evidence_set_id, target_paper_id, 1)
      ON CONFLICT (project_id, evidence_set_id, paper_id)
      DO UPDATE SET member_count = evidence_set_paper_member_counts.member_count + 1;
    ELSE
      UPDATE evidence_set_paper_member_counts
      SET member_count = member_count - 1
      WHERE project_id = NEW.project_id AND evidence_set_id = NEW.evidence_set_id
        AND paper_id = target_paper_id AND member_count > 1;
      GET DIAGNOSTICS affected_rows = ROW_COUNT;
      IF affected_rows = 0 THEN
        DELETE FROM evidence_set_paper_member_counts
        WHERE project_id = NEW.project_id AND evidence_set_id = NEW.evidence_set_id
          AND paper_id = target_paper_id AND member_count = 1;
        GET DIAGNOSTICS affected_rows = ROW_COUNT;
      END IF;
      IF affected_rows <> 1 THEN
        RAISE EXCEPTION 'Evidence Set Paper counter is missing or invalid' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER evidence_set_composition_paper_count_delta
AFTER INSERT ON evidence_set_composition_revisions
FOR EACH ROW EXECUTE FUNCTION maintain_evidence_set_paper_member_count();--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_evidence_set_composition_revision() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  revision_row record;
  previous_row record;
  target_previous uuid;
  target_next uuid;
  before_previous uuid;
  after_next uuid;
  expected_previous_next uuid;
  old_order uuid[];
  new_order uuid[];
  old_sorted uuid[];
  new_sorted uuid[];
  head_next uuid;
  tail_next uuid;
  head_predecessor uuid;
  found_row boolean;
BEGIN
  SELECT r.* INTO revision_row
  FROM evidence_set_composition_revisions r
  WHERE r.project_id = NEW.project_id AND r.evidence_set_id = NEW.evidence_set_id
    AND r.id = NEW.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evidence Set composition revision disappeared during validation' USING ERRCODE = '23514';
  END IF;

  IF revision_row.previous_revision_id IS NULL THEN
    IF revision_row.operation_kind <> 'created' OR revision_row.set_ordinal <> 1
      OR revision_row.member_count <> 0 OR revision_row.distinct_paper_count <> 0
      OR revision_row.head_membership_id IS NOT NULL OR revision_row.tail_membership_id IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM evidence_set_membership_order_versions v
        WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
          AND v.valid_from_ordinal <= revision_row.set_ordinal
      ) THEN
      RAISE EXCEPTION 'created Evidence Set revision must be the mandatory empty initial composition' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT p.* INTO previous_row
  FROM evidence_set_composition_revisions p
  WHERE p.project_id = revision_row.project_id AND p.evidence_set_id = revision_row.evidence_set_id
    AND p.id = revision_row.previous_revision_id;
  IF NOT FOUND OR previous_row.set_ordinal + 1 <> revision_row.set_ordinal THEN
    RAISE EXCEPTION 'Evidence Set composition history must have one immediate predecessor' USING ERRCODE = '23514';
  END IF;

  IF revision_row.operation_kind IN ('added', 'readded') THEN
    target_previous := evidence_set_transition_old_predecessor(
      revision_row.project_id, revision_row.evidence_set_id, revision_row.id,
      revision_row.target_membership_id
    );
    IF NOT EXISTS (
      SELECT 1 FROM evidence_set_membership_order_versions v
      WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
        AND v.membership_id = revision_row.target_membership_id
        AND v.valid_from_ordinal = revision_row.set_ordinal AND v.next_membership_id IS NULL
    ) THEN
      RAISE EXCEPTION 'added Evidence Set membership lacks its exact new terminal version' USING ERRCODE = '23514';
    END IF;
    IF previous_row.tail_membership_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM evidence_set_membership_order_versions v
        WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
          AND v.membership_id = previous_row.tail_membership_id
          AND v.valid_to_ordinal = revision_row.set_ordinal AND v.next_membership_id IS NULL
      ) OR NOT EXISTS (
        SELECT 1 FROM evidence_set_membership_order_versions v
        WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
          AND v.membership_id = previous_row.tail_membership_id
          AND v.valid_from_ordinal = revision_row.set_ordinal
          AND v.next_membership_id = revision_row.target_membership_id
      ) THEN
        RAISE EXCEPTION 'added Evidence Set membership did not replace the former tail link' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF revision_row.operation_kind = 'removed' THEN
    target_next := evidence_set_transition_old_next(
      revision_row.project_id, revision_row.evidence_set_id, revision_row.id,
      revision_row.target_membership_id
    );
    target_previous := evidence_set_transition_old_predecessor(
      revision_row.project_id, revision_row.evidence_set_id, revision_row.id,
      revision_row.target_membership_id
    );
    IF NOT EXISTS (
      SELECT 1 FROM evidence_set_membership_order_versions v
      WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
        AND v.membership_id = revision_row.target_membership_id
        AND v.valid_to_ordinal = revision_row.set_ordinal
    ) OR EXISTS (
      SELECT 1 FROM evidence_set_membership_order_versions v
      WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
        AND v.membership_id = revision_row.target_membership_id
        AND v.valid_from_ordinal <= revision_row.set_ordinal
        AND (v.valid_to_ordinal IS NULL OR v.valid_to_ordinal > revision_row.set_ordinal)
    ) THEN
      RAISE EXCEPTION 'removed Evidence Set membership interval was not closed exactly' USING ERRCODE = '23514';
    END IF;
    IF target_previous IS NOT NULL AND (
      NOT EXISTS (
        SELECT 1 FROM evidence_set_membership_order_versions v
        WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
          AND v.membership_id = target_previous AND v.valid_to_ordinal = revision_row.set_ordinal
          AND v.next_membership_id = revision_row.target_membership_id
      ) OR NOT EXISTS (
        SELECT 1 FROM evidence_set_membership_order_versions v
        WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
          AND v.membership_id = target_previous AND v.valid_from_ordinal = revision_row.set_ordinal
          AND v.next_membership_id IS NOT DISTINCT FROM target_next
      )
    ) THEN
      RAISE EXCEPTION 'removed Evidence Set membership did not repair its predecessor link' USING ERRCODE = '23514';
    END IF;
  ELSIF revision_row.operation_kind = 'moved' AND revision_row.move_direction = 'up' THEN
    target_previous := evidence_set_transition_old_predecessor(
      revision_row.project_id, revision_row.evidence_set_id, revision_row.id,
      revision_row.target_membership_id
    );
    target_next := evidence_set_transition_old_next(
      revision_row.project_id, revision_row.evidence_set_id, revision_row.id,
      revision_row.target_membership_id
    );
    before_previous := evidence_set_transition_old_predecessor(
      revision_row.project_id, revision_row.evidence_set_id, revision_row.id,
      target_previous
    );
    IF NOT EXISTS (
      SELECT 1 FROM evidence_set_membership_order_versions v
      WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
        AND v.membership_id = revision_row.target_membership_id
        AND v.valid_to_ordinal = revision_row.set_ordinal AND v.next_membership_id IS NOT DISTINCT FROM target_next
    ) OR NOT EXISTS (
      SELECT 1 FROM evidence_set_membership_order_versions v
      WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
        AND v.membership_id = target_previous
        AND v.valid_to_ordinal = revision_row.set_ordinal
        AND v.next_membership_id = revision_row.target_membership_id
    ) OR NOT EXISTS (
      SELECT 1 FROM evidence_set_membership_order_versions v
      WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
        AND v.membership_id = revision_row.target_membership_id
        AND v.valid_from_ordinal = revision_row.set_ordinal
        AND v.next_membership_id = target_previous
    ) OR NOT EXISTS (
      SELECT 1 FROM evidence_set_membership_order_versions v
      WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
        AND v.membership_id = target_previous AND v.valid_from_ordinal = revision_row.set_ordinal
        AND v.next_membership_id IS NOT DISTINCT FROM target_next
    ) THEN
      RAISE EXCEPTION 'move-up transition did not replace its fixed predecessor/target neighborhood' USING ERRCODE = '23514';
    END IF;
    IF before_previous IS NOT NULL AND (
      NOT EXISTS (
        SELECT 1 FROM evidence_set_membership_order_versions v
        WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
          AND v.membership_id = before_previous AND v.valid_to_ordinal = revision_row.set_ordinal
          AND v.next_membership_id = target_previous
      ) OR NOT EXISTS (
        SELECT 1 FROM evidence_set_membership_order_versions v
        WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
          AND v.membership_id = before_previous AND v.valid_from_ordinal = revision_row.set_ordinal
          AND v.next_membership_id = revision_row.target_membership_id
      )
    ) THEN
      RAISE EXCEPTION 'move-up transition did not reconnect the outer predecessor' USING ERRCODE = '23514';
    END IF;
  ELSIF revision_row.operation_kind = 'moved' AND revision_row.move_direction = 'down' THEN
    target_previous := evidence_set_transition_old_predecessor(
      revision_row.project_id, revision_row.evidence_set_id, revision_row.id,
      revision_row.target_membership_id
    );
    target_next := evidence_set_transition_old_next(
      revision_row.project_id, revision_row.evidence_set_id, revision_row.id,
      revision_row.target_membership_id
    );
    after_next := evidence_set_transition_old_next(
      revision_row.project_id, revision_row.evidence_set_id, revision_row.id,
      target_next
    );
    IF NOT EXISTS (
      SELECT 1 FROM evidence_set_membership_order_versions v
      WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
        AND v.membership_id = revision_row.target_membership_id
        AND v.valid_to_ordinal = revision_row.set_ordinal AND v.next_membership_id = target_next
    ) OR NOT EXISTS (
      SELECT 1 FROM evidence_set_membership_order_versions v
      WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
        AND v.membership_id = target_next AND v.valid_to_ordinal = revision_row.set_ordinal
        AND v.next_membership_id IS NOT DISTINCT FROM after_next
    ) OR NOT EXISTS (
      SELECT 1 FROM evidence_set_membership_order_versions v
      WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
        AND v.membership_id = target_next AND v.valid_from_ordinal = revision_row.set_ordinal
        AND v.next_membership_id = revision_row.target_membership_id
    ) OR NOT EXISTS (
      SELECT 1 FROM evidence_set_membership_order_versions v
      WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
        AND v.membership_id = revision_row.target_membership_id
        AND v.valid_from_ordinal = revision_row.set_ordinal
        AND v.next_membership_id IS NOT DISTINCT FROM after_next
    ) THEN
      RAISE EXCEPTION 'move-down transition did not replace its fixed target/successor neighborhood' USING ERRCODE = '23514';
    END IF;
    IF target_previous IS NOT NULL AND (
      NOT EXISTS (
        SELECT 1 FROM evidence_set_membership_order_versions v
        WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
          AND v.membership_id = target_previous AND v.valid_to_ordinal = revision_row.set_ordinal
          AND v.next_membership_id = revision_row.target_membership_id
      ) OR NOT EXISTS (
        SELECT 1 FROM evidence_set_membership_order_versions v
        WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
          AND v.membership_id = target_previous AND v.valid_from_ordinal = revision_row.set_ordinal
          AND v.next_membership_id = target_next
      )
    ) THEN
      RAISE EXCEPTION 'move-down transition did not reconnect the outer predecessor' USING ERRCODE = '23514';
    END IF;
  ELSIF revision_row.operation_kind = 'reordered' THEN
    WITH RECURSIVE old_walk(membership_id, next_membership_id, depth, path) AS (
      SELECT v.membership_id, v.next_membership_id, 1, ARRAY[v.membership_id]::uuid[]
      FROM evidence_set_membership_order_versions v
      WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
        AND v.membership_id = previous_row.head_membership_id
        AND v.valid_from_ordinal <= previous_row.set_ordinal
        AND (v.valid_to_ordinal IS NULL OR previous_row.set_ordinal < v.valid_to_ordinal)
      UNION ALL
      SELECT n.membership_id, n.next_membership_id, w.depth + 1, w.path || n.membership_id
      FROM old_walk w
      JOIN evidence_set_membership_order_versions n
        ON n.project_id = revision_row.project_id AND n.evidence_set_id = revision_row.evidence_set_id
       AND n.membership_id = w.next_membership_id
       AND n.valid_from_ordinal <= previous_row.set_ordinal
       AND (n.valid_to_ordinal IS NULL OR previous_row.set_ordinal < n.valid_to_ordinal)
      WHERE w.next_membership_id IS NOT NULL AND NOT w.next_membership_id = ANY(w.path)
    ), new_walk(membership_id, next_membership_id, depth, path) AS (
      SELECT v.membership_id, v.next_membership_id, 1, ARRAY[v.membership_id]::uuid[]
      FROM evidence_set_membership_order_versions v
      WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
        AND v.membership_id = revision_row.head_membership_id
        AND v.valid_from_ordinal <= revision_row.set_ordinal
        AND (v.valid_to_ordinal IS NULL OR revision_row.set_ordinal < v.valid_to_ordinal)
      UNION ALL
      SELECT n.membership_id, n.next_membership_id, w.depth + 1, w.path || n.membership_id
      FROM new_walk w
      JOIN evidence_set_membership_order_versions n
        ON n.project_id = revision_row.project_id AND n.evidence_set_id = revision_row.evidence_set_id
       AND n.membership_id = w.next_membership_id
       AND n.valid_from_ordinal <= revision_row.set_ordinal
       AND (n.valid_to_ordinal IS NULL OR revision_row.set_ordinal < n.valid_to_ordinal)
      WHERE w.next_membership_id IS NOT NULL AND NOT w.next_membership_id = ANY(w.path)
    )
    SELECT (SELECT array_agg(w.membership_id ORDER BY w.depth) FROM old_walk w),
           (SELECT array_agg(w.membership_id ORDER BY w.depth) FROM new_walk w),
           (SELECT array_agg(w.membership_id ORDER BY w.membership_id) FROM old_walk w),
           (SELECT array_agg(w.membership_id ORDER BY w.membership_id) FROM new_walk w)
      INTO old_order, new_order, old_sorted, new_sorted;
    IF cardinality(old_order) IS DISTINCT FROM previous_row.member_count
      OR cardinality(new_order) IS DISTINCT FROM revision_row.member_count
      OR old_sorted IS DISTINCT FROM new_sorted
      OR old_order IS NOT DISTINCT FROM new_order THEN
      RAISE EXCEPTION 'reordered Evidence Set transition must preserve its exact active set and change its order' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported Evidence Set composition operation' USING ERRCODE = '23514';
  END IF;

  IF revision_row.member_count = 0 THEN
    IF revision_row.head_membership_id IS NOT NULL OR revision_row.tail_membership_id IS NOT NULL THEN
      RAISE EXCEPTION 'empty Evidence Set composition must have null head and tail' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF revision_row.head_membership_id IS NULL OR revision_row.tail_membership_id IS NULL
      OR (revision_row.member_count = 1 AND revision_row.head_membership_id IS DISTINCT FROM revision_row.tail_membership_id)
      OR (revision_row.member_count > 1 AND revision_row.head_membership_id = revision_row.tail_membership_id) THEN
      RAISE EXCEPTION 'Evidence Set composition root and count are inconsistent' USING ERRCODE = '23514';
    END IF;
    SELECT v.next_membership_id INTO head_next
    FROM evidence_set_membership_order_versions v
    WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
      AND v.membership_id = revision_row.head_membership_id
      AND v.valid_from_ordinal <= revision_row.set_ordinal
      AND (v.valid_to_ordinal IS NULL OR revision_row.set_ordinal < v.valid_to_ordinal)
    ORDER BY v.valid_from_ordinal DESC LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Evidence Set head is not active at its composition revision' USING ERRCODE = '23514';
    END IF;
    SELECT v.membership_id INTO head_predecessor
    FROM evidence_set_membership_order_versions v
    WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
      AND v.next_membership_id = revision_row.head_membership_id
      AND v.valid_from_ordinal <= revision_row.set_ordinal
      AND (v.valid_to_ordinal IS NULL OR revision_row.set_ordinal < v.valid_to_ordinal)
    ORDER BY v.valid_from_ordinal DESC LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Evidence Set head has an active predecessor' USING ERRCODE = '23514';
    END IF;
    SELECT v.next_membership_id INTO tail_next
    FROM evidence_set_membership_order_versions v
    WHERE v.project_id = revision_row.project_id AND v.evidence_set_id = revision_row.evidence_set_id
      AND v.membership_id = revision_row.tail_membership_id
      AND v.valid_from_ordinal <= revision_row.set_ordinal
      AND (v.valid_to_ordinal IS NULL OR revision_row.set_ordinal < v.valid_to_ordinal)
    ORDER BY v.valid_from_ordinal DESC LIMIT 1;
    IF NOT FOUND OR tail_next IS NOT NULL THEN
      RAISE EXCEPTION 'Evidence Set tail must be active and have no successor' USING ERRCODE = '23514';
    END IF;
    IF revision_row.member_count = 1 AND head_next IS NOT NULL THEN
      RAISE EXCEPTION 'one-member Evidence Set composition must have a terminal head and tail' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint

DROP TRIGGER evidence_set_composition_member_transition_validation ON evidence_set_composition_members;--> statement-breakpoint
DROP TRIGGER evidence_set_composition_revision_transition_validation ON evidence_set_composition_revisions;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER evidence_set_composition_revision_transition_validation
AFTER INSERT ON evidence_set_composition_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_evidence_set_composition_revision();--> statement-breakpoint

CREATE OR REPLACE FUNCTION require_evidence_set_initial_snapshot() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  created_revision record;
BEGIN
  SELECT r.id, r.set_ordinal, r.member_count, r.distinct_paper_count,
         r.head_membership_id, r.tail_membership_id
    INTO created_revision
    FROM evidence_set_composition_revisions r
   WHERE r.project_id = NEW.project_id AND r.evidence_set_id = NEW.id
     AND r.operation_kind = 'created'
   ORDER BY r.set_ordinal
   LIMIT 1;
  IF NOT FOUND OR created_revision.set_ordinal <> 1 OR created_revision.member_count <> 0
    OR created_revision.distinct_paper_count <> 0 OR created_revision.head_membership_id IS NOT NULL
    OR created_revision.tail_membership_id IS NOT NULL THEN
    RAISE EXCEPTION 'Every Evidence Set requires one initial empty composition revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint

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

  SELECT r.project_id, r.field_id, r.finalized_at
    INTO rev_project_id, rev_field_id, rev_finalized_at
    FROM extraction_value_revisions r
    JOIN extraction_values v
      ON v.project_id = r.project_id AND v.id = r.extraction_value_id AND v.field_id = r.field_id
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

  SELECT EXISTS (
    SELECT 1
    FROM evidence_set_composition_revisions pinned
    JOIN evidence_set_membership_order_versions ov
      ON ov.project_id = pinned.project_id AND ov.evidence_set_id = pinned.evidence_set_id
     AND ov.valid_from_ordinal <= pinned.set_ordinal
     AND (ov.valid_to_ordinal IS NULL OR pinned.set_ordinal < ov.valid_to_ordinal)
    JOIN evidence_set_memberships m
      ON m.project_id = ov.project_id AND m.evidence_set_id = ov.evidence_set_id AND m.id = ov.membership_id
    JOIN evidence e ON e.project_id = m.project_id AND e.id = m.evidence_id
    JOIN extraction_revision_evidence ere
      ON ere.project_id = e.project_id AND ere.evidence_id = e.id
     AND ere.revision_id = NEW.extraction_revision_id
    WHERE pinned.project_id = NEW.project_id
      AND pinned.evidence_set_id = prep_evidence_set_id
      AND pinned.id = prep_composition_revision_id
  ) INTO is_reachable;
  IF NOT is_reachable THEN
    RAISE EXCEPTION 'selected extraction revision is not reachable from pinned evidence set composition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_ai_synthesis_request_manifest() RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  support_total integer;
  source_total integer;
  source_chars integer;
  source_bytes integer;
  preparation_record record;
BEGIN
  SELECT p.evidence_set_id, p.evidence_set_composition_revision_id, p.extraction_field_id,
         p.target_synthesis_statement_id, p.finalized_synthesis_revision_id
    INTO preparation_record
    FROM synthesis_preparations p
   WHERE p.project_id = NEW.project_id AND p.id = NEW.preparation_id;
  IF NOT FOUND OR preparation_record.evidence_set_id IS DISTINCT FROM NEW.evidence_set_id
     OR preparation_record.extraction_field_id IS DISTINCT FROM NEW.extraction_field_id
     OR preparation_record.evidence_set_composition_revision_id IS DISTINCT FROM NEW.evidence_set_composition_revision_id
     OR preparation_record.target_synthesis_statement_id IS DISTINCT FROM NEW.target_synthesis_statement_id
     OR preparation_record.finalized_synthesis_revision_id IS NOT NULL THEN
    RAISE EXCEPTION 'AI synthesis request preparation snapshot is inconsistent' USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer INTO support_total
    FROM ai_synthesis_request_supports s
   WHERE s.project_id = NEW.project_id AND s.request_id = NEW.id;
  IF support_total IS DISTINCT FROM NEW.support_count OR support_total < 1 OR support_total > 20 THEN
    RAISE EXCEPTION 'AI synthesis request support manifest is incomplete' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM synthesis_preparation_selections s
     WHERE s.project_id = NEW.project_id AND s.preparation_id = NEW.preparation_id
       AND NOT EXISTS (SELECT 1 FROM ai_synthesis_request_supports r WHERE r.project_id = s.project_id AND r.request_id = NEW.id AND r.extraction_revision_id = s.extraction_revision_id)
  ) OR EXISTS (
    SELECT 1 FROM ai_synthesis_request_supports r
     WHERE r.project_id = NEW.project_id AND r.request_id = NEW.id
       AND NOT EXISTS (SELECT 1 FROM synthesis_preparation_selections s WHERE s.project_id = r.project_id AND s.preparation_id = NEW.preparation_id AND s.extraction_revision_id = r.extraction_revision_id)
  ) THEN
    RAISE EXCEPTION 'AI synthesis request supports must equal preparation selections' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM ai_synthesis_request_supports s
     WHERE s.project_id = NEW.project_id AND s.request_id = NEW.id
       AND (s.extraction_field_id IS DISTINCT FROM NEW.extraction_field_id OR s.field_type <> NEW.field_type)
  ) THEN
    RAISE EXCEPTION 'AI synthesis request support field snapshot is inconsistent' USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer, coalesce(sum(char_length(source_text)), 0)::integer,
         coalesce(sum(source_byte_size), 0)::integer
    INTO source_total, source_chars, source_bytes
    FROM ai_synthesis_request_sources s
   WHERE s.project_id = NEW.project_id AND s.request_id = NEW.id;
  IF source_total IS DISTINCT FROM NEW.source_count OR source_total < 1 OR source_total > 80
     OR source_chars IS DISTINCT FROM NEW.source_character_count
     OR source_bytes IS DISTINCT FROM NEW.source_byte_size THEN
    RAISE EXCEPTION 'AI synthesis request source manifest is incomplete' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM ai_synthesis_request_supports s
     WHERE s.project_id = NEW.project_id AND s.request_id = NEW.id
       AND NOT EXISTS (
         SELECT 1 FROM ai_synthesis_request_sources x
         WHERE x.project_id = s.project_id AND x.request_id = s.request_id
           AND x.extraction_revision_id = s.extraction_revision_id
       )
  ) THEN
    RAISE EXCEPTION 'Every AI synthesis support must include connecting Evidence context' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM ai_synthesis_request_sources s
    WHERE s.project_id = NEW.project_id AND s.request_id = NEW.id
    GROUP BY s.extraction_revision_id HAVING count(*) > 8
  ) OR EXISTS (
    SELECT 1 FROM ai_synthesis_request_sources s
    WHERE s.project_id = NEW.project_id AND s.request_id = NEW.id
      AND NOT EXISTS (
        SELECT 1 FROM extraction_revision_evidence re
        WHERE re.project_id = s.project_id AND re.revision_id = s.extraction_revision_id
          AND re.evidence_id = s.evidence_id
      )
  ) THEN
    RAISE EXCEPTION 'AI synthesis request source is not a connecting Evidence item' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM ai_synthesis_request_sources s
    WHERE s.project_id = NEW.project_id AND s.request_id = NEW.id
      AND NOT EXISTS (
        SELECT 1
        FROM evidence_set_composition_revisions pinned
        JOIN evidence_set_membership_order_versions ov
          ON ov.project_id = pinned.project_id AND ov.evidence_set_id = pinned.evidence_set_id
         AND ov.membership_id = s.membership_id
         AND ov.valid_from_ordinal <= pinned.set_ordinal
         AND (ov.valid_to_ordinal IS NULL OR pinned.set_ordinal < ov.valid_to_ordinal)
        JOIN evidence_set_memberships m
          ON m.project_id = ov.project_id AND m.evidence_set_id = ov.evidence_set_id
         AND m.id = ov.membership_id
        WHERE pinned.project_id = NEW.project_id AND pinned.evidence_set_id = NEW.evidence_set_id
          AND pinned.id = NEW.evidence_set_composition_revision_id
          AND m.id = s.membership_id AND m.evidence_id = s.evidence_id
      )
  ) THEN
    RAISE EXCEPTION 'AI synthesis request source is outside the pinned composition' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM ai_synthesis_request_sources s
    JOIN evidence e ON e.project_id = s.project_id AND e.paper_id = s.paper_id AND e.id = s.evidence_id
    WHERE s.project_id = NEW.project_id AND s.request_id = NEW.id
      AND (
        s.page_number IS DISTINCT FROM e.page_number
        OR s.source_text IS DISTINCT FROM e.source_text
        OR s.source_text_sha256 IS DISTINCT FROM encode(sha256(convert_to(e.source_text, 'UTF8')), 'hex')
        OR s.source_character_count IS DISTINCT FROM char_length(e.source_text)
        OR s.source_byte_size IS DISTINCT FROM octet_length(e.source_text)
        OR s.evidence_note_snapshot IS DISTINCT FROM e.note
        OR s.evidence_review_state IS DISTINCT FROM coalesce((
          SELECT d.decision FROM evidence_review_decisions d
          WHERE d.project_id = e.project_id AND d.evidence_id = e.id
          ORDER BY d.sequence DESC LIMIT 1
        ), 'unreviewed')
      )
  ) THEN
    RAISE EXCEPTION 'AI synthesis request source manifest must describe the exact frozen Evidence context' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint

DO $migration_assertions$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT r.project_id, r.evidence_set_id, r.id, r.operation_kind, r.previous_revision_id,
        r.set_ordinal,
        lag(r.id) OVER (PARTITION BY r.project_id, r.evidence_set_id ORDER BY r.set_ordinal) AS expected_previous_id,
        lag(r.set_ordinal) OVER (PARTITION BY r.project_id, r.evidence_set_id ORDER BY r.set_ordinal) AS previous_ordinal
      FROM evidence_set_composition_revisions r
    ) chain
    WHERE (chain.set_ordinal = 1 AND (chain.operation_kind <> 'created' OR chain.expected_previous_id IS NOT NULL))
       OR (chain.set_ordinal > 1 AND (chain.operation_kind = 'created'
         OR chain.previous_ordinal + 1 <> chain.set_ordinal
         OR chain.previous_revision_id IS DISTINCT FROM chain.expected_previous_id))
  ) THEN
    RAISE EXCEPTION 'Evidence Set revision chain backfill is not linear' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT v.project_id, v.evidence_set_id, v.membership_id,
        v.valid_from_ordinal, v.valid_to_ordinal,
        lag(v.valid_to_ordinal) OVER (
          PARTITION BY v.project_id, v.evidence_set_id, v.membership_id
          ORDER BY v.valid_from_ordinal
        ) AS previous_valid_to,
        row_number() OVER (
          PARTITION BY v.project_id, v.evidence_set_id, v.membership_id
          ORDER BY v.valid_from_ordinal
        ) AS interval_number
      FROM evidence_set_membership_order_versions v
    ) intervals
    WHERE intervals.interval_number > 1
      AND (intervals.previous_valid_to IS NULL
        OR intervals.previous_valid_to > intervals.valid_from_ordinal)
  ) THEN
    RAISE EXCEPTION 'Evidence Set temporal backfill contains overlapping membership intervals' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM evidence_set_composition_revisions r
    JOIN evidence_set_composition_members cm
      ON cm.project_id = r.project_id AND cm.evidence_set_id = r.evidence_set_id
     AND cm.composition_revision_id = r.id
    JOIN evidence_set_memberships m
      ON m.project_id = cm.project_id AND m.evidence_set_id = cm.evidence_set_id
     AND m.id = cm.membership_id
    JOIN evidence e ON e.project_id = m.project_id AND e.id = m.evidence_id
    GROUP BY r.project_id, r.evidence_set_id, r.id, r.distinct_paper_count
    HAVING count(DISTINCT e.paper_id)::integer <> r.distinct_paper_count
  ) THEN
    RAISE EXCEPTION 'Evidence Set historical distinct Paper count backfill failed' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH latest AS (
      SELECT DISTINCT ON (r.project_id, r.evidence_set_id)
        r.project_id, r.evidence_set_id, r.id, r.distinct_paper_count
      FROM evidence_set_composition_revisions r
      ORDER BY r.project_id, r.evidence_set_id, r.set_ordinal DESC
    ), expected AS (
      SELECT latest.project_id, latest.evidence_set_id, e.paper_id, count(*)::integer AS member_count
      FROM latest
      JOIN evidence_set_composition_members cm
        ON cm.project_id = latest.project_id AND cm.evidence_set_id = latest.evidence_set_id
       AND cm.composition_revision_id = latest.id
      JOIN evidence_set_memberships m
        ON m.project_id = cm.project_id AND m.evidence_set_id = cm.evidence_set_id
       AND m.id = cm.membership_id
      JOIN evidence e ON e.project_id = m.project_id AND e.id = m.evidence_id
      GROUP BY latest.project_id, latest.evidence_set_id, e.paper_id
    ), actual AS (
      SELECT project_id, evidence_set_id, paper_id, member_count
      FROM evidence_set_paper_member_counts
    )
    SELECT 1 FROM expected FULL JOIN actual USING (project_id, evidence_set_id, paper_id)
    WHERE expected.member_count IS DISTINCT FROM actual.member_count
  ) THEN
    RAISE EXCEPTION 'Evidence Set current Paper counters do not match the released current compositions' USING ERRCODE = '23514';
  END IF;
END;
$migration_assertions$;--> statement-breakpoint

DROP TABLE evidence_set_composition_members;--> statement-breakpoint
