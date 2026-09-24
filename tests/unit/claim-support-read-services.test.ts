import { describe, expect, it } from "vitest";
import type { Database } from "@/db/client";
import { createClaimSupportReadServices, type ClaimSupportSearchKind } from "@/application/claim-support-read-services";

describe("Claim support search statement bounds", () => {
  it("uses exactly count plus page in a read-only repeatable-read transaction for each kind", async () => {
    const statements: unknown[] = [];
    const transactionConfigs: unknown[] = [];
    const fakeDatabase = {
      transaction: async (
        callback: (tx: { execute: (statement: unknown) => Promise<unknown> }) => Promise<unknown>,
        config: unknown,
      ) => {
        statements.length = 0;
        transactionConfigs.push(config);
        return callback({
          execute: async (statement: unknown) => {
            statements.push(statement);
            return statements.length === 1 ? [{ project_exists: true, total_count: "0" }] : [];
          },
        });
      },
    } as unknown as Database;
    const services = createClaimSupportReadServices(fakeDatabase);
    const projectId = "123e4567-e89b-42d3-a456-426614174000";

    for (const kind of ["evidence", "extractionRevision", "synthesisRevision"] as ClaimSupportSearchKind[]) {
      await services.searchClaimSupportOptions({ projectId, kind });
      expect(statements).toHaveLength(2);
      expect(transactionConfigs.at(-1)).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" });
    }
    expect(transactionConfigs).toHaveLength(3);
  });

  it("resolves exact carry-forward eligibility with at most one query per support kind", async () => {
    const statements: unknown[] = [];
    const transactionConfigs: unknown[] = [];
    const fakeDatabase = {
      transaction: async (
        callback: (tx: { execute: (statement: unknown) => Promise<unknown> }) => Promise<unknown>,
        config: unknown,
      ) => {
        statements.length = 0;
        transactionConfigs.push(config);
        return callback({ execute: async (statement: unknown) => { statements.push(statement); return []; } });
      },
    } as unknown as Database;
    const services = createClaimSupportReadServices(fakeDatabase);
    const ids = Array.from({ length: 1_000 }, (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);

    const resolved = await services.resolveEligibleClaimSupportIds({
      projectId: "123e4567-e89b-42d3-a456-426614174000",
      evidenceIds: ids,
      extractionRevisionIds: ids,
      synthesisRevisionIds: ids,
    });

    expect(resolved).toEqual({ evidence: [], extractionRevision: [], synthesisRevision: [] });
    expect(statements).toHaveLength(3);
    expect(transactionConfigs.at(-1)).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" });

    statements.length = 0;
    const empty = await services.resolveEligibleClaimSupportIds({
      projectId: "123e4567-e89b-42d3-a456-426614174000",
    });
    expect(empty).toEqual({ evidence: [], extractionRevision: [], synthesisRevision: [] });
    expect(statements).toHaveLength(0);
  });
});
