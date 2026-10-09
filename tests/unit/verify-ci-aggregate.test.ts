import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const aggregateScript = path.resolve(process.cwd(), "scripts", "verify-ci-aggregate.mjs");
const laneVariables = ["QUALITY_RESULT", "INTEGRATION_RESULT", "E2E_RESULT"];

function runAggregator(results: Record<string, string | undefined>) {
  const env = { ...process.env };
  for (const variable of laneVariables) delete env[variable];
  for (const [variable, result] of Object.entries(results)) {
    if (result !== undefined) env[variable] = result;
  }
  return spawnSync(process.execPath, [aggregateScript], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    windowsHide: true,
  });
}

describe("required CI verification aggregation", () => {
  it("accepts only three conclusively successful lanes", () => {
    const result = runAggregator({ QUALITY_RESULT: "success", INTEGRATION_RESULT: "success", E2E_RESULT: "success" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("quality=success, integration=success, e2e=success");
  });

  it.each([
    ["failure", { QUALITY_RESULT: "failure", INTEGRATION_RESULT: "success", E2E_RESULT: "success" }],
    ["skipped", { QUALITY_RESULT: "success", INTEGRATION_RESULT: "skipped", E2E_RESULT: "success" }],
    ["cancelled", { QUALITY_RESULT: "success", INTEGRATION_RESULT: "success", E2E_RESULT: "cancelled" }],
    ["missing", { QUALITY_RESULT: "success", INTEGRATION_RESULT: "success" }],
  ] as const)("rejects a %s lane", (_label, results) => {
    const result = runAggregator(results);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Required verification lanes did not all succeed");
  });
});
