// ABOUTME: Runs the synthetic retrieval benchmark and prints its complete machine-readable report.
// ABOUTME: Marks external providers as unconfigured unless a real adapter is supplied by deployment tooling.
import {
  createSyntheticRetrievalTarget,
  syntheticRetrievalFixtureV1,
} from "@/evaluation/fixtures/synthetic-retrieval-v1";
import {
  runRetrievalEvaluation,
} from "@/evaluation/retrieval";
import { configuredProviderRetrievalTargets } from "@/evaluation/provider-targets";

async function main() {
  const providerTargets = await configuredProviderRetrievalTargets(
    syntheticRetrievalFixtureV1,
  );
  const report = await runRetrievalEvaluation({
    fixture: syntheticRetrievalFixtureV1,
    targets: [
      createSyntheticRetrievalTarget(syntheticRetrievalFixtureV1, "lexical"),
      createSyntheticRetrievalTarget(syntheticRetrievalFixtureV1, "hybrid"),
      ...providerTargets,
    ],
    readMemoryBytes: () => process.memoryUsage().heapUsed,
    memoryMeasurement: "Node.js heapUsed sampled between benchmark operations",
  });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

void main();
