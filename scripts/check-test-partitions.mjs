import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const testsRoot = path.join(root, "tests");
const vitestCli = path.join(root, "node_modules", "vitest", "vitest.mjs");
const configPaths = {
  complete: "vitest.config.ts",
  fast: "vitest.fast.config.ts",
  integration: "vitest.integration.config.ts",
};
const expectedRootTests = [
  "tests/domain.validation.test.ts",
  "tests/manuscript-formatting.test.ts",
];

function normalized(file) {
  return file.replaceAll("\\", "/");
}

function collectTestFiles(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collectTestFiles(file, files);
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(normalized(path.relative(root, file)));
  }
  return files.sort();
}

function expectedPartition(file) {
  if (file.startsWith("tests/integration/")) return "integration";
  if (file.startsWith("tests/unit/") || file.startsWith("tests/architecture/")) return "fast";
  if (/^tests\/[^/]+\.test\.ts$/.test(file)) return "fast";
  throw new Error(`Unclassified test file: ${file}`);
}

function collectPaths(value, paths = []) {
  if (typeof value === "string") {
    const match = value.replaceAll("\\", "/").match(/(?:^|[/:])(tests\/[^\s"']+\.test\.ts)(?=$|[?#])/);
    if (match) paths.push(normalized(path.relative(root, path.resolve(root, match[1]))));
    return paths;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, paths);
    return paths;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectPaths(item, paths);
  }
  return paths;
}

function listSelectedFiles(config, reportPath) {
  const result = spawnSync(process.execPath, [
    vitestCli,
    "list",
    "--filesOnly",
    `--json=${reportPath}`,
    `--config=${config}`,
    "--no-color",
  ], { cwd: root, encoding: "utf8", windowsHide: true });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Vitest selection failed for ${config} (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }

  let output = "";
  if (fs.existsSync(reportPath)) output = fs.readFileSync(reportPath, "utf8");
  else output = result.stdout;

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`Could not parse Vitest file inventory for ${config}: ${error instanceof Error ? error.message : String(error)}\n${output}`);
  }

  const files = [...new Set(collectPaths(parsed))].sort();
  if (files.length === 0) throw new Error(`Vitest selected zero test files for ${config}`);
  return files;
}

function assertExact(actualFiles, expectedFiles, partition) {
  const actual = new Set(actualFiles);
  const expected = new Set(expectedFiles);
  const missing = [...expected].filter((file) => !actual.has(file));
  const unexpected = [...actual].filter((file) => !expected.has(file));
  if (missing.length || unexpected.length) {
    throw new Error(`${partition} partition mismatch; omitted=${missing.join(", ") || "none"}; unexpected=${unexpected.join(", ") || "none"}`);
  }
}

function validateConfigSource() {
  const complete = fs.readFileSync(path.join(root, configPaths.complete), "utf8");
  const fast = fs.readFileSync(path.join(root, configPaths.fast), "utf8");
  const integration = fs.readFileSync(path.join(root, configPaths.integration), "utf8");
  for (const required of ["tests/**/*.test.ts", "fileParallelism: false"]) {
    if (!complete.includes(required)) throw new Error(`Complete Vitest configuration is missing ${required}`);
  }
  for (const required of ["tests/unit/**/*.test.ts", "tests/architecture/**/*.test.ts", "tests/*.test.ts", "fileParallelism: false"]) {
    if (!fast.includes(required)) throw new Error(`Fast Vitest configuration is missing ${required}`);
  }
  if (/resolveDatabaseUrl|DATABASE_URL/.test(fast)) throw new Error("Fast Vitest configuration must not resolve or require DATABASE_URL");
  for (const required of ["tests/integration/**/*.test.ts", "fileParallelism: false"]) {
    if (!integration.includes(required)) throw new Error(`Integration Vitest configuration is missing ${required}`);
  }
}

function main() {
  validateConfigSource();
  const allFiles = collectTestFiles(testsRoot);
  if (allFiles.length === 0) throw new Error("Complete Vitest inventory is empty");
  const fastExpected = allFiles.filter((file) => expectedPartition(file) === "fast");
  const integrationExpected = allFiles.filter((file) => expectedPartition(file) === "integration");
  if (!fastExpected.length || !integrationExpected.length) throw new Error("Authoritative Vitest partitions must both be nonempty");

  for (const rootTest of expectedRootTests) {
    if (!allFiles.includes(rootTest)) throw new Error(`Required root-level test is missing: ${rootTest}`);
  }

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "litreview-vitest-inventory-"));
  try {
    const fastActual = listSelectedFiles(configPaths.fast, path.join(tempDirectory, "fast.json"));
    const integrationActual = listSelectedFiles(configPaths.integration, path.join(tempDirectory, "integration.json"));
    assertExact(fastActual, fastExpected, "Fast");
    assertExact(integrationActual, integrationExpected, "Integration");

    const overlap = fastActual.filter((file) => integrationActual.includes(file));
    if (overlap.length) throw new Error(`Test files belong to both partitions: ${overlap.join(", ")}`);
    const combined = new Set([...fastActual, ...integrationActual]);
    assertExact([...combined].sort(), allFiles, "Combined authoritative");

    const unitFiles = fastActual.filter((file) => file.startsWith("tests/unit/")).length;
    const architectureFiles = fastActual.filter((file) => file.startsWith("tests/architecture/")).length;
    const rootFiles = fastActual.filter((file) => /^tests\/[^/]+\.test\.ts$/.test(file)).length;
    console.log(`Vitest inventory valid: ${allFiles.length} files; fast ${fastActual.length} (unit ${unitFiles}, architecture ${architectureFiles}, root ${rootFiles}); integration ${integrationActual.length}; overlap 0; omitted 0.`);
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
