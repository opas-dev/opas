// ABOUTME: Enforces the fail-closed retrieval metrics required for an OPAS release candidate.
// ABOUTME: Keeps system activation and workerd memory evidence distinct from provider API timing.
import type {
  CompletedRetrievalTargetReport,
  RetrievalEvaluationReport,
} from "@/evaluation/retrieval";

export const retrievalReleaseThresholds = Object.freeze({
  activationP95Ms: 60_000,
  answerableRecallAt5: 0.9,
  averageInferenceCostUsd: 0.02,
  rebuildP95Ms: 2_000,
  warmP95Ms: 250,
  workerdPeakMemoryBytes: 96 * 1024 * 1024,
});

export type RetrievalReleaseEvidence = Readonly<{
  activationP95Ms: number;
  workerdPeakMemoryBytes: number;
}>;

export type RetrievalReleaseGate = Readonly<{
  evidence: RetrievalReleaseEvidence;
  requiredTargets: readonly string[];
  status: "passed";
  thresholds: typeof retrievalReleaseThresholds;
}>;

const requiredClassCounts = Object.freeze({
  answerable: 20,
  ambiguous: 5,
  unsupported: 10,
  "stale-conflicting": 5,
  adversarial: 10,
});
const requiredTargetIds = Object.freeze([
  "lexical",
  "orama-hybrid",
  "workers-ai",
]);

function finiteNonnegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} is missing or invalid`);
  }
}

function requireCompletedTarget(
  report: RetrievalEvaluationReport,
  id: string,
): CompletedRetrievalTargetReport {
  const target = report.targets.find((candidate) => candidate.id === id);
  if (!target || target.status !== "completed") {
    throw new Error(`Release retrieval target ${id} is not completed`);
  }
  return target;
}

function verifyClassCounts(target: CompletedRetrievalTargetReport) {
  for (const [classification, expected] of Object.entries(requiredClassCounts)) {
    const actual = target.perClass[
      classification as keyof typeof requiredClassCounts
    ].denominator;
    if (actual !== expected) {
      throw new Error(
        `Release retrieval target ${target.id} has an invalid ${classification} denominator`,
      );
    }
  }
}

function verifyTarget(target: CompletedRetrievalTargetReport) {
  verifyClassCounts(target);
  if (
    target.recallAt5.denominator !== requiredClassCounts.answerable ||
    target.recallAt5.rate < retrievalReleaseThresholds.answerableRecallAt5
  ) {
    throw new Error(`Release retrieval target ${target.id} misses recall@5`);
  }
  if (target.warmP95Ms > retrievalReleaseThresholds.warmP95Ms) {
    throw new Error(`Release retrieval target ${target.id} misses warm p95`);
  }
  if (
    target.averageEvaluatedInferenceCostUsd === null ||
    target.averageEvaluatedInferenceCostUsd >
      retrievalReleaseThresholds.averageInferenceCostUsd ||
    target.costCoverage.numerator !== target.costCoverage.denominator ||
    target.costCoverage.denominator !== 50
  ) {
    throw new Error(`Release retrieval target ${target.id} lacks bounded cost evidence`);
  }
  if (
    (target.id === "lexical" || target.id === "orama-hybrid") &&
    (target.rebuildP95Ms === null ||
      target.rebuildP95Ms > retrievalReleaseThresholds.rebuildP95Ms)
  ) {
    throw new Error(`Release retrieval target ${target.id} misses rebuild p95`);
  }
}

export function verifyRetrievalRelease(
  report: RetrievalEvaluationReport,
  evidence: RetrievalReleaseEvidence,
): RetrievalReleaseGate {
  if (
    report.fixture.provenance !== "launch-partner" ||
    report.fixture.questionCount !== 50 ||
    report.fixture.sourceCount < 1 ||
    !/^[a-f0-9]{64}$/u.test(report.fixture.sourceContentHash)
  ) {
    throw new Error("Release retrieval fixture is not a frozen launch-partner pack");
  }
  finiteNonnegative(evidence.activationP95Ms, "Embedding activation p95");
  finiteNonnegative(evidence.workerdPeakMemoryBytes, "workerd peak memory");
  if (evidence.activationP95Ms > retrievalReleaseThresholds.activationP95Ms) {
    throw new Error("Embedding activation p95 misses the release threshold");
  }
  if (
    evidence.workerdPeakMemoryBytes >
    retrievalReleaseThresholds.workerdPeakMemoryBytes
  ) {
    throw new Error("workerd peak memory misses the release threshold");
  }
  for (const id of requiredTargetIds) {
    verifyTarget(requireCompletedTarget(report, id));
  }
  return Object.freeze({
    evidence: Object.freeze({ ...evidence }),
    requiredTargets: requiredTargetIds,
    status: "passed",
    thresholds: retrievalReleaseThresholds,
  });
}
