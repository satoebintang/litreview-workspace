import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { evaluateReleaseAudit, RELEASE_AUDIT_EXCEPTIONS } from "./audit-release-policy";

function runNpm(args: string[]) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) return { exitCode: null, stdout: "", error: "npm_execpath is unavailable; run this gate with npm." };
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    error: result.error?.message,
  };
}

const productionAudit = runNpm(["audit", "--omit=dev", "--json"]);
const fullAudit = runNpm(["audit", "--json"]);
let lockfileText = "";
try {
  lockfileText = readFileSync("package-lock.json", "utf8");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  lockfileText = "";
  process.stderr.write("Could not read package-lock.json: " + message + "\n");
}

const result = evaluateReleaseAudit({ productionAudit, fullAudit, lockfileText });
if (!result.accepted) {
  process.stderr.write("Release audit blocked:\n");
  for (const error of result.errors) process.stderr.write("- " + error + "\n");
  process.exitCode = 1;
} else {
  const exceptionIds = RELEASE_AUDIT_EXCEPTIONS.map((exception) => exception.ghsa).join(", ");
  process.stdout.write("Production npm audit is clean (exit 0; zero findings).\n");
  process.stdout.write(
    "Full npm audit remains nonzero (exit " + String(result.fullAuditExitCode) + "; "
      + result.vulnerablePackageCount + " vulnerable package paths) for exactly five approved development-tooling GHSAs: "
      + exceptionIds + ". These exceptions expire on 2027-01-06; npm audit itself is not clean.\n",
  );
}
