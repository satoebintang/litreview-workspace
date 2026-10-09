import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import dotenv from "dotenv";

const expectedNodeVersion = "22.13.0";
const expectedCiNpmVersion = "10.9.2";
const root = process.cwd();

export function parseMode(args) {
  let mode;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--mode") {
      if (mode || !args[index + 1]) throw new Error("Pass exactly one --mode: fast, integration, or e2e.");
      mode = args[index + 1];
      index += 1;
    } else if (argument.startsWith("--mode=")) {
      if (mode) throw new Error("Pass exactly one --mode: fast, integration, or e2e.");
      mode = argument.slice("--mode=".length);
    } else {
      throw new Error(`Unknown preflight argument: ${argument}`);
    }
  }
  if (mode !== "fast" && mode !== "integration" && mode !== "e2e") {
    throw new Error("Usage: npm run verify:preflight -- --mode fast|integration|e2e");
  }
  return mode;
}

function sameExecutable(left, right) {
  try {
    return fs.realpathSync(left).toLowerCase() === fs.realpathSync(right).toLowerCase();
  } catch {
    return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  }
}

function npmPackageVersion(cliPath) {
  let directory = path.dirname(cliPath);
  for (let depth = 0; depth < 5; depth += 1) {
    const manifestPath = path.join(directory, "package.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.name === "npm") return manifest.version;
    }
    directory = path.dirname(directory);
  }
  throw new Error("Could not identify the npm CLI package from npm_execpath.");
}

function verifyRuntimeAndDependencies() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lockText = fs.readFileSync(path.join(root, "package-lock.json"), "utf8");
  const lock = JSON.parse(lockText);
  if (manifest.engines?.node !== expectedNodeVersion || process.versions.node !== expectedNodeVersion) {
    throw new Error(`Node runtime mismatch: package requires ${expectedNodeVersion}; process is ${process.versions.node}.`);
  }
  if (lock.name !== manifest.name || lock.version !== manifest.version || lock.lockfileVersion !== 3) {
    throw new Error("package-lock.json identity or lockfile version does not match package.json.");
  }

  const child = spawnSync(process.execPath, ["-p", "JSON.stringify({execPath:process.execPath,version:process.versions.node})"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (child.error || child.status !== 0) throw new Error("Could not verify the Node runtime used by child processes.");
  const childRuntime = JSON.parse(child.stdout.trim());
  if (!sameExecutable(childRuntime.execPath, process.execPath) || childRuntime.version !== expectedNodeVersion) {
    throw new Error("Child-process Node runtime differs from the preflight process runtime.");
  }

  const npmCli = process.env.npm_execpath;
  const npmNode = process.env.npm_node_execpath;
  if (!npmCli || !fs.existsSync(npmCli) || !npmNode || !sameExecutable(npmNode, process.execPath)) {
    throw new Error("npm executable identity is unavailable or npm uses a different Node runtime; invoke this through npm run.");
  }
  const cliPackageVersion = npmPackageVersion(npmCli);
  const npmVersionResult = spawnSync(process.execPath, [npmCli, "--version"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (npmVersionResult.error || npmVersionResult.status !== 0) throw new Error("Could not execute the npm CLI identified by npm_execpath.");
  const npmVersion = npmVersionResult.stdout.trim();
  if (npmVersion !== cliPackageVersion) throw new Error("npm CLI version output does not match its installed package metadata.");
  if (process.env.GITHUB_ACTIONS === "true" && npmVersion !== expectedCiNpmVersion) {
    throw new Error(`CI npm distribution mismatch: expected ${expectedCiNpmVersion}, found ${npmVersion}.`);
  }

  const rootLock = lock.packages?.[""];
  if (!rootLock) throw new Error("package-lock.json has no root package entry.");
  let installedDirect = 0;
  const directDependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const name of Object.keys(directDependencies)) {
    const lockEntry = lock.packages?.[`node_modules/${name}`];
    const installedManifestPath = path.join(root, "node_modules", name, "package.json");
    if (!lockEntry || !fs.existsSync(installedManifestPath)) throw new Error(`Direct dependency is missing from the lockfile or node_modules: ${name}`);
    const installedManifest = JSON.parse(fs.readFileSync(installedManifestPath, "utf8"));
    if (installedManifest.version !== lockEntry.version) {
      throw new Error(`Installed direct dependency does not match package-lock.json: ${name}`);
    }
    installedDirect += 1;
  }
  for (const group of ["dependencies", "devDependencies"]) {
    const locked = rootLock[group] ?? {};
    const declared = manifest[group] ?? {};
    const keys = [...new Set([...Object.keys(locked), ...Object.keys(declared)])].sort();
    if (keys.some((name) => locked[name] !== declared[name])) throw new Error(`package-lock.json root ${group} do not match package.json.`);
  }

  const pdfJsManifest = JSON.parse(fs.readFileSync(path.join(root, "node_modules", "pdfjs-dist", "package.json"), "utf8"));
  const pdfJsEntry = path.join(root, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.mjs");
  if (pdfJsManifest.version !== "6.3.289" || !fs.existsSync(pdfJsEntry)) {
    throw new Error("The established pdfjs-dist 6.3.289 legacy runtime contract is unavailable.");
  }

  console.log(`Node ${process.versions.node}; executable=${process.execPath}; child Node=${childRuntime.version}; npm ${npmVersion} (${npmCli}); direct dependencies ${installedDirect}/${Object.keys(directDependencies).length} match lockfile; lock SHA-256 ${createHash("sha256").update(lockText).digest("hex")}; pdfjs-dist ${pdfJsManifest.version} legacy entry available.`);
  if (npmVersion !== expectedCiNpmVersion) console.log(`npm distribution note: local npm ${npmVersion} differs from the CI distribution ${expectedCiNpmVersion}; npm is not formally pinned by package.json.`);
  console.log(`Environment presence: DATABASE_URL=${present(process.env.DATABASE_URL)}; PLAYWRIGHT_ADMIN_DATABASE_URL=${present(process.env.PLAYWRIGHT_ADMIN_DATABASE_URL)}; CI=${present(process.env.CI)}.`);
}

function present(value) {
  return typeof value === "string" && value.trim().length > 0 ? "present" : "absent";
}

function selectedDatabaseUrl(mode) {
  const configured = mode === "e2e" ? process.env.PLAYWRIGHT_ADMIN_DATABASE_URL : undefined;
  const value = (typeof configured === "string" && configured.trim()) ? configured : process.env.DATABASE_URL;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(mode === "integration"
      ? "DATABASE_URL must be present for integration preflight."
      : "Set PLAYWRIGHT_ADMIN_DATABASE_URL or DATABASE_URL for E2E preflight.");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("The configured database URL is invalid; its value has been withheld.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("The configured database URL must use the PostgreSQL protocol.");
  }
  return value;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function safeError(error) {
  const value = error && typeof error === "object" ? error : {};
  const name = typeof value.name === "string" ? value.name : "Error";
  const code = typeof value.code === "string" ? ` (${value.code})` : "";
  return `${name}${code}; connection details withheld`;
}

async function verifyDatabase(mode) {
  const adminUrl = selectedDatabaseUrl(mode);
  const client = postgres(adminUrl, { max: 1, connect_timeout: 10, prepare: false });
  const databaseName = `litreview_preflight_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let created = false;
  try {
    const [row] = await client`select version() as version, current_database() as database`;
    const serverMatch = String(row.version).match(/^PostgreSQL\s+(\d+)/);
    if (!serverMatch) throw new Error("Connected database is not PostgreSQL.");
    await client.unsafe(`create database ${quoteIdentifier(databaseName)}`);
    created = true;
    await client.unsafe(`drop database ${quoteIdentifier(databaseName)} with (force)`);
    created = false;
    console.log(`Database connectivity: PostgreSQL ${serverMatch[1]}; disposable database create/drop succeeded for ${mode} mode.`);
  } catch (error) {
    throw new Error(`Database prerequisites failed for ${mode} mode: ${safeError(error)}`);
  } finally {
    try {
      if (created) {
        try {
          await client.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
          console.log("Preflight cleanup: disposable database dropped.");
        } catch (error) {
          throw new Error(`Could not remove the preflight disposable database: ${safeError(error)}`);
        }
      }
    } finally {
      await client.end();
    }
  }
}

function verifyE2eState() {
  const marker = path.join(root, ".ai", "playwright-db.json");
  if (fs.existsSync(marker)) throw new Error("E2E preflight requires a clean .ai/playwright-db.json marker state.");
  const tempRoot = os.tmpdir();
  const probe = fs.mkdtempSync(path.join(tempRoot, "litreview-e2e-preflight-"));
  try {
    const file = path.join(probe, "write-check.tmp");
    fs.writeFileSync(file, "ok", { flag: "wx" });
    if (fs.readFileSync(file, "utf8") !== "ok") throw new Error("Temporary storage write/read check failed.");
    console.log("E2E state: Playwright marker is absent; temporary storage is writable and readable.");
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

function recordPreflight(mode, status, error) {
  const destination = process.env.PLAYWRIGHT_DIAGNOSTICS_FILE;
  if (!destination || mode !== "e2e") return;
  const event = {
    at: new Date().toISOString(),
    phase: "preflight",
    mode,
    status,
    ...(error ? { error: safeError(error) } : {}),
  };
  fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
  fs.appendFileSync(destination, `${JSON.stringify(event)}\n`, "utf8");
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  recordPreflight(mode, "started");
  try {
    if (mode !== "fast") dotenv.config();
    console.log(`Preflight mode: ${mode}`);
    verifyRuntimeAndDependencies();
    if (mode === "integration" || mode === "e2e") await verifyDatabase(mode);
    if (mode === "e2e") verifyE2eState();
    console.log(`Preflight passed: ${mode}.`);
    recordPreflight(mode, "succeeded");
  } catch (error) {
    recordPreflight(mode, "failed", error);
    throw error;
  }
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
