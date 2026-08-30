// ABOUTME: Serves the deterministic retrieval corpus inside a standalone workerd process.
// ABOUTME: Exposes parity, lifecycle, and cached-index latency checks to the local runtime harness.
import {
  createRetrievalRuntimeFixture,
  retrievalRuntimeCorpusLimit,
  retrievalRuntimeP95,
} from "@/evaluation/retrieval-runtime";
import {
  createEvidenceRetriever,
  type EvidenceRetrievalMode,
} from "@/search/evidence";

type RequestBody = {
  action?: unknown;
  query?: unknown;
  mode?: unknown;
  sourceId?: unknown;
  topK?: unknown;
};

declare const RETRIEVAL_RUNTIME_CHUNK_COUNT: number;

const runtimeChunkCount =
  typeof RETRIEVAL_RUNTIME_CHUNK_COUNT === "number"
    ? RETRIEVAL_RUNTIME_CHUNK_COUNT
    : retrievalRuntimeCorpusLimit.chunkCount;
const runtimeCorpus = Object.freeze({
  ...retrievalRuntimeCorpusLimit,
  chunkCount: runtimeChunkCount,
});
const fixture = createRetrievalRuntimeFixture({ chunkCount: runtimeChunkCount });
const retrieve = createEvidenceRetriever(fixture.source);
const benchmarkSourceId = "source_password_reset";
const benchmarkQuery = "How long is a password reset link valid?";
const benchmarkVector = fixture.vectorForSourceId(benchmarkSourceId);
let rebuildGeneration = 10_000;

if (!benchmarkVector) {
  throw new Error("Runtime benchmark vector is unavailable");
}

const benchmarkRequest = {
  workspaceId: fixture.workspaceId,
  query: benchmarkQuery,
  mode: "hybrid" as const,
  queryVector: benchmarkVector,
  topK: 5,
};
const rebuildSource = {
  ...fixture.source,
  async getIndexingState(workspaceId: string) {
    const state = await fixture.source.getIndexingState(workspaceId);
    return state ? { ...state, generation: rebuildGeneration } : null;
  },
  async revalidateEvidenceCandidates(
    requestToValidate: Parameters<
      typeof fixture.source.revalidateEvidenceCandidates
    >[0],
  ) {
    const state = await fixture.source.getIndexingState(
      requestToValidate.workspaceId,
    );
    if (!state) {
      return [];
    }
    return fixture.source.revalidateEvidenceCandidates({
      ...requestToValidate,
      generation: state.generation,
    });
  },
};
const rebuildRetrieve = createEvidenceRetriever(rebuildSource);

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function validMode(value: unknown): value is EvidenceRetrievalMode {
  return value === "lexical" || value === "vector" || value === "hybrid";
}

async function query(body: RequestBody) {
  if (typeof body.query !== "string") {
    return json({ error: "A retrieval query is required" }, 400);
  }
  const mode = body.mode === undefined ? "lexical" : body.mode;
  if (!validMode(mode)) {
    return json({ error: "The retrieval mode is invalid" }, 400);
  }
  const queryVector =
    mode === "lexical" && body.sourceId === undefined
      ? undefined
      : typeof body.sourceId === "string"
        ? fixture.vectorForSourceId(body.sourceId)
        : null;
  if (mode !== "lexical" && queryVector === null) {
    return json({ error: "A known vector source ID is required" }, 400);
  }
  const results = await retrieve({
    workspaceId: fixture.workspaceId,
    query: body.query,
    mode,
    queryVector: queryVector ?? undefined,
    topK: typeof body.topK === "number" ? body.topK : 5,
  });
  return json({
    sourceIds: results.map(({ sourceId }) => sourceId),
    generation: results[0]?.indexGeneration ?? null,
  });
}

async function benchmarkWarm() {
  const warmup = await retrieve(benchmarkRequest);
  if (warmup[0]?.sourceId !== benchmarkSourceId) {
    throw new Error("Runtime benchmark source was not retrieved during warmup");
  }

  const warmDurations: number[] = [];
  for (let sample = 0; sample < retrievalRuntimeCorpusLimit.warmSamples; sample += 1) {
    const startedAt = performance.now();
    const results = await retrieve(benchmarkRequest);
    warmDurations.push(performance.now() - startedAt);
    if (results[0]?.sourceId !== benchmarkSourceId) {
      throw new Error("Runtime benchmark source changed during a warm query");
    }
  }
  return json({
    corpus: runtimeCorpus,
    sourceId: benchmarkSourceId,
    warmP95Ms: retrievalRuntimeP95(warmDurations),
    warmSamples: warmDurations.length,
  });
}

async function benchmarkRebuild() {
  rebuildGeneration += 1;
  const startedAt = performance.now();
  const results = await rebuildRetrieve(benchmarkRequest);
  const elapsedMs = performance.now() - startedAt;
  if (results[0]?.sourceId !== benchmarkSourceId) {
    throw new Error("Runtime benchmark source changed after an index rebuild");
  }
  return json({ sourceId: benchmarkSourceId, elapsedMs });
}

async function primeBenchmarkRebuild() {
  const results = await rebuildRetrieve(benchmarkRequest);
  if (results[0]?.sourceId !== benchmarkSourceId) {
    throw new Error("Runtime benchmark source changed while priming an index");
  }
  return json({ sourceId: benchmarkSourceId });
}

const runtimeWorker = {
  async fetch(request: Request) {
    if (request.method !== "POST") {
      return json({ error: "POST is required" }, 405);
    }
    let body: RequestBody;
    try {
      body = (await request.json()) as RequestBody;
    } catch {
      return json({ error: "A JSON request body is required" }, 400);
    }
    try {
      if (body.action === "query") {
        return await query(body);
      }
      if (body.action === "advance") {
        return json({ state: fixture.advance() });
      }
      if (body.action === "benchmark-warm") {
        return await benchmarkWarm();
      }
      if (body.action === "benchmark-rebuild") {
        return await benchmarkRebuild();
      }
      if (body.action === "benchmark-rebuild-prime") {
        return await primeBenchmarkRebuild();
      }
      if (body.action === "describe") {
        return json({
          workspaceId: fixture.workspaceId,
          corpus: runtimeCorpus,
        });
      }
      return json({ error: "The runtime action is invalid" }, 400);
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error ? error.message : "Runtime retrieval failed",
        },
        500,
      );
    }
  },
};

export default runtimeWorker;
