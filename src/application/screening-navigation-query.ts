import { sql } from "drizzle-orm";
import { DomainError } from "@/domain/errors";
import type { ScreeningPaperNavigation } from "./screening-read-services";

type Row = Record<string, unknown>;

export function screeningNavigationQuery(projectId: string, paperId: string) {
  return sql`select
      project.id as project_id,
      target.id as paper_id,
      case when target.id is null then null else (
        select count(*) + 1
        from papers before_target
        where before_target.project_id=project.id
          and (before_target.created_at, before_target.id) < (target.created_at, target.id)
      ) end as position,
      case when target.id is null then null else (
        select count(*)
        from papers project_paper
        where project_paper.project_id=project.id
      ) end as total_count,
      case when target.id is null then null else (
        select previous.id
        from papers previous
        where previous.project_id=project.id
          and (previous.created_at, previous.id) < (target.created_at, target.id)
        order by previous.created_at desc, previous.id desc
        limit 1
      ) end as previous_paper_id,
      case when target.id is null then null else (
        select following.id
        from papers following
        where following.project_id=project.id
          and (following.created_at, following.id) > (target.created_at, target.id)
        order by following.created_at asc, following.id asc
        limit 1
      ) end as next_paper_id
    from projects project
    left join papers target on target.project_id=project.id and target.id=${paperId}
    where project.id=${projectId}`;
}

function countValue(value: unknown): number {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new DomainError("DATABASE_CONSTRAINT", "Screening navigation count is invalid");
  return count;
}

export function mapScreeningPaperNavigation(navigationRow: Row | null | undefined): ScreeningPaperNavigation | null {
  if (!navigationRow?.project_id) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
  if (navigationRow.paper_id == null) return null;
  return {
    paperId: String(navigationRow.paper_id),
    position: countValue(navigationRow.position),
    totalCount: countValue(navigationRow.total_count),
    previousPaperId: navigationRow.previous_paper_id == null ? null : String(navigationRow.previous_paper_id),
    nextPaperId: navigationRow.next_paper_id == null ? null : String(navigationRow.next_paper_id),
  };
}
