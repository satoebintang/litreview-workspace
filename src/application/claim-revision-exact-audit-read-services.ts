import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import type {
  Claim,
  ClaimRevisionExtractionSupport,
  ClaimRevisionSynthesisSupport,
  ClaimRevisionView,
  SynthesisSupport,
  SynthesisRevisionView,
} from "@/domain/types";
import { ensureId } from "@/application/review-services/shared";

type LegacyClaimRevisionReader = (
  projectId: string,
  claimId: string,
  revisionId: string,
) => Promise<{ claim: unknown; revision: unknown }>;

type DecimalSequence<T extends { sequence: number }> = Omit<T, "sequence"> & { sequence: string };

type ExactClaimExtractionSupport = Omit<ClaimRevisionExtractionSupport, "extractionRevision"> & {
  extractionRevision: DecimalSequence<ClaimRevisionExtractionSupport["extractionRevision"]>;
};

type ExactSynthesisSupport = Omit<SynthesisSupport, "extractionRevision"> & {
  extractionRevision: DecimalSequence<SynthesisSupport["extractionRevision"]>;
};

type ExactClaimSynthesisSupport = Omit<ClaimRevisionSynthesisSupport, "synthesisRevision"> & {
  synthesisRevision: Omit<SynthesisRevisionView, "sequence" | "supports"> & {
    sequence: string;
    supports: ExactSynthesisSupport[];
  };
};

export type ClaimRevisionExactAuditRouteDto = {
  claim: Claim;
  revision: Omit<ClaimRevisionView, "sequence" | "supports"> & {
    sequence: string;
    supports: {
      evidence: ClaimRevisionView["supports"]["evidence"];
      extractionRevisions: ExactClaimExtractionSupport[];
      synthesisRevisions: ExactClaimSynthesisSupport[];
    };
  };
  isCurrentRevision: boolean;
};

type RawRow = Record<string, unknown>;

function rows(value: unknown): RawRow[] {
  return value as unknown as RawRow[];
}

function sequenceMap(value: unknown): Map<string, string> {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw new DomainError("DATABASE_CONSTRAINT", "Claim revision sequence map is invalid");
    }
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DomainError("DATABASE_CONSTRAINT", "Claim revision sequence map is missing");
  }
  return new Map(Object.entries(parsed).map(([id, sequence]) => [id, String(sequence)]));
}

function requiredSequence(values: Map<string, string>, kind: "extraction_revision" | "synthesis_revision", id: string): string {
  const sequence = values.get(`${kind}:${id.toLowerCase()}`);
  if (sequence === undefined) throw new DomainError("DATABASE_CONSTRAINT", "Exact Claim support sequence is missing");
  return sequence;
}

export function createClaimRevisionExactAuditReadServices(
  db: Database,
  getClaimRevision: LegacyClaimRevisionReader,
) {
  return {
    async getClaimRevisionForExactAudit(
      projectId: string,
      claimId: string,
      revisionId: string,
      options: { selectedCurrentRevisionId?: string } = {},
    ): Promise<ClaimRevisionExactAuditRouteDto> {
      const project = ensureId(projectId).toLowerCase();
      const claim = ensureId(claimId).toLowerCase();
      const revision = ensureId(revisionId).toLowerCase();
      const selectedCurrentRevisionId = options.selectedCurrentRevisionId === undefined
        ? null
        : ensureId(options.selectedCurrentRevisionId).toLowerCase();
      const currentRevisionCte = selectedCurrentRevisionId === null ? sql`, current_revision as (
          select current_r.id
          from scope s
          join lateral (
            select latest.id
            from claim_revisions latest
            where latest.project_id=s.project_id and latest.claim_id=s.claim_id
              and latest.finalized_at is not null
            order by latest.sequence desc
            limit 1
          ) current_r on true
        )` : sql``;
      const currentRevisionId = selectedCurrentRevisionId === null
        ? sql`(select id from current_revision)`
        : sql`${selectedCurrentRevisionId}::uuid`;
      const legacy = await getClaimRevision(project, claim, revision);
      const result = rows(await db.execute(sql`
        with scope as materialized (
          select p.id as project_id, c.id as claim_id, c.created_at as claim_created_at,
            r.id as revision_id, r.sequence::text as revision_sequence
          from projects p
          join claims c on c.project_id=p.id and c.id=${claim}::uuid
          join claim_revisions r on r.project_id=c.project_id and r.claim_id=c.id
            and r.id=${revision}::uuid and r.finalized_at is not null
          where p.id=${project}::uuid
        )${currentRevisionCte},
        sequence_values as (
          select 'extraction_revision'::text as kind, x.id, x.sequence::text as sequence
          from scope s
          join claim_revision_extraction_supports support
            on support.project_id=s.project_id and support.claim_revision_id=s.revision_id
          join extraction_value_revisions x
            on x.project_id=s.project_id and x.id=support.extraction_revision_id
          union all
          select 'synthesis_revision'::text as kind, sr.id, sr.sequence::text as sequence
          from scope s
          join claim_revision_synthesis_supports support
            on support.project_id=s.project_id and support.claim_revision_id=s.revision_id
          join synthesis_revisions sr
            on sr.project_id=s.project_id and sr.id=support.synthesis_revision_id
          union all
          select 'extraction_revision'::text as kind, x.id, x.sequence::text as sequence
          from scope s
          join claim_revision_synthesis_supports claim_support
            on claim_support.project_id=s.project_id and claim_support.claim_revision_id=s.revision_id
          join synthesis_revision_supports support
            on support.project_id=s.project_id and support.synthesis_revision_id=claim_support.synthesis_revision_id
          join extraction_value_revisions x
            on x.project_id=s.project_id and x.id=support.extraction_revision_id
        )
        select s.project_id, s.claim_id, s.claim_created_at, s.revision_id,
          s.revision_sequence,
          ${currentRevisionId} as current_revision_id,
          coalesce((select jsonb_object_agg(kind || ':' || id::text, sequence) from sequence_values), '{}'::jsonb) as sequence_map
        from scope s
        limit 1
      `));
      const row = result[0];
      if (!row) throw new DomainError("NOT_FOUND", "Claim revision was not found");
      const sequences = sequenceMap(row.sequence_map);
      const base = legacy.revision as ClaimRevisionView;
      const extractionRevisions: ExactClaimExtractionSupport[] = base.supports.extractionRevisions.map((support) => ({
        ...support,
        extractionRevision: {
          ...support.extractionRevision,
          sequence: requiredSequence(sequences, "extraction_revision", support.extractionRevisionId),
        },
      }));
      const synthesisRevisions: ExactClaimSynthesisSupport[] = base.supports.synthesisRevisions.map((support) => ({
        ...support,
        synthesisRevision: {
          ...support.synthesisRevision,
          sequence: requiredSequence(sequences, "synthesis_revision", support.synthesisRevisionId),
          supports: support.synthesisRevision.supports.map((nested) => ({
            ...nested,
            extractionRevision: {
              ...nested.extractionRevision,
              sequence: requiredSequence(sequences, "extraction_revision", nested.extractionRevisionId),
            },
          })),
        },
      }));
      const legacyClaim = legacy.claim as Claim;
      return {
        claim: {
          id: legacyClaim.id,
          projectId: legacyClaim.projectId,
          createdAt: legacyClaim.createdAt,
        },
        revision: {
          ...base,
          sequence: String(row.revision_sequence),
          supports: { ...base.supports, extractionRevisions, synthesisRevisions },
        },
        isCurrentRevision: row.current_revision_id != null && String(row.current_revision_id) === String(row.revision_id),
      };
    },
  };
}
