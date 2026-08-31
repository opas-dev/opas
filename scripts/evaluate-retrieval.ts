// ABOUTME: Runs a selected frozen retrieval benchmark and prints its complete machine-readable report.
// ABOUTME: Keeps synthetic controls and launch-partner evidence explicit while selecting configured providers.
import { crofusionLaunchPartnerFixtureV1 } from "@/evaluation/fixtures/crofusion-launch-partner-v1";
import { createFixtureRetrievalTarget } from "@/evaluation/fixtures/fixture-target";
import {
  syntheticRetrievalFixtureV1,
} from "@/evaluation/fixtures/synthetic-retrieval-v1";
import {
  runRetrievalEvaluation,
} from "@/evaluation/retrieval";
import { configuredProviderRetrievalTargets } from "@/evaluation/provider-targets";
import { verifyRetrievalRelease } from "@/evaluation/release-gate";

function requiredNonnegativeNumber(name: string) {
  const source = process.env[name];
  const value = source === undefined ? Number.NaN : Number(source);
  if (
    source === undefined ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(source) ||
    !Number.isFinite(value)
  ) {
    throw new Error(`${name} is required and must be a nonnegative number`);
  }
  return value;
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const release = argumentsList.includes("--release");
  const fixtureArguments = argumentsList.filter((value) => value !== "--release");
  if (fixtureArguments.length > 1) {
    throw new Error(
      "Usage: pnpm evaluate:retrieval [synthetic|crofusion] [--release]",
    );
  }
  const fixtureName = fixtureArguments[0] ?? "synthetic";
  const fixture =
    fixtureName === "synthetic"
      ? syntheticRetrievalFixtureV1
      : fixtureName === "crofusion"
        ? crofusionLaunchPartnerFixtureV1
        : undefined;
  if (!fixture) {
    throw new Error(
      "Usage: pnpm evaluate:retrieval [synthetic|crofusion] [--release]",
    );
  }
  if (release && fixtureName !== "crofusion") {
    throw new Error("Release verification requires the CROFusion launch-partner fixture");
  }
  const providerTargets = await configuredProviderRetrievalTargets(
    fixture,
  );
  const report = await runRetrievalEvaluation({
    fixture,
    targets: [
      createFixtureRetrievalTarget(fixture, "lexical"),
      createFixtureRetrievalTarget(fixture, "hybrid"),
      ...providerTargets,
    ],
    readMemoryBytes: () => process.memoryUsage().heapUsed,
    memoryMeasurement: "Node.js heapUsed sampled between benchmark operations",
  });

  const releaseGate = release
    ? verifyRetrievalRelease(report, {
        activationP95Ms: requiredNonnegativeNumber(
          "OPAS_EVALUATION_ACTIVATION_P95_MS",
        ),
        workerdPeakMemoryBytes: requiredNonnegativeNumber(
          "OPAS_EVALUATION_WORKERD_PEAK_MEMORY_BYTES",
        ),
      })
    : undefined;

  process.stdout.write(
    `${JSON.stringify(releaseGate ? { ...report, releaseGate } : report, null, 2)}\n`,
  );
}

void main();
