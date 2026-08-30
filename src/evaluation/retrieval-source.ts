// ABOUTME: Maps one frozen evaluation fixture into the production evidence-retrieval source contract.
// ABOUTME: Lets deterministic and real provider vectors exercise the same Orama indexing path.
import type {
  ActiveChunkEmbedding,
  EvidenceChunkRecord,
} from "@/db/repository";
import type { RetrievalEvaluationFixture } from "@/evaluation/retrieval";
import type {
  EvidenceCandidateIdentity,
  EvidenceRetrievalSource,
} from "@/search/evidence";

export type EvaluationEmbeddingSet = Readonly<{
  configurationHash: string;
  model: string;
  provider: string;
  vectors: readonly (readonly number[])[];
}>;

const evaluationEmbeddingGenerationId = "evaluation-embedding-generation";

function evidenceRecords(fixture: RetrievalEvaluationFixture) {
  return fixture.sources.map(
    (source, ordinal): EvidenceChunkRecord => ({
      id: source.id,
      workspaceId: fixture.workspaceId,
      articleId: source.articleId,
      articleContentHash: source.contentHash,
      contentHash: source.contentHash,
      embeddingInputHash: source.contentHash,
      indexGeneration: 1,
      ordinal,
      title: source.title,
      headingPath: [source.title],
      canonicalUrl: source.canonicalUrl,
      markdown: `## ${source.title}\n\n${source.evidenceText}`,
      evidenceText: source.evidenceText,
      embeddingText: `${source.title}\n\n${source.evidenceText}`,
      sourceLineRange: { start: 1, end: 3 },
      publicationState: "published",
      createdAt: fixture.createdAt,
      updatedAt: fixture.createdAt,
    }),
  );
}

function embeddingRecords(
  fixture: RetrievalEvaluationFixture,
  embeddings: EvaluationEmbeddingSet,
) {
  if (embeddings.vectors.length !== fixture.sources.length) {
    throw new Error("Evaluation embedding count does not match the source fixture");
  }
  const dimension = embeddings.vectors[0]?.length ?? 0;
  if (
    dimension < 1 ||
    embeddings.vectors.some(
      (vector) =>
        vector.length !== dimension ||
        vector.some((value) => !Number.isFinite(value)),
    )
  ) {
    throw new Error("Evaluation embeddings have inconsistent dimensions");
  }

  return fixture.sources.map(
    (source, index): ActiveChunkEmbedding => ({
      workspaceId: fixture.workspaceId,
      chunkId: source.id,
      articleId: source.articleId,
      contentHash: source.contentHash,
      embeddingInputHash: source.contentHash,
      embeddingGenerationId: evaluationEmbeddingGenerationId,
      provider: embeddings.provider,
      model: embeddings.model,
      dimension,
      configurationHash: embeddings.configurationHash,
      vector: embeddings.vectors[index] as readonly number[],
    }),
  );
}

function identityKey(candidate: EvidenceCandidateIdentity) {
  return JSON.stringify([
    candidate.chunkId,
    candidate.articleId,
    candidate.articleContentHash,
    candidate.contentHash,
  ]);
}

export function createEvaluationEvidenceSource(
  fixture: RetrievalEvaluationFixture,
  embeddings: EvaluationEmbeddingSet,
): EvidenceRetrievalSource {
  const chunks = evidenceRecords(fixture);
  const activeEmbeddings = embeddingRecords(fixture, embeddings);
  const identities = new Set(
    chunks.map((chunk) =>
      identityKey({
        chunkId: chunk.id,
        articleId: chunk.articleId,
        articleContentHash: chunk.articleContentHash,
        contentHash: chunk.contentHash,
      }),
    ),
  );

  return {
    async getIndexingState(workspaceId) {
      return workspaceId === fixture.workspaceId
        ? {
            workspaceId,
            generation: 1,
            activeEmbeddingGenerationId: evaluationEmbeddingGenerationId,
            updatedAt: fixture.createdAt,
          }
        : null;
    },
    async listEvidenceChunks(workspaceId) {
      return workspaceId === fixture.workspaceId ? chunks : [];
    },
    async listActiveChunkEmbeddings(workspaceId) {
      return workspaceId === fixture.workspaceId ? activeEmbeddings : [];
    },
    async revalidateEvidenceCandidates({ workspaceId, generation, candidates }) {
      if (workspaceId !== fixture.workspaceId || generation !== 1) {
        return [];
      }
      return candidates.filter((candidate) => identities.has(identityKey(candidate)));
    },
  };
}
