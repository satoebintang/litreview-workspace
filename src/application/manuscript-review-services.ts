import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { reduceManuscriptReviewEvents, validateManuscriptReviewEventStream } from "@/domain/manuscript-review";
import { appendManuscriptReviewEventSchema, createManuscriptReviewThreadSchema } from "@/domain/validation";
import type { ManuscriptReviewEventType, ManuscriptReviewLifecycle, ManuscriptReviewTargetItemType } from "@/domain/types";

type Executor = Pick<Database, "execute">;
type Row = Record<string, unknown>;

const rows = (value: unknown) => value as unknown as Row[];
const date = (value: unknown) => value as Date;
const uuid = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new DomainError("VALIDATION_ERROR", "Identifier must be a UUID");
  }
  return value;
};
const idList = (ids: string[]) => sql.join(ids.map((id) => sql`${uuid(id)}::uuid`), sql`, `);

function inputError(message: string, details?: unknown): never {
  throw new DomainError("VALIDATION_ERROR", message, details);
}

function mapThread(row: Row) {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    manuscriptId: String(row.manuscript_id),
    sectionId: String(row.section_id),
    sectionItemId: String(row.section_item_id),
    targetItemType: String(row.target_item_type) as ManuscriptReviewTargetItemType,
    title: String(row.title),
    openingProseText: row.opening_prose_text == null ? null : String(row.opening_prose_text),
    openingClaimId: row.opening_claim_id == null ? null : String(row.opening_claim_id),
    openingClaimRevisionId: row.opening_claim_revision_id == null ? null : String(row.opening_claim_revision_id),
    createdAt: date(row.created_at),
  };
}

function mapEvent(row: Row) {
  return {
    id: String(row.id),
    sequence: Number(row.sequence),
    projectId: String(row.project_id),
    threadId: String(row.thread_id),
    eventType: String(row.event_type) as ManuscriptReviewEventType,
    body: row.body == null ? null : String(row.body),
    occurredAt: date(row.occurred_at),
  };
}

function mapRevision(row: Row | undefined, supportCounts: Map<string, number>) {
  if (!row) return null;
  const id = String(row.id ?? row.claim_revision_id);
  return {
    id,
    projectId: String(row.project_id),
    claimId: String(row.claim_id),
    sequence: Number(row.sequence),
    lifecycle: String(row.state) as "active" | "withdrawn",
    claimText: row.claim_text == null ? null : String(row.claim_text),
    researcherNote: row.researcher_note == null ? null : String(row.researcher_note),
    createdAt: date(row.created_at),
    finalizedAt: row.finalized_at == null ? null : date(row.finalized_at),
    supportCount: supportCounts.get(id) ?? 0,
  };
}

function mapPlacementEvent(row: Row) {
  return {
    id: String(row.id),
    sequence: Number(row.sequence),
    projectId: String(row.project_id),
    manuscriptId: String(row.manuscript_id),
    sectionId: String(row.section_id),
    placementId: String(row.placement_id),
    claimId: String(row.claim_id),
    eventType: String(row.event_type) as "placed" | "replaced" | "removed",
    fromClaimRevisionId: row.from_claim_revision_id == null ? null : String(row.from_claim_revision_id),
    toClaimRevisionId: row.to_claim_revision_id == null ? null : String(row.to_claim_revision_id),
    occurredAt: date(row.occurred_at),
  };
}

function parseOrError<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) inputError("Input failed validation", parsed.error.issues);
  return parsed.data;
}

export type OpenManuscriptReviewThreadInput = {
  sectionItemId: string;
  title: string;
  initialComment: string;
};

export type ManuscriptReviewProjectionOptions = {
  state?: ManuscriptReviewLifecycle;
  sectionId?: string;
  sectionItemId?: string;
};

/**
 * Slice 23 editorial review operations. Review rows are deliberately isolated
 * from manuscript formatting and research provenance services. Opening values
 * are read from the locked target inside one transaction; callers never get to
 * choose a historical snapshot.
 */
export function createManuscriptReviewServices(db: Database) {
  async function requireProject(projectId: string) {
    uuid(projectId);
    const row = rows(await db.execute(sql`select id, title from projects where id=${projectId} limit 1`))[0];
    if (!row) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
    return row;
  }

  async function requireManuscript(projectId: string, manuscriptId: string) {
    await requireProject(projectId);
    uuid(manuscriptId);
    const row = rows(await db.execute(sql`
      select id, project_id, title, is_default, citation_style, created_at, updated_at
      from manuscripts where project_id=${projectId} and id=${manuscriptId} limit 1
    `))[0];
    if (!row) throw new DomainError("CROSS_PROJECT_REFERENCE", "Manuscript does not belong to this project");
    return row;
  }

  async function loadEvents(executor: Executor, projectId: string, threadId: string) {
    return rows(await executor.execute(sql`
      select id, sequence, project_id, thread_id, event_type, body, occurred_at
      from manuscript_review_events
      where project_id=${projectId} and thread_id=${threadId}
      order by sequence
    `)).map(mapEvent);
  }

  async function readThread(executor: Executor, projectId: string, manuscriptId: string, threadId: string, lock = false) {
    const row = rows(await executor.execute(sql`
      select id, project_id, manuscript_id, section_id, section_item_id, target_item_type,
             title, opening_prose_text, opening_claim_id, opening_claim_revision_id, created_at
      from manuscript_review_threads
      where project_id=${projectId} and manuscript_id=${manuscriptId} and id=${threadId}
      ${lock ? sql`for update` : sql``}
    `))[0];
    if (!row) throw new DomainError("NOT_FOUND", "Review thread was not found");
    return mapThread(row);
  }

  async function openManuscriptReviewThread(projectId: string, manuscriptId: string, input: OpenManuscriptReviewThreadInput) {
    await requireManuscript(projectId, manuscriptId);
    uuid(input.sectionItemId);
    if (typeof input.title !== "string" || !input.title.trim()) inputError("Review title is required");
    if (typeof input.initialComment !== "string" || !input.initialComment.trim()) inputError("Opening comment is required");
    if (input.initialComment.length > 10000) inputError("Review comment is too long");

    return db.transaction(async (tx) => {
      // The initial read discovers the subtype only. Claim rows take the
      // Placement row first, which is the mandatory serialization point used
      // by released replacement/removal paths before their remaining target
      // locks. Prose rows follow the released section writer (Section,
      // ProseBlock, SectionItem). Opening values are always re-read after the
      // relevant locks, never trusted from the caller.
      const identity = rows(await tx.execute(sql`
        select item_type from manuscript_section_items
        where project_id=${projectId} and manuscript_id=${manuscriptId} and id=${input.sectionItemId}
        limit 1
      `))[0];
      if (!identity) throw new DomainError("CROSS_PROJECT_REFERENCE", "Review target SectionItem does not belong to this Manuscript");
      const targetType = String(identity.item_type) as ManuscriptReviewTargetItemType;
      let openingProseText: string | null = null;
      let openingClaimId: string | null = null;
      let openingClaimRevisionId: string | null = null;
      let sectionId: string | null = null;

      if (targetType === "claim") {
        const link = rows(await tx.execute(sql`
          select section_id, placement_id
          from manuscript_section_item_claims
          where project_id=${projectId} and manuscript_id=${manuscriptId}
            and section_item_id=${input.sectionItemId} and item_type='claim'
          limit 1
        `))[0];
        if (!link) throw new DomainError("DATABASE_CONSTRAINT", "Claim SectionItem is missing its placement subtype");
        sectionId = String(link.section_id);
        const placement = rows(await tx.execute(sql`
          select id, section_id, claim_id, claim_revision_id, removed_at
          from manuscript_claim_placements
          where project_id=${projectId} and manuscript_id=${manuscriptId}
            and section_id=${sectionId} and id=${String(link.placement_id)}
          for update
        `))[0];
        if (!placement || placement.removed_at != null) throw new DomainError("NOT_FOUND", "New review threads require an active Claim placement");
        openingClaimId = String(placement.claim_id);
        openingClaimRevisionId = String(placement.claim_revision_id);
      } else if (targetType === "prose") {
        const proseIdentity = rows(await tx.execute(sql`
          select section_id
          from manuscript_prose_blocks
          where project_id=${projectId} and manuscript_id=${manuscriptId}
            and section_item_id=${input.sectionItemId} and item_type='prose'
        `))[0];
        if (!proseIdentity) throw new DomainError("DATABASE_CONSTRAINT", "Prose SectionItem is missing its Prose subtype");
        sectionId = String(proseIdentity.section_id);
      } else {
        throw new DomainError("DATABASE_CONSTRAINT", "Unsupported SectionItem subtype");
      }

      const section = rows(await tx.execute(sql`
        select id, archived_at
        from manuscript_sections
        where project_id=${projectId} and manuscript_id=${manuscriptId} and id=${sectionId}
        for update
      `))[0];
      if (!section) throw new DomainError("CROSS_PROJECT_REFERENCE", "Review target Section does not belong to this Manuscript");
      if (section.archived_at != null) throw new DomainError("VALIDATION_ERROR", "New review threads require a non-archived Section");

      if (targetType === "prose") {
        const prose = rows(await tx.execute(sql`
          select section_id, text
          from manuscript_prose_blocks
          where project_id=${projectId} and manuscript_id=${manuscriptId}
            and section_id=${sectionId} and section_item_id=${input.sectionItemId} and item_type='prose'
          for update
        `))[0];
        if (!prose) throw new DomainError("DATABASE_CONSTRAINT", "Prose SectionItem is missing its Prose subtype");
        // Deliberately do not trim, normalize, or otherwise rewrite this text.
        openingProseText = String(prose.text);
      }

      const item = rows(await tx.execute(sql`
        select id, section_id, item_type, removed_at
        from manuscript_section_items
        where project_id=${projectId} and manuscript_id=${manuscriptId}
          and section_id=${sectionId} and id=${input.sectionItemId}
        for update
      `))[0];
      if (!item || String(item.item_type) !== targetType) throw new DomainError("CROSS_PROJECT_REFERENCE", "Review target SectionItem identity does not match");
      if (item.removed_at != null) throw new DomainError("VALIDATION_ERROR", "New review threads require an active SectionItem");

      const values = parseOrError(createManuscriptReviewThreadSchema, {
        projectId,
        manuscriptId,
        sectionId,
        sectionItemId: input.sectionItemId,
        targetItemType: targetType,
        title: input.title,
        openingProseText,
        openingClaimId,
        openingClaimRevisionId,
      });
      const threadRow = rows(await tx.execute(sql`
        insert into manuscript_review_threads
          (project_id, manuscript_id, section_id, section_item_id, target_item_type,
           title, opening_prose_text, opening_claim_id, opening_claim_revision_id)
        values
          (${values.projectId}, ${values.manuscriptId}, ${values.sectionId}, ${values.sectionItemId}, ${values.targetItemType},
           ${values.title}, ${values.openingProseText}, ${values.openingClaimId}, ${values.openingClaimRevisionId})
        returning id, project_id, manuscript_id, section_id, section_item_id, target_item_type,
                  title, opening_prose_text, opening_claim_id, opening_claim_revision_id, created_at
      `))[0];
      if (!threadRow) throw new DomainError("DATABASE_CONSTRAINT", "Review thread could not be created");
      await tx.execute(sql`
        insert into manuscript_review_events (project_id, thread_id, event_type, body)
        values (${projectId}, ${String(threadRow.id)}, 'opened', ${input.initialComment})
      `);
      return mapThread(threadRow);
    });
  }

  async function appendManuscriptReviewEvent(projectId: string, manuscriptId: string, threadId: string, eventType: ManuscriptReviewEventType, body?: string | null) {
    await requireManuscript(projectId, manuscriptId);
    uuid(threadId);
    const values = parseOrError(appendManuscriptReviewEventSchema, { threadId, eventType, body: body ?? null });
    return db.transaction(async (tx) => {
      const thread = await readThread(tx, projectId, manuscriptId, threadId, true);
      const previous = await loadEvents(tx, projectId, threadId);
      try {
        reduceManuscriptReviewEvents(previous);
        const next = {
          id: "pending",
          sequence: (previous.at(-1)?.sequence ?? 0) + 1,
          projectId,
          threadId,
          eventType: values.eventType,
          body: values.body,
          occurredAt: new Date(),
        } as const;
        reduceManuscriptReviewEvents([...previous, next]);
      } catch (error) {
        throw new DomainError("VALIDATION_ERROR", error instanceof Error ? error.message : "Invalid review event transition");
      }
      const eventRow = rows(await tx.execute(sql`
        insert into manuscript_review_events (project_id, thread_id, event_type, body)
        values (${projectId}, ${thread.id}, ${values.eventType}, ${values.body})
        returning id, sequence, project_id, thread_id, event_type, body, occurred_at
      `))[0];
      if (!eventRow) throw new DomainError("DATABASE_CONSTRAINT", "Review event could not be appended");
      const event = mapEvent(eventRow);
      const events = [...previous, event];
      const state = validateManuscriptReviewEventStream(events);
      return { thread, event, state: state.lifecycle };
    });
  }

  async function commentOnManuscriptReviewThread(projectId: string, manuscriptId: string, threadId: string, body: string) {
    return appendManuscriptReviewEvent(projectId, manuscriptId, threadId, "commented", body);
  }

  async function resolveManuscriptReviewThread(projectId: string, manuscriptId: string, threadId: string, note?: string | null) {
    return appendManuscriptReviewEvent(projectId, manuscriptId, threadId, "resolved", note);
  }

  async function reopenManuscriptReviewThread(projectId: string, manuscriptId: string, threadId: string, note?: string | null) {
    return appendManuscriptReviewEvent(projectId, manuscriptId, threadId, "reopened", note);
  }

  async function getManuscriptReviewProjection(projectId: string, manuscriptId: string, options: ManuscriptReviewProjectionOptions = {}) {
    await requireManuscript(projectId, manuscriptId);
    const sectionId = options.sectionId ? uuid(options.sectionId) : undefined;
    const sectionItemId = options.sectionItemId ? uuid(options.sectionItemId) : undefined;
    if (options.state && options.state !== "open" && options.state !== "resolved") inputError("Invalid review state filter");

    const [threadRows, eventRows, sectionRows, itemRows] = await Promise.all([
      db.execute(sql`
        select id, project_id, manuscript_id, section_id, section_item_id, target_item_type,
               title, opening_prose_text, opening_claim_id, opening_claim_revision_id, created_at
        from manuscript_review_threads
        where project_id=${projectId} and manuscript_id=${manuscriptId}
        ${sectionId ? sql`and section_id=${sectionId}` : sql``}
        ${sectionItemId ? sql`and section_item_id=${sectionItemId}` : sql``}
        order by created_at, id
      `),
      db.execute(sql`
        select e.id, e.sequence, e.project_id, e.thread_id, e.event_type, e.body, e.occurred_at
        from manuscript_review_events e
        join manuscript_review_threads t on t.project_id=e.project_id and t.id=e.thread_id
        where e.project_id=${projectId} and t.manuscript_id=${manuscriptId}
        order by e.sequence
      `),
      db.execute(sql`
        select id, title, section_type, sort_order, archived_at
        from manuscript_sections
        where project_id=${projectId} and manuscript_id=${manuscriptId}
        order by sort_order, id
      `),
      db.execute(sql`
        select i.id, i.section_id, i.item_type, i.sort_order, i.created_at, i.removed_at,
               s.title as section_title, s.archived_at as section_archived_at,
               p.text as current_prose_text,
               cp.id as placement_id, cp.claim_id, cp.claim_revision_id, cp.removed_at as placement_removed_at,
               cr.id as current_revision_id, cr.project_id as current_revision_project_id,
               cr.sequence as current_revision_sequence, cr.state as current_revision_state,
               cr.claim_text as current_revision_text, cr.researcher_note as current_revision_note,
               cr.created_at as current_revision_created_at, cr.finalized_at as current_revision_finalized_at,
               latest.id as latest_revision_id, latest.sequence as latest_revision_sequence,
               latest.state as latest_revision_state
        from manuscript_section_items i
        join manuscript_sections s on s.project_id=i.project_id and s.manuscript_id=i.manuscript_id and s.id=i.section_id
        left join manuscript_prose_blocks p on p.project_id=i.project_id and p.manuscript_id=i.manuscript_id
          and p.section_id=i.section_id and p.section_item_id=i.id and p.item_type='prose'
        left join manuscript_section_item_claims sic on sic.project_id=i.project_id and sic.manuscript_id=i.manuscript_id
          and sic.section_id=i.section_id and sic.section_item_id=i.id and sic.item_type='claim'
        left join manuscript_claim_placements cp on cp.project_id=sic.project_id and cp.manuscript_id=sic.manuscript_id
          and cp.section_id=sic.section_id and cp.id=sic.placement_id
        left join claim_revisions cr on cr.project_id=cp.project_id and cr.id=cp.claim_revision_id
        left join lateral (
          select r.id, r.sequence, r.state
          from claim_revisions r
          where r.project_id=cp.project_id and r.claim_id=cp.claim_id and r.finalized_at is not null
          order by r.sequence desc limit 1
        ) latest on true
        where i.project_id=${projectId} and i.manuscript_id=${manuscriptId}
      `),
    ]);

    const threads = rows(threadRows).map(mapThread);
    const eventsByThread = new Map<string, ReturnType<typeof mapEvent>[]>();
    for (const row of rows(eventRows)) {
      const event = mapEvent(row);
      const list = eventsByThread.get(event.threadId) ?? [];
      list.push(event);
      eventsByThread.set(event.threadId, list);
    }
    const items = rows(itemRows);
    const placementIds = [...new Set(items.flatMap((row) => row.placement_id ? [String(row.placement_id)] : []))];
    const placementEvents = placementIds.length ? rows(await db.execute(sql`
      select id, sequence, project_id, manuscript_id, section_id, placement_id, claim_id,
             event_type, from_claim_revision_id, to_claim_revision_id, occurred_at
      from manuscript_claim_placement_events
      where project_id=${projectId} and placement_id in (${idList(placementIds)})
      order by placement_id, sequence
    `)) : [];
    const placementHistory = new Map<string, ReturnType<typeof mapPlacementEvent>[]>();
    for (const row of placementEvents) {
      const event = mapPlacementEvent(row);
      const list = placementHistory.get(event.placementId) ?? [];
      list.push(event);
      placementHistory.set(event.placementId, list);
    }

    const revisionIds = [...new Set([
      ...threads.flatMap((thread) => thread.openingClaimRevisionId ? [thread.openingClaimRevisionId] : []),
      ...items.flatMap((row) => row.current_revision_id ? [String(row.current_revision_id)] : []),
    ])];
    const revisions = revisionIds.length ? rows(await db.execute(sql`
      select id, project_id, claim_id, sequence, state, claim_text, researcher_note, created_at, finalized_at
      from claim_revisions
      where project_id=${projectId} and id in (${idList(revisionIds)})
    `)) : [];
    const revisionById = new Map(revisions.map((row) => [String(row.id), row]));
    const supportCounts = new Map<string, number>();
    const citationPaperCounts = new Map<string, number>();
    if (revisionIds.length) {
      const supportRows = rows(await db.execute(sql`
        select claim_revision_id, count(*)::int as support_count
        from (
          select project_id, claim_revision_id from claim_revision_evidence_supports where project_id=${projectId} and claim_revision_id in (${idList(revisionIds)})
          union all
          select project_id, claim_revision_id from claim_revision_extraction_supports where project_id=${projectId} and claim_revision_id in (${idList(revisionIds)})
          union all
          select project_id, claim_revision_id from claim_revision_synthesis_supports where project_id=${projectId} and claim_revision_id in (${idList(revisionIds)})
        ) supports
        group by claim_revision_id
      `));
      for (const row of supportRows) supportCounts.set(String(row.claim_revision_id), Number(row.support_count));
      const citationRows = rows(await db.execute(sql`
        select claim_revision_id, count(distinct paper_id)::int as paper_count
        from (
          select s.claim_revision_id, e.paper_id
          from claim_revision_evidence_supports s
          join evidence e on e.project_id=s.project_id and e.id=s.evidence_id
          where s.project_id=${projectId} and s.claim_revision_id in (${idList(revisionIds)})
          union
          select s.claim_revision_id, e.paper_id
          from claim_revision_extraction_supports s
          join extraction_revision_evidence x on x.project_id=s.project_id and x.revision_id=s.extraction_revision_id
          join evidence e on e.project_id=x.project_id and e.id=x.evidence_id
          where s.project_id=${projectId} and s.claim_revision_id in (${idList(revisionIds)})
          union
          select s.claim_revision_id, e.paper_id
          from claim_revision_synthesis_supports s
          join synthesis_revision_supports ss on ss.project_id=s.project_id and ss.synthesis_revision_id=s.synthesis_revision_id
          join extraction_revision_evidence x on x.project_id=ss.project_id and x.revision_id=ss.extraction_revision_id
          join evidence e on e.project_id=x.project_id and e.id=x.evidence_id
          where s.project_id=${projectId} and s.claim_revision_id in (${idList(revisionIds)})
        ) candidates
        group by claim_revision_id
      `));
      for (const row of citationRows) citationPaperCounts.set(String(row.claim_revision_id), Number(row.paper_count));
    }
    const itemById = new Map(items.map((row) => [String(row.id), row]));
    const sectionById = new Map(rows(sectionRows).map((row) => [String(row.id), row]));
    const resultThreads = threads.flatMap((thread) => {
      const events = eventsByThread.get(thread.id) ?? [];
      let state: ManuscriptReviewLifecycle;
      try {
        state = reduceManuscriptReviewEvents(events).lifecycle;
      } catch (error) {
        throw new DomainError("DATABASE_CONSTRAINT", error instanceof Error ? error.message : "Invalid persisted review event stream");
      }
      if (options.state && options.state !== state) return [];
      const item = itemById.get(thread.sectionItemId);
      const section = sectionById.get(thread.sectionId);
      const targetActive = item ? item.removed_at == null : false;
      const sectionArchived = section ? section.archived_at != null : true;
      const currentProseText = item?.current_prose_text == null ? null : String(item.current_prose_text);
      const currentRevision = item?.current_revision_id ? mapRevision(revisionById.get(String(item.current_revision_id)), supportCounts) : null;
      const openingRevision = thread.openingClaimRevisionId ? mapRevision(revisionById.get(thread.openingClaimRevisionId), supportCounts) : null;
      const placementId = item?.placement_id == null ? null : String(item.placement_id);
      const target = thread.targetItemType === "prose" ? {
        itemType: "prose" as const,
        sectionId: thread.sectionId,
        sectionItemId: thread.sectionItemId,
        openingText: thread.openingProseText,
        currentText: currentProseText,
        changedSinceOpening: thread.openingProseText !== currentProseText,
        targetActive,
        sectionArchived,
      } : {
        itemType: "claim" as const,
        sectionId: thread.sectionId,
        sectionItemId: thread.sectionItemId,
        openingClaimRevision: openingRevision,
        currentClaimRevision: currentRevision,
        placementHistory: placementId ? placementHistory.get(placementId) ?? [] : [],
        placementId,
        placementRemoved: item?.placement_removed_at != null,
        targetActive,
        sectionArchived,
        currentRevisionAnnotation: currentRevision ? {
          isCurrentClaimRevision: String(item?.latest_revision_id ?? "") === currentRevision.id,
          isSuperseded: Number(item?.latest_revision_sequence ?? currentRevision.sequence) > currentRevision.sequence,
          claimLifecycle: currentRevision.lifecycle,
        } : null,
        formalSupport: {
          openingSupportCount: openingRevision?.supportCount ?? 0,
          currentSupportCount: currentRevision?.supportCount ?? 0,
          openingCitationPaperCount: openingRevision ? citationPaperCounts.get(openingRevision.id) ?? 0 : 0,
          currentCitationPaperCount: currentRevision ? citationPaperCounts.get(currentRevision.id) ?? 0 : 0,
        },
      };
      return [{ thread, state, events, target, sectionTitle: section?.title == null ? null : String(section.title) }];
    });
    const openCount = resultThreads.filter((entry) => entry.state === "open").length;
    const resolvedCount = resultThreads.filter((entry) => entry.state === "resolved").length;
    return {
      projectId,
      manuscriptId,
      threads: resultThreads,
      sections: rows(sectionRows).map((row) => ({ id: String(row.id), title: String(row.title), sectionType: String(row.section_type), sortOrder: Number(row.sort_order), archivedAt: row.archived_at == null ? null : date(row.archived_at) })),
      counts: { total: resultThreads.length, open: openCount, resolved: resolvedCount },
    };
  }

  return {
    openManuscriptReviewThread,
    appendManuscriptReviewEvent,
    commentOnManuscriptReviewThread,
    resolveManuscriptReviewThread,
    reopenManuscriptReviewThread,
    getManuscriptReviewProjection,
  };
}
