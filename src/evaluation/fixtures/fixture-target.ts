// ABOUTME: Runs any frozen retrieval fixture through the production lexical or hybrid index path.
// ABOUTME: Keeps deterministic local vectors separate from provider-backed benchmark targets.
import type {
  RetrievalEvaluationAdapter,
  RetrievalEvaluationFixture,
} from "@/evaluation/retrieval";
import { createEvaluationEvidenceSource } from "@/evaluation/retrieval-source";
import { createEvidenceRetriever } from "@/search/evidence";

export function createFixtureRetrievalTarget(
  fixture: RetrievalEvaluationFixture,
  mode: "lexical" | "hybrid",
): RetrievalEvaluationAdapter {
  const source = createEvaluationEvidenceSource(fixture, {
    configurationHash: fixture.sourceContentHash,
    model: "one-hot-v1",
    provider: "deterministic-fixture",
    vectors: fixture.sources.map(({ vector }) => vector),
  });
  let retrieve = createEvidenceRetriever(source);
  const warmupQuestion = fixture.questions.find(
    ({ classification }) => classification === "answerable",
  );

  return {
    id: mode === "lexical" ? "lexical" : "orama-hybrid",
    label: mode === "lexical" ? "Lexical" : "Orama hybrid",
    kind: mode === "lexical" ? "lexical" : "orama-hybrid",
    provider: mode === "hybrid" ? "deterministic-fixture" : null,
    model: mode === "hybrid" ? "one-hot-v1" : null,
    costBasis: "No paid inference; vectors are committed fixture data",
    async rebuild() {
      retrieve = createEvidenceRetriever(source);
      if (warmupQuestion) {
        await retrieve({
          workspaceId: fixture.workspaceId,
          query: warmupQuestion.question,
          mode,
          queryVector: mode === "hybrid" ? warmupQuestion.queryVector : undefined,
          topK: 5,
        });
      }
    },
    async retrieve({ question, topK }) {
      const results = await retrieve({
        workspaceId: fixture.workspaceId,
        query: question.question,
        mode,
        queryVector: mode === "hybrid" ? question.queryVector : undefined,
        topK,
      });
      return {
        sourceIds: results.map(({ sourceId }) => sourceId),
        inferenceCostUsd: 0,
      };
    },
  };
}
