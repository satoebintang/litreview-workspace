export const RELEASE_AUDIT_EXCEPTIONS = [
  { ghsa: "GHSA-5gmw-xhrv-c9v3", packages: ["tinypool"], expiresOn: "2027-01-06" },
  { ghsa: "GHSA-85c8-ppgw-ccpr", packages: ["tinypool"], expiresOn: "2027-01-06" },
  { ghsa: "GHSA-vfj7-8cjw-p6xm", packages: ["braces"], expiresOn: "2027-01-06" },
  { ghsa: "GHSA-67mh-4wv8-2f99", packages: ["esbuild"], expiresOn: "2027-01-06" },
  { ghsa: "GHSA-82fw-gwwq-j7x9", packages: ["@vitest/mocker", "vitest"], expiresOn: "2027-01-06" },
] as const;

type ExpectedFinding = {
  severity: string;
  range: string;
  via: string[];
  effects: string[];
  nodes: string[];
  isDirect: boolean;
};

const EXPECTED_FINDINGS: Readonly<Record<string, ExpectedFinding>> = {
  "@esbuild-kit/core-utils": {
    severity: "moderate",
    range: "*",
    via: ["package:esbuild"],
    effects: ["@esbuild-kit/esm-loader"],
    nodes: ["node_modules/@esbuild-kit/core-utils"],
    isDirect: false,
  },
  "@esbuild-kit/esm-loader": {
    severity: "moderate",
    range: "*",
    via: ["package:@esbuild-kit/core-utils"],
    effects: ["drizzle-kit"],
    nodes: ["node_modules/@esbuild-kit/esm-loader"],
    isDirect: false,
  },
  "@next/eslint-plugin-next": {
    severity: "high",
    range: ">=14.3.0-canary.0",
    via: ["package:fast-glob"],
    effects: ["eslint-config-next"],
    nodes: ["node_modules/@next/eslint-plugin-next"],
    isDirect: false,
  },
  "@vitest/mocker": {
    severity: "moderate",
    range: "2.1.0 - 4.1.10",
    via: ["ghsa:GHSA-82fw-gwwq-j7x9"],
    effects: ["vitest"],
    nodes: ["node_modules/@vitest/mocker"],
    isDirect: false,
  },
  braces: {
    severity: "high",
    range: "*",
    via: ["ghsa:GHSA-vfj7-8cjw-p6xm"],
    effects: ["micromatch"],
    nodes: ["node_modules/braces"],
    isDirect: false,
  },
  "drizzle-kit": {
    severity: "moderate",
    range: "0.19.0 - 1.0.0-beta.1-fd8bfcc",
    via: ["package:@esbuild-kit/esm-loader"],
    effects: [],
    nodes: ["node_modules/drizzle-kit"],
    isDirect: true,
  },
  esbuild: {
    severity: "moderate",
    range: "<=0.24.2",
    via: ["ghsa:GHSA-67mh-4wv8-2f99"],
    effects: ["@esbuild-kit/core-utils"],
    nodes: ["node_modules/@esbuild-kit/core-utils/node_modules/esbuild"],
    isDirect: false,
  },
  "eslint-config-next": {
    severity: "high",
    range: ">=14.3.0-canary.0",
    via: ["package:@next/eslint-plugin-next"],
    effects: [],
    nodes: ["node_modules/eslint-config-next"],
    isDirect: true,
  },
  "fast-glob": {
    severity: "high",
    range: "*",
    via: ["package:micromatch"],
    effects: ["@next/eslint-plugin-next"],
    nodes: ["node_modules/fast-glob"],
    isDirect: false,
  },
  micromatch: {
    severity: "high",
    range: ">=0.2.0",
    via: ["package:braces"],
    effects: ["fast-glob"],
    nodes: ["node_modules/micromatch"],
    isDirect: false,
  },
  tinypool: {
    severity: "critical",
    range: "<=2.1.1",
    via: ["ghsa:GHSA-5gmw-xhrv-c9v3", "ghsa:GHSA-85c8-ppgw-ccpr"],
    effects: ["vitest"],
    nodes: ["node_modules/tinypool"],
    isDirect: false,
  },
  vitest: {
    severity: "critical",
    range: "0.0.95 - 4.1.10",
    via: ["ghsa:GHSA-82fw-gwwq-j7x9", "package:@vitest/mocker", "package:tinypool"],
    effects: [],
    nodes: ["node_modules/vitest"],
    isDirect: true,
  },
};

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  error?: string;
};

export type ReleaseAuditEvaluationInput = {
  productionAudit: CommandResult;
  fullAudit: CommandResult;
  lockfileText: string;
  today?: string;
};

export type ReleaseAuditEvaluation = {
  accepted: boolean;
  errors: string[];
  authorizedGhsas: string[];
  vulnerablePackageCount: number;
  fullAuditExitCode: number | null;
};

type JsonRecord = Record<string, unknown>;

const SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseJsonRecord(value: string, label: string, errors: string[]): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      errors.push(label + " must be a JSON object.");
      return null;
    }
    return parsed;
  } catch {
    errors.push(label + " is malformed JSON.");
    return null;
  }
}

function parseAuditReport(raw: string, label: string, errors: string[]): JsonRecord | null {
  const report = parseJsonRecord(raw, label, errors);
  if (!report) return null;
  if (report.auditReportVersion !== 2) errors.push(label + " must use npm audit report version 2.");
  if ("error" in report) errors.push(label + " contains an npm error object.");
  if (!isRecord(report.metadata)) errors.push(label + " is missing metadata.");
  if (!isRecord(report.vulnerabilities)) errors.push(label + " is missing the vulnerabilities object.");
  return report;
}

function validNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateMetadata(report: JsonRecord, label: string, errors: string[]): number | null {
  if (!isRecord(report.metadata)) return null;
  const metadata = report.metadata;
  if (!isRecord(metadata.vulnerabilities)) {
    errors.push(label + " is missing vulnerability counts.");
    return null;
  }
  const counts = metadata.vulnerabilities;
  for (const severity of SEVERITIES) {
    if (!validNonNegativeInteger(counts[severity])) {
      errors.push(label + " has an invalid " + severity + " count.");
    }
  }
  if (!validNonNegativeInteger(counts.total)) {
    errors.push(label + " has an invalid total vulnerability count.");
  }
  if (!isRecord(metadata.dependencies)) {
    errors.push(label + " is missing dependency counts.");
  } else {
    for (const name of ["prod", "dev", "optional", "peer", "peerOptional", "total"]) {
      if (!validNonNegativeInteger(metadata.dependencies[name])) {
        errors.push(label + " has an invalid " + name + " dependency count.");
      }
    }
  }
  if (!isRecord(report.vulnerabilities)) return null;

  const findings = Object.values(report.vulnerabilities);
  const severityCounts: Record<(typeof SEVERITIES)[number], number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  for (const finding of findings) {
    if (!isRecord(finding) || typeof finding.severity !== "string" || !SEVERITIES.includes(finding.severity as (typeof SEVERITIES)[number])) {
      errors.push(label + " contains a malformed vulnerability record.");
      continue;
    }
    severityCounts[finding.severity as (typeof SEVERITIES)[number]] += 1;
  }
  if (validNonNegativeInteger(counts.total) && counts.total !== findings.length) {
    errors.push(label + " vulnerability count does not match its package records.");
  }
  for (const severity of SEVERITIES) {
    if (validNonNegativeInteger(counts[severity]) && counts[severity] !== severityCounts[severity]) {
      errors.push(label + " " + severity + " count does not match its package records.");
    }
  }
  return validNonNegativeInteger(counts.total) ? counts.total : null;
}

function sortedUniqueStrings(value: unknown, label: string, errors: string[], allowEmpty: boolean): string[] | null {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || !value.every(nonEmptyString)) {
    errors.push(label + " must be " + (allowEmpty ? "an array" : "a non-empty array") + " of non-empty strings.");
    return null;
  }
  const strings = value as string[];
  if (new Set(strings).size !== strings.length) errors.push(label + " contains duplicate values.");
  return [...strings].sort();
}

function normalizeVia(
  value: unknown,
  packageName: string,
  observedGhsas: Map<string, string[]>,
  errors: string[],
): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(packageName + " has no complete via paths.");
    return null;
  }
  const paths: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      if (!/^(?:@[^/\s]+\/)?[^/\s]+$/.test(entry)) {
        errors.push(packageName + " has a malformed package via path.");
        continue;
      }
      paths.push("package:" + entry);
      continue;
    }
    if (!isRecord(entry)) {
      errors.push(packageName + " has an unknown via entry.");
      continue;
    }
    const match = typeof entry.url === "string"
      ? /^https:\/\/github\.com\/advisories\/(GHSA-[A-Za-z0-9-]+)$/.exec(entry.url)
      : null;
    if (!match
      || !validNonNegativeInteger(entry.source)
      || entry.source === 0
      || entry.name !== packageName
      || entry.dependency !== packageName
      || !nonEmptyString(entry.title)
      || !nonEmptyString(entry.range)
      || !SEVERITIES.includes(entry.severity as (typeof SEVERITIES)[number])) {
      errors.push(packageName + " has an incomplete or malformed GHSA record.");
      continue;
    }
    const ghsa = match[1];
    const packages = observedGhsas.get(ghsa) ?? [];
    packages.push(packageName);
    observedGhsas.set(ghsa, packages);
    paths.push("ghsa:" + ghsa);
  }
  if (paths.length !== value.length) return null;
  if (new Set(paths).size !== paths.length) errors.push(packageName + " has duplicate via paths.");
  return paths.sort();
}

function packageNameFromNodePath(nodePath: string): string | null {
  if (!nodePath.startsWith("node_modules/") || nodePath.includes("\\") || nodePath.split("/").includes("..")) return null;
  const marker = "node_modules/";
  const markerIndex = nodePath.lastIndexOf(marker);
  const name = nodePath.slice(markerIndex + marker.length);
  return name.length > 0 && !name.startsWith("/") ? name : null;
}

function validateLockfile(lockfileText: string, errors: string[]): JsonRecord | null {
  const lockfile = parseJsonRecord(lockfileText, "package-lock.json", errors);
  if (!lockfile) return null;
  if (lockfile.lockfileVersion !== 3) errors.push("package-lock.json must use lockfile version 3.");
  if (!isRecord(lockfile.packages)) errors.push("package-lock.json is missing its packages map.");
  return lockfile;
}

function validateCurrentDay(today: string, errors: string[]): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    errors.push("The current UTC day must use YYYY-MM-DD.");
    return;
  }
  const parsed = new Date(today + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== today) {
    errors.push("The current UTC day is invalid.");
    return;
  }
  for (const exception of RELEASE_AUDIT_EXCEPTIONS) {
    if (today > exception.expiresOn) {
      errors.push("Exception " + exception.ghsa + " expired on " + exception.expiresOn + ".");
    }
  }
}

function validateFindingPaths(report: JsonRecord, lockfile: JsonRecord | null, errors: string[]): Map<string, string[]> {
  const observedGhsas = new Map<string, string[]>();
  if (!isRecord(report.vulnerabilities)) return observedGhsas;
  const findings = report.vulnerabilities;
  const names = Object.keys(findings).sort();
  const expectedNames = Object.keys(EXPECTED_FINDINGS).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    errors.push("Full audit package set changed. Expected " + expectedNames.join(", ") + "; received " + names.join(", ") + ".");
  }

  for (const [packageName, rawFinding] of Object.entries(findings)) {
    if (!isRecord(rawFinding)) {
      errors.push(packageName + " has a malformed vulnerability record.");
      continue;
    }
    const expected = EXPECTED_FINDINGS[packageName];
    const via = normalizeVia(rawFinding.via, packageName, observedGhsas, errors);
    const effects = sortedUniqueStrings(rawFinding.effects, packageName + " effects", errors, true);
    const nodes = sortedUniqueStrings(rawFinding.nodes, packageName + " nodes", errors, false);

    if (!expected) {
      errors.push("Full audit contains an unapproved vulnerable package: " + packageName + ".");
    } else {
      if (rawFinding.severity !== expected.severity) errors.push(packageName + " severity changed.");
      if (rawFinding.range !== expected.range) errors.push(packageName + " vulnerable range changed.");
      if (rawFinding.isDirect !== expected.isDirect) errors.push(packageName + " direct-dependency status changed.");
      if (via && JSON.stringify(via) !== JSON.stringify([...expected.via].sort())) errors.push(packageName + " advisory or dependency via paths changed.");
      if (effects && JSON.stringify(effects) !== JSON.stringify([...expected.effects].sort())) errors.push(packageName + " affected-package paths changed.");
      if (nodes && JSON.stringify(nodes) !== JSON.stringify([...expected.nodes].sort())) errors.push(packageName + " installed package paths changed.");
    }

    if (nodes) {
      for (const nodePath of nodes) {
        const lockPathPackage = packageNameFromNodePath(nodePath);
        if (lockPathPackage !== packageName) {
          errors.push(packageName + " node path does not identify the audited package: " + nodePath + ".");
          continue;
        }
        const lockPackages = lockfile && isRecord(lockfile.packages) ? lockfile.packages : null;
        const lockEntry = lockPackages && isRecord(lockPackages[nodePath]) ? lockPackages[nodePath] : null;
        if (!lockEntry) {
          errors.push(packageName + " node path is absent from package-lock.json: " + nodePath + ".");
        } else if (lockEntry.dev !== true) {
          errors.push(packageName + " node path is not development-only in package-lock.json: " + nodePath + ".");
        } else if (!nonEmptyString(lockEntry.version)) {
          errors.push(packageName + " lockfile node has no resolved version: " + nodePath + ".");
        }
      }
    }
  }
  return observedGhsas;
}

function validateAuthorizedGhsas(observed: Map<string, string[]>, errors: string[]): string[] {
  const expected = new Map<string, string[]>(RELEASE_AUDIT_EXCEPTIONS.map((exception) => [exception.ghsa, [...exception.packages].sort()]));
  const observedIds = [...observed.keys()].sort();
  const expectedIds = [...expected.keys()].sort();
  if (JSON.stringify(observedIds) !== JSON.stringify(expectedIds)) {
    errors.push("Full audit GHSA set changed. Expected " + expectedIds.join(", ") + "; received " + observedIds.join(", ") + ".");
  }
  for (const [ghsa, packages] of observed) {
    const expectedPackages = expected.get(ghsa);
    const actualPackages = [...packages].sort();
    if (!expectedPackages) {
      errors.push("Full audit contains an unauthorized GHSA: " + ghsa + ".");
    } else if (JSON.stringify(actualPackages) !== JSON.stringify(expectedPackages)) {
      errors.push(ghsa + " package paths changed. Expected " + expectedPackages.join(", ") + "; received " + actualPackages.join(", ") + ".");
    }
  }
  return observedIds;
}

export function evaluateReleaseAudit(input: ReleaseAuditEvaluationInput): ReleaseAuditEvaluation {
  const errors: string[] = [];
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  validateCurrentDay(today, errors);
  const lockfile = validateLockfile(input.lockfileText, errors);
  const productionReport = parseAuditReport(input.productionAudit.stdout, "Production npm audit", errors);
  const fullReport = parseAuditReport(input.fullAudit.stdout, "Full npm audit", errors);

  if (input.productionAudit.error) errors.push("Production npm audit could not run: " + input.productionAudit.error);
  if (input.productionAudit.exitCode !== 0) errors.push("Production npm audit must exit 0; received " + String(input.productionAudit.exitCode) + ".");
  if (input.fullAudit.error) errors.push("Full npm audit could not run: " + input.fullAudit.error);
  if (input.fullAudit.exitCode !== 1) errors.push("Full npm audit must remain nonzero with the approved exceptions; expected exit 1, received " + String(input.fullAudit.exitCode) + ".");

  let productionCount: number | null = null;
  if (productionReport) {
    productionCount = validateMetadata(productionReport, "Production npm audit", errors);
    if (isRecord(productionReport.vulnerabilities) && Object.keys(productionReport.vulnerabilities).length > 0) {
      errors.push("Production npm audit contains vulnerable packages; production exceptions are not authorized: " + Object.keys(productionReport.vulnerabilities).sort().join(", ") + ".");
    }
  }
  if (productionCount !== null && productionCount !== 0) errors.push("Production npm audit reports " + productionCount + " findings; production exceptions are not authorized.");

  let vulnerablePackageCount = 0;
  let authorizedGhsas: string[] = [];
  if (fullReport) {
    const fullCount = validateMetadata(fullReport, "Full npm audit", errors);
    vulnerablePackageCount = isRecord(fullReport.vulnerabilities) ? Object.keys(fullReport.vulnerabilities).length : 0;
    if (fullCount !== null && fullCount !== vulnerablePackageCount) {
      errors.push("Full npm audit total does not equal its vulnerable package count.");
    }
    authorizedGhsas = validateAuthorizedGhsas(validateFindingPaths(fullReport, lockfile, errors), errors);
  }

  return {
    accepted: errors.length === 0,
    errors,
    authorizedGhsas,
    vulnerablePackageCount,
    fullAuditExitCode: input.fullAudit.exitCode,
  };
}
