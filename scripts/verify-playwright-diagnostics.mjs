import { spawnSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const playwrightCli = path.join(root, "node_modules", "@playwright", "test", "cli.js");
const config = path.join(root, "playwright.diagnostics.config.ts");

function findFiles(directory, predicate, files = []) {
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) findFiles(file, predicate, files);
    else if (entry.isFile() && predicate(file)) files.push(file);
  }
  return files;
}

function zipEntries(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 65_557);
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("Trace file has no ZIP central directory.");
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  let offset = buffer.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Trace ZIP central directory is unreadable.");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.push({ flags, method, compressedSize, uncompressedSize, localOffset, name });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(buffer, entry) {
  if ((entry.flags & 1) !== 0) throw new Error("Trace entry is encrypted.");
  if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error("Trace ZIP local entry is unreadable.");
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
  const data = entry.method === 0 ? compressed : entry.method === 8 ? inflateRawSync(compressed) : undefined;
  if (!data || data.length !== entry.uncompressedSize) throw new Error(`Trace entry cannot be decoded: ${entry.name}`);
  return data;
}

function inspectTrace(file) {
  const buffer = fs.readFileSync(file);
  const entries = zipEntries(buffer);
  const trace = entries.find((entry) => /(?:^|\/)(?:trace|test|\d+)[^/]*\.trace$/.test(entry.name));
  if (!trace) throw new Error(`Trace ZIP contains no readable trace stream: ${entries.map((entry) => entry.name).join(", ")}`);
  const content = readZipEntry(buffer, trace).toString("utf8").trim();
  const firstLine = content.split(/\r?\n/, 1)[0];
  try {
    JSON.parse(firstLine);
  } catch {
    throw new Error(`Trace stream is not readable JSON: ${trace.name}`);
  }
  return { traceName: path.basename(file), stream: trace.name, entries: entries.length };
}

function inspectPng(file) {
  const buffer = fs.readFileSync(file);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) throw new Error(`Failure screenshot is not a readable PNG: ${path.basename(file)}`);
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1) throw new Error(`Failure screenshot has invalid dimensions: ${path.basename(file)}`);
  return { screenshot: path.basename(file), width, height };
}

function main() {
  if (!fs.existsSync(playwrightCli) || !fs.existsSync(config)) throw new Error("Playwright diagnostics dependencies or configuration are missing.");
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "litreview-slice56-diagnostics-"));
  const outputDirectory = path.join(tempDirectory, "results");
  const keepArtifacts = process.env.KEEP_PLAYWRIGHT_DIAGNOSTICS === "1";
  try {
    const env = { ...process.env, PLAYWRIGHT_DIAGNOSTICS_OUTPUT_DIR: outputDirectory };
    delete env.DATABASE_URL;
    delete env.PLAYWRIGHT_ADMIN_DATABASE_URL;
    const result = spawnSync(process.execPath, [
      playwrightCli,
      "test",
      `--config=${config}`,
      "--workers=1",
      "--retries=0",
      "--reporter=list",
      `--output=${outputDirectory}`,
    ], { cwd: root, encoding: "utf8", env, windowsHide: true, timeout: 120_000 });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const intentionalFailure = output.includes("SLICE56_SYNTHETIC_FAILURE_PROBE")
      && output.includes("SLICE56_EXPECTED_VALUE")
      && output.includes("SLICE56_INTENTIONAL_FAILURE")
      && /\bRunning 1 test using 1 worker\b/.test(output)
      && /\b1 failed\b/.test(output)
      && !/\b(?:\d+ passed|\d+ skipped)\b/.test(output)
      && !/retry #\d+/i.test(output);
    if (result.error || result.signal || result.status !== 1 || !intentionalFailure) {
      throw new Error(`Synthetic Playwright failure did not match its one-failure, zero-retry contract (exit=${result.status ?? "unknown"}; signal=${result.signal ?? "none"}).\n${output}`);
    }

    const traces = findFiles(outputDirectory, (file) => file.toLowerCase().endsWith(".zip"));
    const screenshots = findFiles(outputDirectory, (file) => file.toLowerCase().endsWith(".png"));
    if (!traces.length || !screenshots.length) {
      throw new Error(`Expected both trace ZIP and failure PNG; found traces=${traces.length}, screenshots=${screenshots.length}.\n${output}`);
    }
    const inspectedTraces = traces.map(inspectTrace);
    const inspectedScreenshots = screenshots.map(inspectPng);
    console.log(`Synthetic Playwright failure observed once with zero retries (exit 1); readable traces=${JSON.stringify(inspectedTraces)}; readable failure screenshots=${JSON.stringify(inspectedScreenshots)}.`);

    if (keepArtifacts) console.log(`Diagnostic artifacts retained at ${outputDirectory}.`);
  } finally {
    if (!keepArtifacts) {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
      console.log("Synthetic diagnostic temporary files cleaned up.");
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
