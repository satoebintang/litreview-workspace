import { describe, expect, it } from "vitest";
import { evaluateReleaseAudit } from "../../scripts/audit-release-policy";

type FixtureFinding = {
  severity: string;
  range: string;
  via: unknown[];
  effects: string[];
  nodes: string[];
  isDirect: boolean;
};

const advisory = (
  source: number,
  packageName: string,
  ghsa: string,
  severity: string,
  range: string,
): Record<string, unknown> => ({
  source,
  name: packageName,
  dependency: packageName,
  title: "Pinned audit-policy fixture advisory",
  url: "https://github.com/advisories/" + ghsa,
  severity,
  range,
});

const FIXTURE_FINDINGS: Record<string, FixtureFinding> = {
  "@esbuild-kit/core-utils": {
    severity: "moderate",
    range: "*",
    via: ["esbuild"],
    effects: ["@esbuild-kit/esm-loader"],
    nodes: ["node_modules/@esbuild-kit/core-utils"],
    isDirect: false,
  },
  "@esbuild-kit/esm-loader": {
    severity: "moderate",
    range: "*",
    via: ["@esbuild-kit/core-utils"],
    effects: ["drizzle-kit"],
    nodes: ["node_modules/@esbuild-kit/esm-loader"],
    isDirect: false,
  },
  "@next/eslint-plugin-next": {
    severity: "high",
    range: ">=14.3.0-canary.0",
    via: ["fast-glob"],
    effects: ["eslint-config-next"],
    nodes: ["node_modules/@next/eslint-plugin-next"],
    isDirect: false,
  },
  "@vitest/mocker": {
    severity: "moderate",
    range: "2.1.0 - 4.1.10",
    via: [advisory(1193684, "@vitest/mocker", "GHSA-82fw-gwwq-j7x9", "moderate", ">=2.1.0 <4.1.11")],
    effects: ["vitest"],
    nodes: ["node_modules/@vitest/mocker"],
    isDirect: false,
  },
  braces: {
    severity: "high",
    range: "*",
    via: [advisory(1240992, "braces", "GHSA-vfj7-8cjw-p6xm", "high", "<=3.0.3")],
    effects: ["micromatch"],
    nodes: ["node_modules/braces"],
    isDirect: false,
  },
  "drizzle-kit": {
    severity: "moderate",
    range: "0.19.0 - 1.0.0-beta.1-fd8bfcc",
    via: ["@esbuild-kit/esm-loader"],
    effects: [],
    nodes: ["node_modules/drizzle-kit"],
    isDirect: true,
  },
  esbuild: {
    severity: "moderate",
    range: "<=0.24.2",
    via: [advisory(1102341, "esbuild", "GHSA-67mh-4wv8-2f99", "moderate", "<=0.24.2")],
    effects: ["@esbuild-kit/core-utils"],
    nodes: ["node_modules/@esbuild-kit/core-utils/node_modules/esbuild"],
    isDirect: false,
  },
  "eslint-config-next": {
    severity: "high",
    range: ">=14.3.0-canary.0",
    via: ["@next/eslint-plugin-next"],
    effects: [],
    nodes: ["node_modules/eslint-config-next"],
    isDirect: true,
  },
  "fast-glob": {
    severity: "high",
    range: "*",
    via: ["micromatch"],
    effects: ["@next/eslint-plugin-next"],
    nodes: ["node_modules/fast-glob"],
    isDirect: false,
  },
  micromatch: {
    severity: "high",
    range: ">=0.2.0",
    via: ["braces"],
    effects: ["fast-glob"],
    nodes: ["node_modules/micromatch"],
    isDirect: false,
  },
  tinypool: {
    severity: "critical",
    range: "<=2.1.1",
    via: [
      advisory(1241260, "tinypool", "GHSA-5gmw-xhrv-c9v3", "critical", "<=2.1.0"),
      advisory(1241261, "tinypool", "GHSA-85c8-ppgw-ccpr", "critical", "<2.1.2"),
    ],
    effects: ["vitest"],
    nodes: ["node_modules/tinypool"],
    isDirect: false,
  },
  vitest: {
    severity: "critical",
    range: "0.0.95 - 4.1.10",
    via: [
      "@vitest/mocker",
      advisory(1193683, "vitest", "GHSA-82fw-gwwq-j7x9", "moderate", ">=2.1.0 <4.1.11"),
      "tinypool",
    ],
    effects: [],
    nodes: ["node_modules/vitest"],
    isDirect: true,
  },
};

function cleanProductionAudit(): string {
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
      dependencies: { prod: 71, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 71 },
    },
  });
}

function fullAudit(): string {
  const vulnerabilities = Object.fromEntries(
    Object.entries(FIXTURE_FINDINGS).map(([name, finding]) => [name, { ...finding }]),
  );
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 5, high: 5, critical: 2, total: 12 },
      dependencies: { prod: 71, dev: 492, optional: 206, peer: 0, peerOptional: 0, total: 612 },
    },
  });
}

function lockfile(): string {
  const packages: Record<string, Record<string, unknown>> = { "": {} };
  for (const finding of Object.values(FIXTURE_FINDINGS)) {
    for (const nodePath of finding.nodes) packages[nodePath] = { version: "1.0.0", dev: true };
  }
  return JSON.stringify({ lockfileVersion: 3, packages });
}

function input(overrides: Partial<Parameters<typeof evaluateReleaseAudit>[0]> = {}) {
  return {
    productionAudit: { exitCode: 0, stdout: cleanProductionAudit() },
    fullAudit: { exitCode: 1, stdout: fullAudit() },
    lockfileText: lockfile(),
    today: "2027-01-06",
    ...overrides,
  };
}

function parseFullAudit(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

describe("release audit policy", () => {
  it("accepts only the five authorized development-tooling GHSAs and pinned package paths", () => {
    const result = evaluateReleaseAudit(input());

    expect(result.accepted).toBe(true);
    expect(result.authorizedGhsas).toEqual([
      "GHSA-5gmw-xhrv-c9v3",
      "GHSA-67mh-4wv8-2f99",
      "GHSA-82fw-gwwq-j7x9",
      "GHSA-85c8-ppgw-ccpr",
      "GHSA-vfj7-8cjw-p6xm",
    ]);
    expect(result.vulnerablePackageCount).toBe(12);
    expect(result.fullAuditExitCode).toBe(1);
  });

  it("rejects an unapproved GHSA", () => {
    const report = parseFullAudit(fullAudit()) as {
      vulnerabilities: Record<string, { via: Array<Record<string, unknown>> }>;
    };
    const bracesAdvisory = report.vulnerabilities.braces.via[0];
    bracesAdvisory.url = "https://github.com/advisories/GHSA-new0-new0-new0";

    const result = evaluateReleaseAudit(input({ fullAudit: { exitCode: 1, stdout: JSON.stringify(report) } }));

    expect(result.accepted).toBe(false);
    expect(result.errors.join("\n")).toContain("Full audit GHSA set changed.");
  });

  it("rejects every production finding", () => {
    const report = parseFullAudit(cleanProductionAudit()) as {
      metadata: { vulnerabilities: Record<string, number> };
      vulnerabilities: Record<string, unknown>;
    };
    report.metadata.vulnerabilities = { info: 0, low: 0, moderate: 1, high: 0, critical: 0, total: 1 };
    report.vulnerabilities.next = {
      severity: "moderate",
      range: "15.0.0 - 15.5.26",
      via: [advisory(1000000, "next", "GHSA-new0-new0-new0", "moderate", "<15.5.27")],
      effects: [],
      nodes: ["node_modules/next"],
      isDirect: true,
    };

    const result = evaluateReleaseAudit(input({
      productionAudit: { exitCode: 1, stdout: JSON.stringify(report) },
    }));

    expect(result.accepted).toBe(false);
    expect(result.errors.join("\n")).toContain("production exceptions are not authorized");
  });

  it("rejects a changed advisory package path even when the new path is a development dependency", () => {
    const report = parseFullAudit(fullAudit()) as {
      vulnerabilities: Record<string, { nodes: string[] }>;
    };
    report.vulnerabilities.esbuild.nodes = ["node_modules/esbuild"];
    const packages = (JSON.parse(lockfile()) as { packages: Record<string, unknown> }).packages;
    packages["node_modules/esbuild"] = { version: "0.18.20", dev: true };

    const result = evaluateReleaseAudit(input({
      fullAudit: { exitCode: 1, stdout: JSON.stringify(report) },
      lockfileText: JSON.stringify({ lockfileVersion: 3, packages }),
    }));

    expect(result.accepted).toBe(false);
    expect(result.errors.join("\n")).toContain("esbuild installed package paths changed");
  });

  it("fails closed when npm audit output is malformed", () => {
    const result = evaluateReleaseAudit(input({
      fullAudit: { exitCode: 1, stdout: "{not-json" },
    }));

    expect(result.accepted).toBe(false);
    expect(result.errors.join("\n")).toContain("Full npm audit is malformed JSON.");
  });

  it("rejects exceptions after the expiry date", () => {
    const result = evaluateReleaseAudit(input({ today: "2027-01-07" }));

    expect(result.accepted).toBe(false);
    expect(result.errors.join("\n")).toContain("GHSA-5gmw-xhrv-c9v3 expired on 2027-01-06.");
  });
});
