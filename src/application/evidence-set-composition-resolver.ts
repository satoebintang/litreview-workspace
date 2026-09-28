import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";

type SqlExecutor = Pick<Database, "execute">;
type Row = Record<string, unknown>;

export type ResolvedEvidenceSetCompositionMember = {
  membershipId: string;
  evidenceId: string;
  paperId: string;
  position: number;
};

/** Resolve one exact immutable composition revision in its persisted global order. */
export async function resolveEvidenceSetCompositionRevisionMembers(
  executor: SqlExecutor,
  projectId: string,
  evidenceSetId: string,
  compositionRevisionId: string,
): Promise<ResolvedEvidenceSetCompositionMember[]> {
  const result = await executor.execute(sql`
    with recursive selected_revision as (
      select r.id, r.project_id, r.evidence_set_id, r.set_ordinal,
        r.head_membership_id, r.tail_membership_id, r.member_count
      from evidence_set_composition_revisions r
      where r.project_id=${projectId} and r.evidence_set_id=${evidenceSetId}
        and r.id=${compositionRevisionId}
    ), walk(membership_id, next_membership_id, position) as (
      select v.membership_id, v.next_membership_id, 1
      from selected_revision r
      join evidence_set_membership_order_versions v
        on v.project_id=r.project_id and v.evidence_set_id=r.evidence_set_id
       and v.membership_id=r.head_membership_id
       and v.valid_from_ordinal <= r.set_ordinal
       and (v.valid_to_ordinal is null or r.set_ordinal < v.valid_to_ordinal)
      union all
      select next_version.membership_id, next_version.next_membership_id,
        walk.position + 1
      from walk
      join selected_revision r on true
      join evidence_set_membership_order_versions next_version
        on next_version.project_id=r.project_id and next_version.evidence_set_id=r.evidence_set_id
       and next_version.membership_id=walk.next_membership_id
       and next_version.valid_from_ordinal <= r.set_ordinal
       and (next_version.valid_to_ordinal is null or r.set_ordinal < next_version.valid_to_ordinal)
      where walk.next_membership_id is not null
        and walk.position < r.member_count
    )
    select r.id as revision_id, r.project_id, r.evidence_set_id, r.member_count,
      r.head_membership_id, r.tail_membership_id, walk.membership_id,
      walk.next_membership_id, m.evidence_id, e.paper_id, walk.position
    from selected_revision r
    left join walk on true
    left join evidence_set_memberships m
      on m.project_id=r.project_id and m.evidence_set_id=r.evidence_set_id
     and m.id=walk.membership_id
    left join evidence e on e.project_id=m.project_id and e.id=m.evidence_id
    order by walk.position
  `);
  const rows = result as Row[];
  if (!rows.length || rows[0].revision_id == null
    || String(rows[0].revision_id).toLowerCase() !== compositionRevisionId.toLowerCase()
    || String(rows[0].project_id).toLowerCase() !== projectId.toLowerCase()
    || String(rows[0].evidence_set_id).toLowerCase() !== evidenceSetId.toLowerCase()) {
    throw new Error("Evidence Set composition revision does not belong to the requested Project and Set.");
  }

  const orderedRows = rows.filter((row) => row.membership_id != null);
  const members = orderedRows.map((row, index) => {
    if (row.evidence_id == null || row.paper_id == null) {
      throw new Error("Evidence Set composition revision references a missing Evidence or Paper.");
    }
    if (Number(row.position) !== index + 1) {
      throw new Error("Evidence Set composition revision has a non-contiguous member position.");
    }
    return {
    membershipId: String(row.membership_id),
    evidenceId: String(row.evidence_id),
    paperId: String(row.paper_id),
    position: Number(row.position),
    };
  });
  const expectedCount = Number(rows[0].member_count);
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
    throw new Error("Evidence Set composition revision has an invalid member count.");
  }
  const membershipIds = new Set(members.map((member) => member.membershipId));
  const expectedTail = rows[0].tail_membership_id == null ? null : String(rows[0].tail_membership_id);
  const actualTailRow = orderedRows.at(-1);
  const actualHead = members[0]?.membershipId ?? null;
  const expectedHead = rows[0].head_membership_id == null ? null : String(rows[0].head_membership_id);
  if (members.length !== expectedCount
    || membershipIds.size !== members.length
    || actualHead !== expectedHead
    || (members.at(-1)?.membershipId ?? null) !== expectedTail
    || (actualTailRow?.next_membership_id ?? null) !== null
    || (expectedCount === 0 && (expectedHead !== null || expectedTail !== null))) {
    throw new Error("Evidence Set composition revision failed its stored root, tail, or member-count invariant.");
  }
  return members;
}
