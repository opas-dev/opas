// ABOUTME: Defines the deterministic corpus used to verify retrieval across database and workerd runtimes.
// ABOUTME: Encodes the pilot corpus boundary, lifecycle canaries, and reproducible benchmark statistics.
import type {
  ActiveChunkEmbedding,
  EvidenceChunkRecord,
  IndexingState,
} from "@/db/repository";
import { syntheticRetrievalFixtureV1 } from "@/evaluation/fixtures/synthetic-retrieval-v1";
import type {
  EvidenceCandidateIdentity,
  EvidenceRetrievalSource,
} from "@/search/evidence";

type RuntimeCanary = Readonly<{
  id: string;
  articleId: string;
  title: string;
  evidenceText: string;
  contentHash: string;
  query: string;
}>;

type RetrievalRuntimeFixtureOptions = {
  chunkCount?: number;
  embeddingDimension?: number;
};

export type RetrievalRuntimeFixture = {
  workspaceId: string;
  source: EvidenceRetrievalSource;
  vectorForSourceId(sourceId: string): readonly number[] | null;
  advance(): IndexingState;
};

export const retrievalRuntimeCorpusLimit = Object.freeze({
  chunkCount: 500,
  embeddingDimension: 768,
  maximumEvidenceTextUtf8Bytes: 384,
  maximumMarkdownUtf8Bytes: 224,
  maximumPeakRssBytes: 96 * 1_024 * 1_024,
  isolateCount: 3,
  warmSamples: 100,
  rebuildSamples: 20,
});

export const retrievalRuntimeCalibration = Object.freeze({
  workerdPackageVersion: "1.20260826.1",
  observations: Object.freeze([
    Object.freeze({
      chunkCount: 2_000,
      embeddingDimension: 768,
      scenario: "warm-index",
      peakRssBytes: 124_387_328,
      decision: "rejected-over-limit",
    }),
    Object.freeze({
      chunkCount: 750,
      embeddingDimension: 768,
      scenario: "one-cached-index-replacement",
      peakRssBytes: 99_876_864,
      decision: "rejected-insufficient-margin",
    }),
    Object.freeze({
      chunkCount: 600,
      embeddingDimension: 768,
      scenario: "one-cached-index-replacement",
      peakRssBytes: 96_239_616,
      decision: "rejected-insufficient-margin",
    }),
  ]),
  selectedChunkCount: retrievalRuntimeCorpusLimit.chunkCount,
  memoryLimitBytes: retrievalRuntimeCorpusLimit.maximumPeakRssBytes,
});

const fixtureWorkspaceId = syntheticRetrievalFixtureV1.workspaceId;
const fixtureEmbeddingGenerationId = "runtime_embedding_generation_v1";
const fixtureCreatedAt = new Date("2026-08-30T00:00:00.000Z");
const fixtureAdvancedAt = new Date("2026-08-30T00:01:00.000Z");
const minimumRuntimeChunkCount = syntheticRetrievalFixtureV1.sources.length + 3;

const updateBefore = Object.freeze({
  id: "runtime_canary_update_before",
  articleId: "runtime_article_update",
  title: "Amber cuttlefish canary",
  evidenceText:
    "ambercuttlefishcanary confirms the baseline update source.",
  contentHash:
    "f871b15ad9dae74e83a826bb2ceb8ffdff0f703fac2797a1897f2354c8d59658",
  query: "ambercuttlefishcanary",
}) satisfies RuntimeCanary;

const updateAfter = Object.freeze({
  id: "runtime_canary_update_after",
  articleId: updateBefore.articleId,
  title: "Violet marmot canary",
  evidenceText: "violetmarmotcanary confirms the current update source.",
  contentHash:
    "62869d58b678dac9b1ddb07b0951c08095753c4508eb282b2210e19f281aa2c9",
  query: "violetmarmotcanary",
}) satisfies RuntimeCanary;

const unpublish = Object.freeze({
  id: "runtime_canary_unpublish",
  articleId: "runtime_article_unpublish",
  title: "Silver oriole canary",
  evidenceText:
    "silveroriolecanary confirms the published source before unpublish.",
  contentHash:
    "33726e11dc9aeacd2072d3f699448eecb9f741d7c3b127f01fbe556b0d6b5a68",
  query: "silveroriolecanary",
}) satisfies RuntimeCanary;

const remove = Object.freeze({
  id: "runtime_canary_remove",
  articleId: "runtime_article_remove",
  title: "Cobalt lemur canary",
  evidenceText: "cobaltlemurcanary confirms the source before deletion.",
  contentHash:
    "25e16df80b8824ce22d8350665426cb322c00d1d10508ebc0c20397f6b219d18",
  query: "cobaltlemurcanary",
}) satisfies RuntimeCanary;

export const retrievalRuntimeCanaries = Object.freeze({
  updateBefore,
  updateAfter,
  unpublish,
  remove,
});

function compareText(left: string, right: string) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function identityKey(candidate: EvidenceCandidateIdentity) {
  return JSON.stringify([
    candidate.chunkId,
    candidate.articleId,
    candidate.articleContentHash,
    candidate.contentHash,
  ]);
}

function fixedHash(index: number) {
  return index.toString(16).padStart(64, "0");
}

function deterministicVector(sourceId: string, dimension: number) {
  const vector = Array<number>(dimension).fill(0);
  let state = 2_166_136_261;
  for (const character of sourceId) {
    state ^= character.codePointAt(0) ?? 0;
    state = Math.imul(state, 16_777_619) >>> 0;
  }
  const values = [0.75, 0.5, 0.35, 0.25] as const;
  for (const value of values) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    vector[state % dimension] = value;
  }
  return Object.freeze(vector);
}

function chunkRecord(
  source: {
    id: string;
    articleId: string;
    title: string;
    evidenceText: string;
    contentHash: string;
    canonicalUrl: string;
  },
  ordinal: number,
  indexGeneration: number,
  updatedAt: Date,
): EvidenceChunkRecord {
  return Object.freeze({
    id: source.id,
    workspaceId: fixtureWorkspaceId,
    articleId: source.articleId,
    articleContentHash: source.contentHash,
    contentHash: source.contentHash,
    embeddingInputHash: source.contentHash,
    indexGeneration,
    ordinal,
    title: source.title,
    headingPath: Object.freeze([source.title]),
    canonicalUrl: source.canonicalUrl,
    markdown: `## ${source.title}\n\n${source.evidenceText}`,
    evidenceText: source.evidenceText,
    embeddingText: `${source.title}\n\n${source.evidenceText}`,
    sourceLineRange: Object.freeze({ start: 1, end: 3 }),
    publicationState: "published",
    createdAt: fixtureCreatedAt,
    updatedAt,
  });
}

function canaryChunk(
  canary: RuntimeCanary,
  ordinal: number,
  indexGeneration: number,
  updatedAt: Date,
) {
  return chunkRecord(
    {
      ...canary,
      canonicalUrl: `https://synthetic.opas.invalid/runtime/${canary.id}`,
    },
    ordinal,
    indexGeneration,
    updatedAt,
  );
}

function embeddingRecord(
  chunk: EvidenceChunkRecord,
  vector: readonly number[],
): ActiveChunkEmbedding {
  return Object.freeze({
    workspaceId: fixtureWorkspaceId,
    chunkId: chunk.id,
    articleId: chunk.articleId,
    contentHash: chunk.contentHash,
    embeddingInputHash: chunk.embeddingInputHash,
    embeddingGenerationId: fixtureEmbeddingGenerationId,
    provider: "deterministic-fixture",
    model: "runtime-vector-v1",
    dimension: vector.length,
    configurationHash: syntheticRetrievalFixtureV1.sourceContentHash,
    vector,
  });
}

export function retrievalRuntimeP95(values: readonly number[]) {
  if (values.length === 0) {
    throw new Error("Runtime p95 requires at least one sample");
  }
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Runtime p95 samples must be finite non-negative numbers");
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] as number;
}

export function createRetrievalRuntimeFixture({
  chunkCount = retrievalRuntimeCorpusLimit.chunkCount,
  embeddingDimension = retrievalRuntimeCorpusLimit.embeddingDimension,
}: RetrievalRuntimeFixtureOptions = {}): RetrievalRuntimeFixture {
  if (
    !Number.isInteger(chunkCount) ||
    chunkCount < minimumRuntimeChunkCount ||
    chunkCount > retrievalRuntimeCorpusLimit.chunkCount
  ) {
    throw new Error("Runtime chunk count is outside the documented corpus limit");
  }
  if (
    !Number.isInteger(embeddingDimension) ||
    embeddingDimension < 4 ||
    embeddingDimension > retrievalRuntimeCorpusLimit.embeddingDimension
  ) {
    throw new Error(
      "Runtime embedding dimension is outside the documented corpus limit",
    );
  }

  const baselineChunks: EvidenceChunkRecord[] =
    syntheticRetrievalFixtureV1.sources.map((source, ordinal) =>
      chunkRecord(source, ordinal, 1, fixtureCreatedAt),
    );
  baselineChunks.push(
    canaryChunk(updateBefore, baselineChunks.length, 1, fixtureCreatedAt),
    canaryChunk(unpublish, baselineChunks.length + 1, 1, fixtureCreatedAt),
    canaryChunk(remove, baselineChunks.length + 2, 1, fixtureCreatedAt),
  );
  while (baselineChunks.length < chunkCount) {
    const fillerIndex = baselineChunks.length - minimumRuntimeChunkCount;
    const token = `qzxv${fillerIndex.toString().padStart(6, "0")}`;
    baselineChunks.push(
      chunkRecord(
        {
          id: `runtime_source_${fillerIndex.toString().padStart(6, "0")}`,
          articleId: `runtime_article_${fillerIndex.toString().padStart(6, "0")}`,
          title: token,
          evidenceText: `${token} nmbv${fillerIndex
            .toString()
            .padStart(6, "0")} plkj${fillerIndex
            .toString()
            .padStart(6, "0")}`,
          contentHash: fixedHash(fillerIndex + 1),
          canonicalUrl: `https://synthetic.opas.invalid/runtime/${token}`,
        },
        baselineChunks.length,
        1,
        fixtureCreatedAt,
      ),
    );
  }

  const currentUpdateChunk = canaryChunk(
    updateAfter,
    baselineChunks.findIndex(({ id }) => id === updateBefore.id),
    2,
    fixtureAdvancedAt,
  );
  const advancedChunks = baselineChunks
    .filter(
      ({ id }) =>
        id !== updateBefore.id && id !== unpublish.id && id !== remove.id,
    )
    .concat(currentUpdateChunk)
    .sort((left, right) => left.ordinal - right.ordinal || compareText(left.id, right.id));
  const allChunks = [...baselineChunks, currentUpdateChunk];
  const vectorsBySourceId = new Map(
    allChunks.map((chunk) => [
      chunk.id,
      deterministicVector(chunk.id, embeddingDimension),
    ]),
  );
  const baselineEmbeddings = baselineChunks.map((chunk) =>
    embeddingRecord(chunk, vectorsBySourceId.get(chunk.id) as readonly number[]),
  );
  const advancedEmbeddings = advancedChunks.map((chunk) =>
    embeddingRecord(chunk, vectorsBySourceId.get(chunk.id) as readonly number[]),
  );
  const baselineIdentities = new Set(
    baselineChunks.map((chunk) =>
      identityKey({
        chunkId: chunk.id,
        articleId: chunk.articleId,
        articleContentHash: chunk.articleContentHash,
        contentHash: chunk.contentHash,
      }),
    ),
  );
  const advancedIdentities = new Set(
    advancedChunks.map((chunk) =>
      identityKey({
        chunkId: chunk.id,
        articleId: chunk.articleId,
        articleContentHash: chunk.articleContentHash,
        contentHash: chunk.contentHash,
      }),
    ),
  );
  let generation = 1;

  function indexingState(): IndexingState {
    return {
      workspaceId: fixtureWorkspaceId,
      generation,
      activeEmbeddingGenerationId: fixtureEmbeddingGenerationId,
      updatedAt: generation === 1 ? fixtureCreatedAt : fixtureAdvancedAt,
    };
  }

  const source: EvidenceRetrievalSource = {
    async getIndexingState(workspaceId) {
      return workspaceId === fixtureWorkspaceId ? indexingState() : null;
    },
    async listEvidenceChunks(workspaceId) {
      if (workspaceId !== fixtureWorkspaceId) {
        return [];
      }
      return generation === 1 ? baselineChunks : advancedChunks;
    },
    async listActiveChunkEmbeddings(workspaceId) {
      if (workspaceId !== fixtureWorkspaceId) {
        return [];
      }
      return generation === 1 ? baselineEmbeddings : advancedEmbeddings;
    },
    async revalidateEvidenceCandidates(request) {
      if (
        request.workspaceId !== fixtureWorkspaceId ||
        request.generation !== generation
      ) {
        return [];
      }
      const identities = generation === 1 ? baselineIdentities : advancedIdentities;
      return request.candidates.filter((candidate) =>
        identities.has(identityKey(candidate)),
      );
    },
  };

  return {
    workspaceId: fixtureWorkspaceId,
    source,
    vectorForSourceId(sourceId) {
      return vectorsBySourceId.get(sourceId) ?? null;
    },
    advance() {
      generation = 2;
      return indexingState();
    },
  };
}
