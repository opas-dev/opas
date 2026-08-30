// ABOUTME: Verifies the deterministic retrieval runtime corpus and cache canary lifecycle.
// ABOUTME: Keeps the workerd benchmark limits and p95 calculation reproducible.
import assert from "node:assert/strict";
import test from "node:test";

import {
  createRetrievalRuntimeFixture,
  retrievalRuntimeCalibration,
  retrievalRuntimeCanaries,
  retrievalRuntimeCorpusLimit,
  retrievalRuntimeP95,
} from "@/evaluation/retrieval-runtime";
import { syntheticRetrievalFixtureV1 } from "@/evaluation/fixtures/synthetic-retrieval-v1";
import { createEvidenceRetriever } from "@/search/evidence";

test("runtime corpus fixes the documented workerd memory boundary", () => {
  assert.deepEqual(retrievalRuntimeCorpusLimit, {
    chunkCount: 500,
    embeddingDimension: 768,
    maximumEvidenceTextUtf8Bytes: 384,
    maximumMarkdownUtf8Bytes: 224,
    maximumPeakRssBytes: 96 * 1_024 * 1_024,
    isolateCount: 3,
    warmSamples: 100,
    rebuildSamples: 20,
  });
  assert.equal(retrievalRuntimeCalibration.selectedChunkCount, 500);
  assert.deepEqual(
    retrievalRuntimeCalibration.observations.map(
      ({ chunkCount, peakRssBytes, decision }) => ({
        chunkCount,
        peakRssBytes,
        decision,
      }),
    ),
    [
      {
        chunkCount: 2_000,
        peakRssBytes: 124_387_328,
        decision: "rejected-over-limit",
      },
      {
        chunkCount: 750,
        peakRssBytes: 99_876_864,
        decision: "rejected-insufficient-margin",
      },
      {
        chunkCount: 600,
        peakRssBytes: 96_239_616,
        decision: "rejected-insufficient-margin",
      },
    ],
  );
});

test("runtime p95 uses the deterministic nearest-rank definition", () => {
  assert.equal(retrievalRuntimeP95([100, 1, 2, 3, 4]), 100);
  assert.equal(
    retrievalRuntimeP95(Array.from({ length: 100 }, (_, index) => index + 1)),
    95,
  );
  assert.throws(() => retrievalRuntimeP95([]), /at least one sample/u);
  assert.throws(() => retrievalRuntimeP95([1, Number.NaN]), /finite/u);
});

test("runtime corpus contains the shared fixture, canaries, and deterministic vectors", async () => {
  const first = createRetrievalRuntimeFixture({
    chunkCount: 24,
    embeddingDimension: 32,
  });
  const second = createRetrievalRuntimeFixture({
    chunkCount: 24,
    embeddingDimension: 32,
  });
  const chunks = await first.source.listEvidenceChunks(first.workspaceId);
  const embeddings = await first.source.listActiveChunkEmbeddings(first.workspaceId);
  const repeatedEmbeddings = await second.source.listActiveChunkEmbeddings(
    second.workspaceId,
  );

  assert.equal(chunks.length, 24);
  assert.equal(embeddings.length, 24);
  assert.deepEqual(embeddings, repeatedEmbeddings);
  assert.deepEqual(
    syntheticRetrievalFixtureV1.sources.map(({ id }) => id),
    chunks.slice(0, syntheticRetrievalFixtureV1.sources.length).map(({ id }) => id),
  );
  assert.deepEqual(
    chunks
      .slice(
        syntheticRetrievalFixtureV1.sources.length,
        syntheticRetrievalFixtureV1.sources.length + 3,
      )
      .map(({ id }) => id),
    [
      retrievalRuntimeCanaries.updateBefore.id,
      retrievalRuntimeCanaries.unpublish.id,
      retrievalRuntimeCanaries.remove.id,
    ],
  );
  assert.ok(embeddings.every(({ vector }) => vector.length === 32));
  assert.equal(first.vectorForSourceId("unknown"), null);
});

test("one warm retriever drops updated, unpublished, and deleted canaries", async () => {
  const fixture = createRetrievalRuntimeFixture({
    chunkCount: 24,
    embeddingDimension: 32,
  });
  const retrieve = createEvidenceRetriever(fixture.source);
  const find = async (query: string) =>
    (
      await retrieve({
        workspaceId: fixture.workspaceId,
        query,
        mode: "lexical",
        topK: 5,
      })
    ).map(({ sourceId }) => sourceId);

  assert.deepEqual(await find(retrievalRuntimeCanaries.updateBefore.query), [
    retrievalRuntimeCanaries.updateBefore.id,
  ]);
  assert.deepEqual(await find(retrievalRuntimeCanaries.unpublish.query), [
    retrievalRuntimeCanaries.unpublish.id,
  ]);
  assert.deepEqual(await find(retrievalRuntimeCanaries.remove.query), [
    retrievalRuntimeCanaries.remove.id,
  ]);

  const advanced = fixture.advance();
  assert.equal(advanced.generation, 2);
  assert.deepEqual(await find(retrievalRuntimeCanaries.updateBefore.query), []);
  assert.deepEqual(await find(retrievalRuntimeCanaries.updateAfter.query), [
    retrievalRuntimeCanaries.updateAfter.id,
  ]);
  assert.deepEqual(await find(retrievalRuntimeCanaries.unpublish.query), []);
  assert.deepEqual(await find(retrievalRuntimeCanaries.remove.query), []);
});
