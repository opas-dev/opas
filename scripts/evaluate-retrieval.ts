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

async function main() {
  const fixtureName = process.argv[2] ?? "synthetic";
  const fixture =
    fixtureName === "synthetic"
      ? syntheticRetrievalFixtureV1
      : fixtureName === "crofusion"
        ? crofusionLaunchPartnerFixtureV1
        : undefined;
  if (!fixture) {
    throw new Error("Usage: pnpm evaluate:retrieval [synthetic|crofusion]");
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

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

void main();
