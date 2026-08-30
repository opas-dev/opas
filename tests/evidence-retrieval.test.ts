// ABOUTME: Verifies portable lexical, vector, and hybrid retrieval over published evidence.
// ABOUTME: Guards generation caches, workspace isolation, query bounds, and final source revalidation.
import assert from "node:assert/strict";
import test from "node:test";

import type {
  ActiveChunkEmbedding,
  EvidenceChunkRecord,
  IndexingState,
} from "@/db/repository";
import {
  createEvidenceRetriever,
  EvidenceRetrievalError,
  maximumEvidenceQueryLength,
  maximumEvidenceTopK,
  normalizeEvidenceQuery,
  type EvidenceCandidateIdentity,
  type EvidenceRetrievalSource,
} from "@/search/evidence";

const recordedAt = new Date("2026-08-30T00:00:00.000Z");
const contentHashA = "a".repeat(64);
const contentHashB = "b".repeat(64);
const contentHashC = "c".repeat(64);
const articleHashA = "d".repeat(64);
const articleHashB = "e".repeat(64);
const articleHashC = "f".repeat(64);

function chunk(
  id: string,
  articleId: string,
  title: string,
  evidenceText: string,
  overrides: Partial<EvidenceChunkRecord> = {},
): EvidenceChunkRecord {
  const ordinal = id.charCodeAt(id.length - 1) % 10;
  return {
    id,
    workspaceId: "workspace_alpha",
    articleId,
    articleContentHash: articleHashA,
    contentHash: contentHashA,
    embeddingInputHash: contentHashA,
    indexGeneration: 1,
    ordinal,
    title,
    headingPath: [title],
    canonicalUrl: `https://docs.example.com/${articleId}`,
    markdown: `## ${title}\n\n${evidenceText}`,
    evidenceText,
    embeddingText: `${title}\n${evidenceText}`,
    sourceLineRange: { start: 3, end: 5 },
    publicationState: "published",
    createdAt: recordedAt,
    updatedAt: recordedAt,
    ...overrides,
  };
}

function embedding(
  source: EvidenceChunkRecord,
  vector: readonly number[],
): ActiveChunkEmbedding {
  return {
    workspaceId: source.workspaceId,
    chunkId: source.id,
    articleId: source.articleId,
    contentHash: source.contentHash,
    embeddingInputHash: source.embeddingInputHash,
    embeddingGenerationId: "embedding_generation_one",
    provider: "fixture",
    model: "deterministic",
    dimension: vector.length,
    configurationHash: contentHashC,
    vector,
  };
}

class MutableEvidenceSource implements EvidenceRetrievalSource {
  state: IndexingState | null = {
    workspaceId: "workspace_alpha",
    generation: 1,
    activeEmbeddingGenerationId: "embedding_generation_one",
    updatedAt: recordedAt,
  };
  chunks: EvidenceChunkRecord[] = [];
  embeddings: ActiveChunkEmbedding[] = [];
  stateReads = 0;
  chunkReads = 0;
  embeddingReads = 0;
  revalidationReads = 0;

  async getIndexingState(workspaceId: string) {
    this.stateReads += 1;
    return this.state?.workspaceId === workspaceId ? this.state : null;
  }

  async listEvidenceChunks() {
    this.chunkReads += 1;
    return this.chunks;
  }

  async listActiveChunkEmbeddings() {
    this.embeddingReads += 1;
    return this.embeddings;
  }

  async revalidateEvidenceCandidates({
    workspaceId,
    generation,
    candidates,
  }: {
    workspaceId: string;
    generation: number;
    candidates: readonly EvidenceCandidateIdentity[];
  }) {
    this.revalidationReads += 1;
    if (
      this.state?.workspaceId !== workspaceId ||
      this.state.generation !== generation
    ) {
      return [];
    }

    const current = new Map(
      this.chunks
        .filter(
          (source) =>
            source.workspaceId === workspaceId &&
            source.publicationState === "published",
        )
        .map((source) => [source.id, source]),
    );
    return candidates.filter((candidate) => {
      const source = current.get(candidate.chunkId);
      return (
        source?.articleId === candidate.articleId &&
        source.articleContentHash === candidate.articleContentHash &&
        source.contentHash === candidate.contentHash
      );
    });
  }
}

test("normalizes and bounds evidence queries by Unicode code point", () => {
  assert.equal(normalizeEvidenceQuery("  Runtıme\n\tMDX  "), "Runtıme MDX");
  assert.equal(
    Array.from(normalizeEvidenceQuery("🔎".repeat(maximumEvidenceQueryLength + 2)))
      .length,
    maximumEvidenceQueryLength,
  );
  assert.equal(normalizeEvidenceQuery("   "), "");
});

test("lexical retrieval is workspace scoped, top-k bounded, and deterministic", async () => {
  const source = new MutableEvidenceSource();
  source.state = {
    ...source.state!,
    activeEmbeddingGenerationId: null,
  };
  const workspaceChunks = Array.from({ length: maximumEvidenceTopK + 5 }, (_, index) =>
    chunk(
      `chunk_${String(index).padStart(2, "0")}`,
      `article_${index}`,
      "Reset access",
      "Rotate the recovery code.",
    ),
  );
  source.chunks = [
    ...workspaceChunks.reverse(),
    chunk("chunk_cross", "article_cross", "Reset access", "Rotate the recovery code.", {
      workspaceId: "workspace_beta",
    }),
  ];
  const retrieve = createEvidenceRetriever(source);

  const results = await retrieve({
    workspaceId: "workspace_alpha",
    query: "recovery code",
    mode: "lexical",
    topK: maximumEvidenceTopK + 100,
  });

  assert.deepEqual(
    results.map((result) => result.sourceId),
    [...workspaceChunks]
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, maximumEvidenceTopK)
      .map(({ id }) => id),
  );
  assert.equal(results.length, maximumEvidenceTopK);
  assert.ok(results.every((result) => result.workspaceId === "workspace_alpha"));
});

test("lexical retrieval rejects unrelated questions that share only function words", async () => {
  const source = new MutableEvidenceSource();
  source.state = {
    ...source.state!,
    activeEmbeddingGenerationId: null,
  };
  source.chunks = [
    chunk(
      "chunk_runtime",
      "article_runtime",
      "Runtime MDX in OPAS",
      "This article is loaded from the deployment database through Drizzle ORM and compiled when the request arrives.",
    ),
  ];
  const retrieve = createEvidenceRetriever(source);

  assert.deepEqual(
    await retrieve({
      workspaceId: "workspace_alpha",
      query: "What is the current weather in Tokyo?",
      mode: "lexical",
    }),
    [],
  );
  assert.equal(
    (await retrieve({
      workspaceId: "workspace_alpha",
      query: "How is the Runtime MDX article loaded?",
      mode: "lexical",
    }))[0]?.sourceId,
    "chunk_runtime",
  );
});

test("vector and hybrid modes rank provider-independent vectors consistently", async () => {
  const password = chunk(
    "chunk_password",
    "article_password",
    "Account security",
    "Use the recovery link to reset a password.",
  );
  const invoice = chunk(
    "chunk_invoice",
    "article_invoice",
    "Billing",
    "Download an invoice from billing settings.",
    {
      articleContentHash: articleHashB,
      contentHash: contentHashB,
      embeddingInputHash: contentHashB,
    },
  );
  const source = new MutableEvidenceSource();
  source.chunks = [invoice, password];
  source.embeddings = [
    embedding(invoice, [0, 1, 0]),
    embedding(password, [1, 0, 0]),
  ];
  const retrieve = createEvidenceRetriever(source);

  for (const mode of ["vector", "hybrid"] as const) {
    const results = await retrieve({
      workspaceId: "workspace_alpha",
      query: "password recovery",
      mode,
      queryVector: [0.99, 0.01, 0],
      topK: 2,
    });
    assert.equal(results[0]?.sourceId, "chunk_password", mode);
    assert.deepEqual(
      results.map((result) => result.sourceId),
      [...results]
        .sort(
          (left, right) =>
            right.score - left.score || left.sourceId.localeCompare(right.sourceId),
        )
        .map((result) => result.sourceId),
      `${mode} results were not deterministically ordered`,
    );
  }
});

test("hybrid confidence keeps absolute semantic and lexical evidence instead of normalized rank", async () => {
  const runtime = chunk(
    "chunk_runtime",
    "article_runtime",
    "Runtime MDX in OPAS",
    "Database content is compiled when the request arrives.",
  );
  const deployment = chunk(
    "chunk_deployment",
    "article_deployment",
    "Deployment targets",
    "The content model runs on Docker, Vercel, and Cloudflare Workers.",
    {
      articleContentHash: articleHashB,
      contentHash: contentHashB,
      embeddingInputHash: contentHashB,
    },
  );
  const offline = chunk(
    "chunk_offline",
    "article_offline",
    "Offline export",
    "Download a portable archive without an active network connection.",
    {
      articleContentHash: articleHashC,
      contentHash: contentHashC,
      embeddingInputHash: contentHashC,
    },
  );
  const source = new MutableEvidenceSource();
  source.chunks = [runtime, deployment, offline];
  source.embeddings = [
    embedding(runtime, [1, 0, 0]),
    embedding(deployment, [0.9, 0.1, 0]),
  ];
  const retrieve = createEvidenceRetriever(source);

  const unsupported = await retrieve({
    workspaceId: "workspace_alpha",
    query: "What is the current weather in Tokyo?",
    mode: "hybrid",
    queryVector: [0.4, 0.916515, 0],
  });
  assert.ok(unsupported.length > 0);
  assert.equal(unsupported[0]?.sourceId, deployment.id);
  assert.ok(unsupported.every(({ score }) => score < 0.7));

  const semantic = await retrieve({
    workspaceId: "workspace_alpha",
    query: "Where is documentation executed?",
    mode: "hybrid",
    queryVector: [0.98, 0.2, 0],
  });
  assert.ok((semantic[0]?.score ?? 0) > 0.95);

  const lexical = await retrieve({
    workspaceId: "workspace_alpha",
    query: "Runtime MDX",
    mode: "hybrid",
    queryVector: [0.4, 0.916515, 0],
  });
  assert.equal(lexical[0]?.sourceId, runtime.id);
  assert.equal(lexical[0]?.score, 1);

  const partial = await retrieve({
    workspaceId: "workspace_alpha",
    query: "Runtime weather Tokyo",
    mode: "hybrid",
    queryVector: [0.4, 0.916515, 0],
  });
  assert.ok(partial.every(({ score }) => score < 0.7));

  const missingVector = await retrieve({
    workspaceId: "workspace_alpha",
    query: "Offline export",
    mode: "hybrid",
    queryVector: [0.4, 0.916515, 0],
  });
  assert.equal(missingVector[0]?.sourceId, offline.id);
  assert.equal(missingVector[0]?.score, 1);
});

test("hybrid retrieval stays lexical while active embeddings are pending", async () => {
  const source = new MutableEvidenceSource();
  const indexed = chunk(
    "chunk_indexed",
    "article_indexed",
    "Indexed",
    "An unrelated billing guide.",
  );
  const pending = chunk(
    "chunk_pending",
    "article_pending",
    "Pending",
    "A quasar recovery guide.",
    {
      articleContentHash: articleHashB,
      contentHash: contentHashB,
      embeddingInputHash: contentHashB,
    },
  );
  source.chunks = [indexed, pending];
  source.embeddings = [embedding(indexed, [1, 0, 0])];
  const retrieve = createEvidenceRetriever(source);

  const results = await retrieve({
    workspaceId: "workspace_alpha",
    query: "quasar",
    mode: "hybrid",
    queryVector: [1, 0, 0],
  });

  assert.ok(results.some((result) => result.sourceId === "chunk_pending"));
  assert.ok(results.every((result) => result.mode === "hybrid"));
});

test("hybrid retrieval falls back to lexical before an embedding generation is active", async () => {
  const source = new MutableEvidenceSource();
  source.state = {
    ...source.state!,
    activeEmbeddingGenerationId: null,
  };
  source.chunks = [
    chunk(
      "chunk_lexical",
      "article_lexical",
      "Lexical",
      "A nebula recovery guide.",
    ),
  ];
  const retrieve = createEvidenceRetriever(source);

  const results = await retrieve({
    workspaceId: "workspace_alpha",
    query: "nebula",
    mode: "hybrid",
  });

  assert.equal(results[0]?.sourceId, "chunk_lexical");
  assert.equal(results[0]?.mode, "lexical");
});

test("validates query vectors without coupling retrieval to a provider", async () => {
  const source = new MutableEvidenceSource();
  const article = chunk("chunk_vector", "article_vector", "Vector", "Vector evidence.");
  source.chunks = [article];
  source.embeddings = [embedding(article, [1, 0, 0])];
  const retrieve = createEvidenceRetriever(source);

  await assert.rejects(
    retrieve({
      workspaceId: "workspace_alpha",
      query: "vector",
      mode: "vector",
      queryVector: [1, 0],
    }),
    EvidenceRetrievalError,
  );
  await assert.rejects(
    retrieve({
      workspaceId: "workspace_alpha",
      query: "vector",
      mode: "vector",
      queryVector: [Number.NaN, 0, 0],
    }),
    EvidenceRetrievalError,
  );
});

test("checks database generation on every request and reuses only its immutable cache", async () => {
  const source = new MutableEvidenceSource();
  const original = chunk(
    "chunk_original",
    "article_original",
    "Original",
    "The heliotrope recovery process.",
  );
  source.chunks = [original];
  source.embeddings = [embedding(original, [1, 0, 0])];
  const retrieve = createEvidenceRetriever(source);

  assert.equal(
    (await retrieve({
      workspaceId: "workspace_alpha",
      query: "heliotrope",
      mode: "lexical",
    }))[0]?.sourceId,
    "chunk_original",
  );
  assert.equal(
    (await retrieve({
      workspaceId: "workspace_alpha",
      query: "heliotrope",
      mode: "lexical",
    }))[0]?.sourceId,
    "chunk_original",
  );
  assert.equal(source.stateReads, 2);
  assert.equal(source.chunkReads, 1);
  assert.equal(source.embeddingReads, 1);
  assert.equal(source.revalidationReads, 2);

  source.chunks = [];
  assert.deepEqual(
    await retrieve({
      workspaceId: "workspace_alpha",
      query: "heliotrope",
      mode: "lexical",
    }),
    [],
    "final revalidation exposed a removed source before generation advanced",
  );
  assert.equal(source.chunkReads, 1, "a generation cache was mutated or rebuilt");
});

test("keys vector caches by the active embedding generation", async () => {
  const source = new MutableEvidenceSource();
  const first = chunk(
    "chunk_first",
    "article_first",
    "First",
    "First vector source.",
  );
  const second = chunk(
    "chunk_second",
    "article_second",
    "Second",
    "Second vector source.",
    {
      articleContentHash: articleHashB,
      contentHash: contentHashB,
      embeddingInputHash: contentHashB,
    },
  );
  source.chunks = [first, second];
  source.embeddings = [
    embedding(first, [1, 0, 0]),
    embedding(second, [0, 1, 0]),
  ];
  const retrieve = createEvidenceRetriever(source);

  assert.equal(
    (await retrieve({
      workspaceId: "workspace_alpha",
      query: "source",
      mode: "vector",
      queryVector: [1, 0, 0],
    }))[0]?.sourceId,
    "chunk_first",
  );

  source.state = {
    ...source.state!,
    activeEmbeddingGenerationId: "embedding_generation_two",
    updatedAt: new Date(recordedAt.getTime() + 1_000),
  };
  source.embeddings = [
    {
      ...embedding(first, [0, 1, 0]),
      embeddingGenerationId: "embedding_generation_two",
    },
    {
      ...embedding(second, [1, 0, 0]),
      embeddingGenerationId: "embedding_generation_two",
    },
  ];

  assert.equal(
    (await retrieve({
      workspaceId: "workspace_alpha",
      query: "source",
      mode: "vector",
      queryVector: [1, 0, 0],
    }))[0]?.sourceId,
    "chunk_second",
  );
  assert.equal(source.chunkReads, 2);
  assert.equal(source.embeddingReads, 2);
});

test("update, unpublish, and delete canaries disappear from every warm isolate", async () => {
  const source = new MutableEvidenceSource();
  const canary = chunk(
    "chunk_canary",
    "article_canary",
    "Canary",
    "The obsolete zephyr instruction.",
  );
  source.chunks = [canary];
  source.embeddings = [embedding(canary, [1, 0, 0])];
  const isolates = [createEvidenceRetriever(source), createEvidenceRetriever(source)];

  for (const retrieve of isolates) {
    assert.equal(
      (await retrieve({
        workspaceId: "workspace_alpha",
        query: "obsolete zephyr",
        mode: "hybrid",
        queryVector: [1, 0, 0],
      }))[0]?.sourceId,
      "chunk_canary",
    );
  }

  const replacement = chunk(
    "chunk_replacement",
    "article_canary",
    "Canary",
    "The current aurora instruction.",
    {
      articleContentHash: articleHashC,
      contentHash: contentHashC,
      embeddingInputHash: contentHashC,
      indexGeneration: 2,
    },
  );
  source.state = {
    ...source.state!,
    generation: 2,
    updatedAt: new Date(recordedAt.getTime() + 1_000),
  };
  source.chunks = [replacement];
  source.embeddings = [embedding(replacement, [0, 1, 0])];

  for (const retrieve of isolates) {
    assert.deepEqual(
      await retrieve({
        workspaceId: "workspace_alpha",
        query: "obsolete zephyr",
        mode: "lexical",
      }),
      [],
    );
    assert.equal(
      (await retrieve({
        workspaceId: "workspace_alpha",
        query: "current aurora",
        mode: "lexical",
      }))[0]?.sourceId,
      "chunk_replacement",
    );
  }

  source.state = {
    ...source.state!,
    generation: 3,
    updatedAt: new Date(recordedAt.getTime() + 2_000),
  };
  source.chunks = [];
  source.embeddings = [];
  for (const retrieve of isolates) {
    assert.deepEqual(
      await retrieve({
        workspaceId: "workspace_alpha",
        query: "current aurora",
        mode: "lexical",
      }),
      [],
    );
  }
});

test("returns only identities accepted by final publication and hash revalidation", async () => {
  const source = new MutableEvidenceSource();
  const stale = chunk(
    "chunk_stale",
    "article_stale",
    "Stale",
    "The sodium recovery path.",
  );
  source.chunks = [stale];
  const retrieve = createEvidenceRetriever({
    ...source,
    getIndexingState: source.getIndexingState.bind(source),
    listEvidenceChunks: source.listEvidenceChunks.bind(source),
    listActiveChunkEmbeddings: source.listActiveChunkEmbeddings.bind(source),
    async revalidateEvidenceCandidates() {
      return [
        {
          chunkId: stale.id,
          articleId: stale.articleId,
          articleContentHash: articleHashB,
          contentHash: stale.contentHash,
        },
      ];
    },
  });

  assert.deepEqual(
    await retrieve({
      workspaceId: "workspace_alpha",
      query: "sodium",
      mode: "lexical",
    }),
    [],
  );
});
