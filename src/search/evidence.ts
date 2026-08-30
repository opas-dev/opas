// ABOUTME: Retrieves current published evidence with portable Orama lexical and vector scoring.
// ABOUTME: Keeps immutable indexes generation-scoped and requires final database source validation.
import { create, insertMultiple, search } from "@orama/orama";

import type {
  ActiveChunkEmbedding,
  EvidenceCandidateIdentity,
  EvidenceCandidateRevalidation,
  EvidenceChunkRecord,
  EvidenceRepository,
  IndexingState,
} from "@/db/repository";
import {
  maximumSearchQueryLength,
  normalizeSearchQuery,
} from "@/search/query";

export type {
  EvidenceCandidateIdentity,
  EvidenceCandidateRevalidation,
} from "@/db/repository";

export type EvidenceRetrievalMode = "lexical" | "vector" | "hybrid";

export type EvidenceRetrievalSource = {
  getIndexingState(workspaceId: string): Promise<IndexingState | null>;
  listEvidenceChunks(workspaceId: string): Promise<EvidenceChunkRecord[]>;
  listActiveChunkEmbeddings(
    workspaceId: string,
  ): Promise<ActiveChunkEmbedding[]>;
  revalidateEvidenceCandidates(
    request: EvidenceCandidateRevalidation,
  ): Promise<readonly EvidenceCandidateIdentity[]>;
};

export type EvidenceRetrievalResult = EvidenceCandidateIdentity & {
  sourceId: string;
  workspaceId: string;
  indexGeneration: number;
  mode: EvidenceRetrievalMode;
  score: number;
  ordinal: number;
  title: string;
  headingPath: readonly string[];
  canonicalUrl: string;
  markdown: string;
  evidenceText: string;
  sourceLineRange: Readonly<{
    start: number;
    end: number;
  }>;
};

export type EvidenceRetrievalRequest = {
  workspaceId: string;
  query: string;
  mode: EvidenceRetrievalMode;
  queryVector?: readonly number[];
  topK?: number;
};

type RepositoryEvidenceOperations = Pick<
  EvidenceRepository,
  | "getIndexingState"
  | "listEvidenceChunks"
  | "listActiveChunkEmbeddings"
  | "revalidateEvidenceCandidates"
>;

type EvidenceDocument = {
  id: string;
  articleId: string;
  articleContentHash: string;
  contentHash: string;
  ordinal: number;
  title: string;
  headingPathText: string;
  canonicalUrl: string;
  markdown: string;
  evidenceText: string;
  sourceLineStart: number;
  sourceLineEnd: number;
  embedding?: number[];
};

const evidenceSchemaBase = {
  id: "string",
  articleId: "string",
  articleContentHash: "string",
  contentHash: "string",
  ordinal: "number",
  title: "string",
  headingPathText: "string",
  canonicalUrl: "string",
  markdown: "string",
  evidenceText: "string",
  sourceLineStart: "number",
  sourceLineEnd: "number",
} as const;

function createEvidenceIndex(dimension: number) {
  const vectorSchema: `vector[${number}]` = `vector[${dimension}]`;
  return create({
    schema: {
      ...evidenceSchemaBase,
      embedding: vectorSchema,
    },
  });
}

type EvidenceIndex = ReturnType<typeof createEvidenceIndex>;

type EvidenceSnapshot = {
  workspaceId: string;
  generation: number;
  embeddingGenerationId: string | null;
  dimension: number | null;
  index: EvidenceIndex;
  chunksById: ReadonlyMap<string, EvidenceChunkRecord>;
};

type CacheEntry = {
  key: string;
  workspaceId: string;
  generation: number;
  requestOrder: number;
  snapshot: Promise<EvidenceSnapshot>;
};

export const maximumEvidenceQueryLength = maximumSearchQueryLength;
export const defaultEvidenceTopK = 5;
export const maximumEvidenceTopK = 20;

const identifierMaximumLength = 200;
const activeCacheEntriesPerWorkspace = 1;
const minimumVectorSimilarity = Number.EPSILON;

export class EvidenceRetrievalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceRetrievalError";
  }
}

function compareText(left: string, right: string) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function validWorkspaceId(workspaceId: string) {
  return (
    workspaceId.length > 0 &&
    workspaceId.length <= identifierMaximumLength &&
    workspaceId.trim() === workspaceId &&
    !/[\u0000-\u001f\u007f]/u.test(workspaceId)
  );
}

function boundedTopK(topK: number | undefined) {
  if (topK === undefined) {
    return defaultEvidenceTopK;
  }
  if (!Number.isFinite(topK)) {
    throw new EvidenceRetrievalError("Evidence result limit is invalid");
  }
  return Math.min(maximumEvidenceTopK, Math.max(0, Math.trunc(topK)));
}

function boundedVector(vector: readonly number[] | undefined) {
  if (
    !vector ||
    vector.length === 0 ||
    vector.length > 4_096 ||
    vector.some((value) => !Number.isFinite(value)) ||
    !hasUsableMagnitude(vector)
  ) {
    throw new EvidenceRetrievalError("Evidence query vector is invalid");
  }
  return [...vector];
}

function hasUsableMagnitude(vector: readonly number[]) {
  const stored = Float32Array.from(vector);
  let squaredMagnitude = 0;
  for (const value of stored) {
    squaredMagnitude += value * value;
  }
  return Number.isFinite(squaredMagnitude) && squaredMagnitude > 0;
}

function usableStoredVector(embedding: ActiveChunkEmbedding) {
  return (
    Number.isInteger(embedding.dimension) &&
    embedding.dimension > 0 &&
    embedding.dimension <= 4_096 &&
    embedding.vector.length === embedding.dimension &&
    embedding.vector.every((value) => Number.isFinite(value)) &&
    hasUsableMagnitude(embedding.vector)
  );
}

function candidateIdentity(
  chunk: EvidenceChunkRecord,
): EvidenceCandidateIdentity {
  return {
    chunkId: chunk.id,
    articleId: chunk.articleId,
    articleContentHash: chunk.articleContentHash,
    contentHash: chunk.contentHash,
  };
}

function resultIdentity(
  result: EvidenceRetrievalResult,
): EvidenceCandidateIdentity {
  return {
    chunkId: result.sourceId,
    articleId: result.articleId,
    articleContentHash: result.articleContentHash,
    contentHash: result.contentHash,
  };
}

function identityKey(candidate: EvidenceCandidateIdentity) {
  return JSON.stringify([
    candidate.chunkId,
    candidate.articleId,
    candidate.articleContentHash,
    candidate.contentHash,
  ]);
}

function cacheKey(state: IndexingState) {
  return JSON.stringify([
    state.workspaceId,
    state.generation,
    state.activeEmbeddingGenerationId,
  ]);
}

function freezeChunk(chunk: EvidenceChunkRecord): EvidenceChunkRecord {
  return Object.freeze({
    ...chunk,
    headingPath: Object.freeze([...chunk.headingPath]),
    sourceLineRange: Object.freeze({ ...chunk.sourceLineRange }),
  });
}

function resultFromChunk(
  chunk: EvidenceChunkRecord,
  generation: number,
  mode: EvidenceRetrievalMode,
  score: number,
): EvidenceRetrievalResult {
  return {
    ...candidateIdentity(chunk),
    sourceId: chunk.id,
    workspaceId: chunk.workspaceId,
    indexGeneration: generation,
    mode,
    score,
    ordinal: chunk.ordinal,
    title: chunk.title,
    headingPath: [...chunk.headingPath],
    canonicalUrl: chunk.canonicalUrl,
    markdown: chunk.markdown,
    evidenceText: chunk.evidenceText,
    sourceLineRange: { ...chunk.sourceLineRange },
  };
}

async function buildSnapshot(
  source: EvidenceRetrievalSource,
  state: IndexingState,
): Promise<EvidenceSnapshot> {
  const [loadedChunks, loadedEmbeddings] = await Promise.all([
    source.listEvidenceChunks(state.workspaceId),
    source.listActiveChunkEmbeddings(state.workspaceId),
  ]);
  const chunks = loadedChunks
    .filter(
      (chunk) =>
        chunk.workspaceId === state.workspaceId &&
        chunk.publicationState === "published" &&
        Number.isInteger(chunk.indexGeneration) &&
        chunk.indexGeneration > 0 &&
        chunk.indexGeneration <= state.generation,
    )
    .sort((left, right) => compareText(left.id, right.id));
  const chunksById = new Map<string, EvidenceChunkRecord>();
  for (const loadedChunk of chunks) {
    if (chunksById.has(loadedChunk.id)) {
      throw new EvidenceRetrievalError("Evidence contains a duplicate source ID");
    }
    chunksById.set(loadedChunk.id, freezeChunk(loadedChunk));
  }

  const matchingEmbeddings = loadedEmbeddings
    .filter(
      (embedding) =>
        state.activeEmbeddingGenerationId !== null &&
        embedding.workspaceId === state.workspaceId &&
        embedding.embeddingGenerationId === state.activeEmbeddingGenerationId &&
        usableStoredVector(embedding),
    )
    .sort((left, right) => compareText(left.chunkId, right.chunkId));
  const dimensions = new Set(matchingEmbeddings.map(({ dimension }) => dimension));
  if (dimensions.size > 1) {
    throw new EvidenceRetrievalError(
      "Active evidence embeddings have inconsistent dimensions",
    );
  }
  const dimension = dimensions.values().next().value ?? null;
  const embeddingsByChunkId = new Map<string, ActiveChunkEmbedding>();
  for (const embeddingRecord of matchingEmbeddings) {
    const currentChunk = chunksById.get(embeddingRecord.chunkId);
    if (
      currentChunk?.articleId !== embeddingRecord.articleId ||
      currentChunk.contentHash !== embeddingRecord.contentHash ||
      currentChunk.embeddingInputHash !== embeddingRecord.embeddingInputHash
    ) {
      continue;
    }
    if (embeddingsByChunkId.has(embeddingRecord.chunkId)) {
      throw new EvidenceRetrievalError(
        "Evidence contains duplicate active embeddings",
      );
    }
    embeddingsByChunkId.set(embeddingRecord.chunkId, embeddingRecord);
  }

  const index = createEvidenceIndex(dimension ?? 1);
  const documents: EvidenceDocument[] = [...chunksById.values()].map((chunk) => {
    const embeddingRecord = embeddingsByChunkId.get(chunk.id);
    return {
      id: chunk.id,
      articleId: chunk.articleId,
      articleContentHash: chunk.articleContentHash,
      contentHash: chunk.contentHash,
      ordinal: chunk.ordinal,
      title: chunk.title,
      headingPathText: chunk.headingPath.join(" "),
      canonicalUrl: chunk.canonicalUrl,
      markdown: chunk.markdown,
      evidenceText: chunk.evidenceText,
      sourceLineStart: chunk.sourceLineRange.start,
      sourceLineEnd: chunk.sourceLineRange.end,
      ...(embeddingRecord ? { embedding: [...embeddingRecord.vector] } : {}),
    };
  });
  if (documents.length > 0) {
    await insertMultiple(index, documents);
  }

  return Object.freeze({
    workspaceId: state.workspaceId,
    generation: state.generation,
    embeddingGenerationId: state.activeEmbeddingGenerationId,
    dimension,
    index,
    chunksById,
  });
}

export function normalizeEvidenceQuery(query: string) {
  return Array.from(normalizeSearchQuery(query))
    .slice(0, maximumEvidenceQueryLength)
    .join("");
}

export function createRepositoryEvidenceSource(
  repository: RepositoryEvidenceOperations,
): EvidenceRetrievalSource {
  return {
    getIndexingState: repository.getIndexingState.bind(repository),
    listEvidenceChunks: repository.listEvidenceChunks.bind(repository),
    listActiveChunkEmbeddings:
      repository.listActiveChunkEmbeddings.bind(repository),
    revalidateEvidenceCandidates:
      repository.revalidateEvidenceCandidates.bind(repository),
  };
}

export function createEvidenceRetriever(source: EvidenceRetrievalSource) {
  const cache = new Map<string, CacheEntry>();
  let requestOrder = 0;

  function pruneCache(workspaceId: string) {
    const workspaceEntries = [...cache.values()]
      .filter((entry) => entry.workspaceId === workspaceId)
      .sort(
        (left, right) =>
          right.generation - left.generation ||
          right.requestOrder - left.requestOrder,
      );
    for (const entry of workspaceEntries.slice(activeCacheEntriesPerWorkspace)) {
      cache.delete(entry.key);
    }
  }

  async function snapshotFor(state: IndexingState) {
    const key = cacheKey(state);
    const cached = cache.get(key);
    if (cached) {
      return cached.snapshot;
    }

    requestOrder += 1;
    const entry: CacheEntry = {
      key,
      workspaceId: state.workspaceId,
      generation: state.generation,
      requestOrder,
      snapshot: buildSnapshot(source, state),
    };
    cache.set(key, entry);
    try {
      const snapshot = await entry.snapshot;
      pruneCache(state.workspaceId);
      return snapshot;
    } catch (error) {
      if (cache.get(key) === entry) {
        cache.delete(key);
      }
      throw error;
    }
  }

  return async function retrieveEvidence({
    workspaceId,
    query,
    mode,
    queryVector,
    topK,
  }: EvidenceRetrievalRequest): Promise<EvidenceRetrievalResult[]> {
    if (!validWorkspaceId(workspaceId)) {
      throw new EvidenceRetrievalError("Evidence workspace ID is invalid");
    }
    const term = normalizeEvidenceQuery(query);
    const resultLimit = boundedTopK(topK);
    if (!term || resultLimit === 0) {
      return [];
    }
    const state = await source.getIndexingState(workspaceId);
    if (!state || state.workspaceId !== workspaceId || state.generation < 1) {
      return [];
    }
    const snapshot = await snapshotFor(state);
    if (snapshot.chunksById.size === 0) {
      return [];
    }

    let effectiveMode = mode;
    if (mode === "hybrid" && snapshot.dimension === null) {
      effectiveMode = "lexical";
    }
    if (mode === "vector" && snapshot.dimension === null) {
      return [];
    }
    const vector =
      effectiveMode === "lexical" ? undefined : boundedVector(queryVector);
    if (
      effectiveMode !== "lexical" &&
      vector?.length !== snapshot.dimension
    ) {
      throw new EvidenceRetrievalError(
        "Evidence query vector dimension does not match the active index",
      );
    }

    const candidateLimit = Math.min(
      snapshot.chunksById.size,
      Math.max(resultLimit, resultLimit * 4),
    );
    const properties = ["title", "headingPathText", "evidenceText"] as const;
    const searchResults =
      effectiveMode === "lexical"
        ? await search(snapshot.index, {
            term,
            properties: [...properties],
            tolerance: 1,
            limit: candidateLimit,
            includeVectors: true,
          })
        : await search(snapshot.index, {
            mode: effectiveMode,
            term,
            properties: [...properties],
            tolerance: 1,
            limit: candidateLimit,
            similarity: minimumVectorSimilarity,
            includeVectors: true,
            vector: {
              property: "embedding",
              value: vector!,
            },
            ...(effectiveMode === "hybrid"
              ? { hybridWeights: { text: 0.5, vector: 0.5 } }
              : {}),
          });
    const candidates = searchResults.hits
      .map((hit) => {
        const currentChunk = snapshot.chunksById.get(hit.document.id);
        return currentChunk
          ? resultFromChunk(
              currentChunk,
              snapshot.generation,
              effectiveMode,
              hit.score,
            )
          : null;
      })
      .filter((result): result is EvidenceRetrievalResult => result !== null)
      .sort(
        (left, right) =>
          right.score - left.score || compareText(left.sourceId, right.sourceId),
      );
    if (candidates.length === 0) {
      return [];
    }

    const validCandidates = await source.revalidateEvidenceCandidates({
      workspaceId,
      generation: snapshot.generation,
      candidates: candidates.map(resultIdentity),
    });
    const validIdentityKeys = new Set(validCandidates.map(identityKey));
    return candidates
      .filter((candidate) =>
        validIdentityKeys.has(identityKey(resultIdentity(candidate))),
      )
      .slice(0, resultLimit);
  };
}
