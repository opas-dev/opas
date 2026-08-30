// ABOUTME: Runs the synthetic retrieval benchmark and prints its complete machine-readable report.
// ABOUTME: Marks external providers as unconfigured unless a real adapter is supplied by deployment tooling.
import {
  createSyntheticRetrievalTarget,
  syntheticRetrievalFixtureV1,
} from "@/evaluation/fixtures/synthetic-retrieval-v1";
import {
  notConfiguredRetrievalTarget,
  runRetrievalEvaluation,
} from "@/evaluation/retrieval";

async function main() {
  const report = await runRetrievalEvaluation({
    fixture: syntheticRetrievalFixtureV1,
    targets: [
      createSyntheticRetrievalTarget(syntheticRetrievalFixtureV1, "lexical"),
      createSyntheticRetrievalTarget(syntheticRetrievalFixtureV1, "hybrid"),
      notConfiguredRetrievalTarget({
        id: "workers-ai",
        label: "Workers AI embeddings",
        kind: "embedding-provider",
        reason: "No authenticated Workers AI benchmark adapter was supplied",
      }),
      notConfiguredRetrievalTarget({
        id: "openai-compatible",
        label: "OpenAI-compatible embeddings",
        kind: "embedding-provider",
        reason: "No authenticated OpenAI-compatible benchmark adapter was supplied",
      }),
      notConfiguredRetrievalTarget({
        id: "cloudflare-ai-search",
        label: "Cloudflare AI Search",
        kind: "ai-search",
        reason: "No Cloudflare AI Search staging index was supplied",
      }),
    ],
    readMemoryBytes: () => process.memoryUsage().heapUsed,
    memoryMeasurement: "Node.js heapUsed sampled between benchmark operations",
  });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

void main();
