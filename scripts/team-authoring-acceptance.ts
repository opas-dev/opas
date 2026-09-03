// ABOUTME: Runs the frozen team-authoring acceptance scenario on one already-prepared disposable target.
// ABOUTME: Refuses maintained resources before connecting and emits one bounded secret-free JSON report.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  cloudflareCommandEnvironment,
  readCloudflareTarget,
  verifyCloudflareDatabaseTarget,
} from "./bootstrap-cloudflare";
import {
  acceptancePreviewSecret,
  parseTeamAuthoringAcceptanceCommand,
  validateCloudflareAcceptanceTarget,
  validateDatabaseAcceptanceTarget,
  type TeamAuthoringAcceptanceEnvironment,
} from "./team-authoring-acceptance-target";
import {
  openNeonAcceptanceBoundary,
  openNodePostgresAcceptanceBoundary,
} from "./team-authoring-acceptance-postgres";

import {
  runTeamAuthoringAcceptance,
  teamAuthoringAcceptanceReportVersion,
  type TeamAuthoringAcceptanceReport,
} from "@/evaluation/team-authoring-acceptance";
import { teamAuthoringStandard } from "@/evaluation/fixtures/team-authoring-standard";

const maximumReportBytes = 32_768;
const wranglerEntry = path.join(process.cwd(), "node_modules/wrangler/bin/wrangler.js");
const d1WorkerEntry = path.join(
  process.cwd(),
  "tests/fixtures/team-authoring-acceptance-d1/custom-worker.ts",
);

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("ACCEPTANCE_LOOPBACK_PORT_UNAVAILABLE");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function stopWorker(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function startD1Worker(
  configPath: string,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const port = await availablePort();
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [
      wranglerEntry,
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--config",
      configPath,
      "--log-level",
      "info",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...environment,
        CI: "1",
        WRANGLER_SEND_METRICS: "false",
      } as unknown as NodeJS.ProcessEnv,
      stdio: "pipe",
    },
  );
  child.stdout.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error("ACCEPTANCE_D1_WORKER_EXITED");
    }
    try {
      const response = await fetch(`${origin}/health`, { redirect: "manual" });
      if (response.status === 200) {
        await response.arrayBuffer();
        return { child, origin };
      }
      await response.arrayBuffer();
    } catch {
      // Wrangler needs time to bundle the repository graph and establish the remote binding.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  await stopWorker(child);
  throw new Error("ACCEPTANCE_D1_WORKER_NOT_READY");
}

function parseD1Report(value: unknown, secret: string): TeamAuthoringAcceptanceReport {
  const serialized = JSON.stringify(value);
  if (
    new TextEncoder().encode(serialized).byteLength > maximumReportBytes ||
    serialized.includes(secret) ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("ACCEPTANCE_D1_REPORT_INVALID");
  }
  const report = value as Partial<TeamAuthoringAcceptanceReport>;
  if (
    report.reportVersion !== teamAuthoringAcceptanceReportVersion ||
    (report.outcome !== "passed" && report.outcome !== "failed") ||
    report.fixture?.id !== teamAuthoringStandard.id ||
    report.fixture.contentHash !== teamAuthoringStandard.contentHash ||
    !Array.isArray(report.checks) ||
    report.checks.length > 24
  ) {
    throw new Error("ACCEPTANCE_D1_REPORT_INVALID");
  }
  return value as TeamAuthoringAcceptanceReport;
}

async function runCloudflareAcceptance(
  command: ReturnType<typeof parseTeamAuthoringAcceptanceCommand>,
  previewSecret: string,
) {
  const target = readCloudflareTarget(command.configPath ?? "");
  const checked = validateCloudflareAcceptanceTarget(command, target);
  await verifyCloudflareDatabaseTarget(target);
  const directory = mkdtempSync(path.join(tmpdir(), "opas-team-acceptance-d1-"));
  const configPath = path.join(directory, "wrangler.jsonc");
  const driverName = `${checked.workerName}-driver`;
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        $schema: path.join(process.cwd(), "node_modules/wrangler/config-schema.json"),
        account_id: target.accountId,
        compatibility_date: "2026-09-02",
        compatibility_flags: ["nodejs_compat"],
        d1_databases: [
          {
            binding: "DB",
            database_id: checked.databaseId,
            database_name: checked.databaseName,
            remote: true,
          },
        ],
        main: d1WorkerEntry,
        name: driverName,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  let worker: Awaited<ReturnType<typeof startD1Worker>> | undefined;
  try {
    worker = await startD1Worker(
      configPath,
      cloudflareCommandEnvironment(target.accountId),
    );
    const response = await fetch(`${worker.origin}/run`, {
      body: JSON.stringify({
        origin: checked.origin,
        previewSecret,
        runId: command.runId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      redirect: "manual",
    });
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > maximumReportBytes) {
      throw new Error("ACCEPTANCE_D1_REPORT_TOO_LARGE");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumReportBytes) {
      throw new Error("ACCEPTANCE_D1_REPORT_TOO_LARGE");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error("ACCEPTANCE_D1_REPORT_INVALID");
    }
    return parseD1Report(parsed, previewSecret);
  } finally {
    if (worker) await stopWorker(worker.child);
    rmSync(directory, { force: true, recursive: true });
  }
}

export async function runTeamAuthoringAcceptanceCommand(
  args: readonly string[],
  environment: TeamAuthoringAcceptanceEnvironment = process.env,
) {
  const command = parseTeamAuthoringAcceptanceCommand(args);
  const previewSecret = acceptancePreviewSecret(environment);
  if (command.target === "cloudflare") {
    return runCloudflareAcceptance(command, previewSecret);
  }
  const target = validateDatabaseAcceptanceTarget(command, environment);
  const opened = command.target === "docker"
    ? openNodePostgresAcceptanceBoundary(
        target.connectionString,
        target.databaseName,
        target.origin,
      )
    : openNeonAcceptanceBoundary(
        target.connectionString,
        target.databaseName,
        target.origin,
      );
  try {
    return await runTeamAuthoringAcceptance({
      boundary: opened.boundary,
      previewConfiguration: {
        deploymentId: new URL(target.origin).hostname,
        signingSecret: previewSecret,
      },
      target: { kind: target.kind, origin: target.origin, runId: command.runId },
    });
  } finally {
    await opened.close();
  }
}

function errorCode(error: unknown) {
  if (!(error instanceof Error) || !/^[A-Z0-9_]+(?:\n[\s\S]*)?$/u.test(error.message)) {
    return "ACCEPTANCE_COMMAND_FAILED";
  }
  return error.message.split("\n", 1)[0];
}

export async function main(
  args: readonly string[],
  environment: TeamAuthoringAcceptanceEnvironment = process.env,
) {
  try {
    const report = await runTeamAuthoringAcceptanceCommand(args, environment);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.outcome !== "passed") process.exitCode = 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        code: errorCode(error),
        outcome: "refused",
        reportVersion: teamAuthoringAcceptanceReportVersion,
      })}\n`,
    );
    process.exitCode = 1;
  }
}

const invokedModule = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;

if (import.meta.url === invokedModule) {
  void main(process.argv.slice(2));
}
