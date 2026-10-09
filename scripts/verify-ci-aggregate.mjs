import path from "node:path";
import { fileURLToPath } from "node:url";

const requiredLanes = ["quality", "integration", "e2e"];

export function allVerificationLanesSucceeded(results) {
  return requiredLanes.every((lane) => results[lane] === "success");
}

export function describeVerificationResults(results) {
  return requiredLanes.map((lane) => `${lane}=${results[lane] || "missing"}`).join(", ");
}

function main() {
  const results = {
    quality: process.env.QUALITY_RESULT,
    integration: process.env.INTEGRATION_RESULT,
    e2e: process.env.E2E_RESULT,
  };
  const summary = describeVerificationResults(results);
  if (!allVerificationLanesSucceeded(results)) {
    console.error(`Required verification lanes did not all succeed: ${summary}`);
    process.exitCode = 1;
    return;
  }
  console.log(`All required verification lanes succeeded: ${summary}`);
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) main();
