// ABOUTME: Verifies one deterministic retrieval contract through Postgres, Neon HTTP, and workerd.
// ABOUTME: Measures warm and rebuild latency plus native workerd RSS against the pilot corpus limit.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { neon, neonConfig } from "@neondatabase/serverless";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle as createNeonDatabase } from "drizzle-orm/neon-http";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { build } from "esbuild";
import { Pool, type FieldDef, type PoolClient, type QueryArrayResult } from "pg";

import type { MemberActor } from "@/auth/member-repository";
import type { CategoryAuthoringRepository } from "@/db/category-authoring";
import { createPostgresCategoryAuthoringRepository } from "@/db/postgres/category-authoring-repository";
import { createPostgresRepository } from "@/db/postgres/repository";
import type {
  ArticleEvidenceCommit,
  ArticleSubmission,
  Repository,
} from "@/db/repository";
import * as postgresSchema from "@/db/schema/postgres";
import { syntheticRetrievalFixtureV1 } from "@/evaluation/fixtures/synthetic-retrieval-v1";
import {
  retrievalRuntimeCalibration,
  retrievalRuntimeCanaries,
  retrievalRuntimeCorpusLimit,
  retrievalRuntimeP95,
} from "@/evaluation/retrieval-runtime";
import {
  createEvidenceRetriever,
  createRepositoryEvidenceSource,
} from "@/search/evidence";

type SeedSource = {
  id: string;
  articleId: string;
  title: string;
  evidenceText: string;
  contentHash: string;
  canonicalUrl: string;
  vector: readonly number[];
};

type SourceIdsByQuestion = Record<string, readonly string[]>;

type RetrievalVerificationRepository = Pick<
  Repository,
  | "activateEmbeddingGeneration"
  | "archiveArticle"
  | "checkHealth"
  | "claimEmbeddingJob"
  | "commitArticleEvidence"
  | "completeEmbeddingJob"
  | "createDraftArticle"
  | "createEmbeddingGeneration"
  | "emergencyPublishArticle"
  | "getIndexingState"
  | "listActiveChunkEmbeddings"
  | "listEvidenceChunks"
  | "revalidateEvidenceCandidates"
  | "saveChunkEmbeddings"
  | "saveDraftArticle"
  | "unpublishArticle"
>;

type LifecycleReport = {
  baseline: {
    updateBefore: readonly string[];
    unpublish: readonly string[];
    remove: readonly string[];
  };
  afterUpdate: {
    updateBefore: readonly string[];
    updateAfter: readonly string[];
  };
  afterUnpublish: readonly string[];
  afterDelete: readonly string[];
};

type RepositoryScenario = {
  adapter: "postgres-node" | "neon-http";
  lexicalSourceIds: SourceIdsByQuestion;
  hybridSourceIds: SourceIdsByQuestion;
  lexicalDigest: string;
  hybridDigest: string;
  answerableSourceIds: Record<string, string>;
  answerableSourceIdsDigest: string;
  answerableRecallAt5: { numerator: number; denominator: number };
  lifecycle: LifecycleReport;
};

type NeonQuery = {
  query: string;
  params?: unknown[];
};

type NeonBridge = {
  endpoint: string;
  requests(): number;
  batches(): number;
  queries(): number;
  close(): Promise<void>;
};

type WorkerdWarmBenchmarkResponse = {
  corpus: typeof retrievalRuntimeCorpusLimit;
  sourceId: string;
  warmP95Ms: number;
  warmSamples: number;
};

type WorkerdRebuildBenchmarkResponse = {
  sourceId: string;
  elapsedMs: number;
};

type WorkerdQueryResponse = {
  sourceIds: string[];
  generation: number | null;
};

type WorkerdProcess = {
  id: number;
  port: number;
  url: string;
  logPath: string;
  process: ChildProcess;
  baselineRssBytes: number;
  peakRssBytes(): number;
  stop(): Promise<void>;
};

const execFileAsync = promisify(execFile);
const workspaceId = syntheticRetrievalFixtureV1.workspaceId;
const categoryId = "runtime_category";
const categorySlug = "runtime";
const embeddingGenerationId = "runtime_embedding_generation_v1";
const sharedRuntimeSourceCount = syntheticRetrievalFixtureV1.sources.length + 3;
const createdAt = new Date("2026-08-30T00:00:00.000Z");
const activatedAt = new Date("2026-08-30T00:00:30.000Z");
const maximumRequestBytes = 16 * 1_024 * 1_024;
const readinessTimeoutMs = 60_000;
const authoringActor: MemberActor = {
  memberId: "member_runtime_author",
  sessionId: "R".repeat(43),
  workspaceId,
};
const draftActor = {
  memberId: authoringActor.memberId,
  sessionId: authoringActor.sessionId,
};

async function createRuntimeAuthor(pool: Pool) {
  const createdAt = new Date();
  await pool.query(
    `insert into workspace_members (
       id, workspace_id, normalized_email, display_name, role, status,
       password_salt, password_digest, password_iterations, created_at, updated_at
     ) values ($1, $2, 'runtime@example.test', 'Runtime author',
               'administrator', 'active', $3, $4, 600000, $5, $5)`,
    [
      authoringActor.memberId,
      workspaceId,
      "a".repeat(43),
      "b".repeat(43),
      createdAt,
    ],
  );
  await pool.query(
    `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [
      authoringActor.sessionId,
      workspaceId,
      authoringActor.memberId,
      createdAt,
      new Date(createdAt.getTime() + 7 * 60 * 60 * 1000),
    ],
  );
}

function embeddingMetadata(dimension: number) {
  return {
    provider: "openai-compatible" as const,
    model: "one-hot-v1",
    dimension,
    configurationHash: syntheticRetrievalFixtureV1.sourceContentHash,
    configuration: {
      dimensionsParameter: false,
      endpoint: "https://synthetic.opas.invalid/v1/embeddings",
    },
  };
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canarySource(
  canary: (typeof retrievalRuntimeCanaries)[keyof typeof retrievalRuntimeCanaries],
  vectorDimension: number,
): SeedSource {
  const vector = Array<number>(vectorDimension).fill(0);
  vector[vectorDimension - 1] = 1;
  return {
    ...canary,
    canonicalUrl: `https://synthetic.opas.invalid/runtime/${canary.id}`,
    vector,
  };
}

function baselineSources() {
  const vectorDimension = syntheticRetrievalFixtureV1.sources[0]?.vector.length;
  if (!vectorDimension) {
    throw new Error("The synthetic retrieval fixture has no vector dimension");
  }
  return [
    ...syntheticRetrievalFixtureV1.sources,
    canarySource(retrievalRuntimeCanaries.updateBefore, vectorDimension),
    canarySource(retrievalRuntimeCanaries.unpublish, vectorDimension),
    canarySource(retrievalRuntimeCanaries.remove, vectorDimension),
  ];
}

function slugForSource(source: SeedSource) {
  return source.id.replaceAll("_", "-");
}

function articleSubmission(
  source: SeedSource,
  position: number,
  status: ArticleSubmission["status"] = "published",
): ArticleSubmission {
  return {
    id: source.articleId,
    workspaceId,
    categoryId,
    slug: slugForSource(source),
    title: source.title,
    mdx: `# ${source.title}\n\n${source.evidenceText}`,
    status,
    isFaq: false,
    authorName: "Runtime fixture",
    position,
    publishedAt: status === "published" ? createdAt : null,
  };
}

function draftArticle(source: SeedSource, position: number) {
  const article = articleSubmission(source, position, "draft");
  return {
    authorName: article.authorName,
    categoryId: article.categoryId,
    id: article.id,
    isFaq: article.isFaq,
    mdx: article.mdx,
    position: article.position ?? position,
    slug: article.slug,
    title: article.title,
    workspaceId: article.workspaceId,
  };
}

function evidenceCommit(
  source: SeedSource,
  position: number,
  jobSuffix = "baseline",
): ArticleEvidenceCommit {
  return {
    workspaceId,
    articleId: source.articleId,
    categorySlug,
    articleContentHash: source.contentHash,
    chunks: [
      {
        id: source.id,
        contentHash: source.contentHash,
        embeddingInputHash: source.contentHash,
        ordinal: 0,
        title: source.title,
        headingPath: [source.title],
        canonicalUrl: source.canonicalUrl,
        markdown: `## ${source.title}\n\n${source.evidenceText}`,
        evidenceText: source.evidenceText,
        embeddingText: `${source.title}\n\n${source.evidenceText}`,
        sourceLineRange: { start: 1, end: 3 },
      },
    ],
    job: {
      id: `runtime_job_${position}_${jobSuffix}`,
      embeddingGenerationId,
      maximumAttempts: 3,
      availableAt: createdAt,
    },
  };
}

function repositoryRetrievalSource(repository: RetrievalVerificationRepository) {
  return createRepositoryEvidenceSource(repository);
}

async function publishFixtureRevision(
  repository: RetrievalVerificationRepository,
  source: SeedSource,
  position: number,
  jobSuffix: string,
  current?: Readonly<{ revisionId: string; revisionNumber: number }>,
) {
  const saved = current
    ? await repository.saveDraftArticle({
        actor: draftActor,
        article: draftArticle(source, position),
        assets: { hashes: [] },
        changeKind: "manual",
        changeSummary: "Retrieval lifecycle verification",
        expectedWorkingRevisionNumber: current.revisionNumber,
      })
    : await repository.createDraftArticle({
        actor: draftActor,
        article: draftArticle(source, position),
        assets: { hashes: [] },
        changeKind: "manual",
        changeSummary: "Retrieval fixture creation",
      });
  assert.equal(saved.status, "saved");
  if (saved.status !== "saved") {
    throw new Error(`Could not save retrieval fixture ${source.articleId}`);
  }
  const published = await repository.emergencyPublishArticle({
    actor: draftActor,
    articleId: source.articleId,
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: saved.revisionNumber,
    reason: "disposable retrieval verification fixture",
    revisionId: saved.revisionId,
    workspaceId,
  });
  assert.equal(published.status, "transitioned");
  if (published.status !== "transitioned") {
    throw new Error(`Could not publish retrieval fixture ${source.articleId}`);
  }
  await repository.commitArticleEvidence(
    evidenceCommit(source, position, jobSuffix),
  );
  return {
    revisionId: saved.revisionId,
    revisionNumber: saved.revisionNumber,
  };
}

async function sourceIdsForQuestions(
  retrieve: ReturnType<typeof createEvidenceRetriever>,
  mode: "lexical" | "hybrid",
) {
  const results: SourceIdsByQuestion = {};
  for (const question of syntheticRetrievalFixtureV1.questions) {
    const matches = await retrieve({
      workspaceId,
      query: question.question,
      mode,
      queryVector: mode === "hybrid" ? question.queryVector : undefined,
      topK: 5,
    });
    results[question.id] = matches.map(({ sourceId }) => sourceId);
  }
  return results;
}

function answerableRecallAt5(sourceIds: SourceIdsByQuestion) {
  const answerable = syntheticRetrievalFixtureV1.questions.filter(
    ({ classification }) => classification === "answerable",
  );
  return {
    numerator: answerable.filter((question) =>
      (sourceIds[question.id] ?? []).some((sourceId) =>
        question.acceptedSourceIds.includes(sourceId),
      ),
    ).length,
    denominator: answerable.length,
  };
}

function answerableSourceIds(sourceIds: SourceIdsByQuestion) {
  return Object.fromEntries(
    syntheticRetrievalFixtureV1.questions
      .filter(({ classification }) => classification === "answerable")
      .map((question) => {
        const accepted = (sourceIds[question.id] ?? []).find((sourceId) =>
          question.acceptedSourceIds.includes(sourceId),
        );
        assert.ok(accepted, `Answerable probe ${question.id} has no accepted source`);
        return [question.id, accepted];
      }),
  );
}

async function queryCanary(
  retrieve: ReturnType<typeof createEvidenceRetriever>,
  query: string,
) {
  return (
    await retrieve({ workspaceId, query, mode: "lexical", topK: 5 })
  ).map(({ sourceId }) => sourceId);
}

async function runRepositoryScenario(
  repository: RetrievalVerificationRepository,
  categories: CategoryAuthoringRepository,
  adapter: RepositoryScenario["adapter"],
) {
  const sources = baselineSources();
  await repository.checkHealth();
  assert.deepEqual(await categories.createCategory({
    actor: authoringActor,
    category: {
      id: categoryId,
      workspaceId,
      slug: categorySlug,
      name: "Runtime fixture",
      description: null,
      position: 0,
    },
    expectedCategoryVersion: 0,
  }), {
    status: "created",
    category: {
      id: categoryId,
      workspaceId,
      slug: categorySlug,
      name: "Runtime fixture",
      description: null,
      position: 0,
      version: 1,
    },
  });
  await repository.createEmbeddingGeneration({
    id: embeddingGenerationId,
    workspaceId,
    provider: "openai-compatible",
    model: "one-hot-v1",
    dimension: sources[0]?.vector.length ?? 0,
    configurationHash: syntheticRetrievalFixtureV1.sourceContentHash,
    status: "building",
    createdAt,
    activatedAt: null,
    retiredAt: null,
  });
  const revisions = new Map<string, Readonly<{ revisionId: string; revisionNumber: number }>>();
  for (let position = 0; position < sources.length; position += 1) {
    const source = sources[position] as SeedSource;
    revisions.set(
      source.articleId,
      await publishFixtureRevision(
        repository,
        source,
        position,
        "baseline",
      ),
    );
  }
  await repository.saveChunkEmbeddings({
    workspaceId,
    embeddingGenerationId,
    embeddings: sources.map((source) => ({
      chunkId: source.id,
      contentHash: source.contentHash,
      embeddingInputHash: source.contentHash,
      vector: source.vector,
    })),
    createdAt: activatedAt,
  });
  const completedJobs = new Set<string>();
  for (let position = 0; position < sources.length; position += 1) {
    const claimedAt = new Date(createdAt.getTime() + 1_000 + position);
    const leaseToken = `runtime_lease_${position}`;
    const job = await repository.claimEmbeddingJob({
      workspaceId,
      embeddingGenerationId,
      claimedAt,
      leaseExpiresAt: new Date(claimedAt.getTime() + 60_000),
      leaseToken,
    });
    assert.ok(job, `${adapter} did not claim fixture embedding job ${position}`);
    assert.equal(job.embeddingGenerationId, embeddingGenerationId);
    assert.equal(completedJobs.has(job.id), false);
    assert.equal(
      await repository.completeEmbeddingJob({
        workspaceId,
        id: job.id,
        leaseToken,
        checkedAt: new Date(claimedAt.getTime() + 1_000),
      }),
      true,
      `${adapter} did not complete fixture embedding job ${job.id}`,
    );
    completedJobs.add(job.id);
  }
  assert.equal(completedJobs.size, sources.length);
  assert.equal(
    await repository.activateEmbeddingGeneration({
      workspaceId,
      embeddingGenerationId,
      activatedAt,
      metadata: embeddingMetadata(sources[0]?.vector.length ?? 0),
    }),
    true,
    `${adapter} did not activate complete fixture embeddings`,
  );

  const retrieve = createEvidenceRetriever(repositoryRetrievalSource(repository));
  const lexicalSourceIds = await sourceIdsForQuestions(retrieve, "lexical");
  const hybridSourceIds = await sourceIdsForQuestions(retrieve, "hybrid");
  const lifecycle: LifecycleReport = {
    baseline: {
      updateBefore: await queryCanary(
        retrieve,
        retrievalRuntimeCanaries.updateBefore.query,
      ),
      unpublish: await queryCanary(
        retrieve,
        retrievalRuntimeCanaries.unpublish.query,
      ),
      remove: await queryCanary(
        retrieve,
        retrievalRuntimeCanaries.remove.query,
      ),
    },
    afterUpdate: { updateBefore: [], updateAfter: [] },
    afterUnpublish: [],
    afterDelete: [],
  };
  assert.deepEqual(lifecycle.baseline.updateBefore, [
    retrievalRuntimeCanaries.updateBefore.id,
  ]);
  assert.deepEqual(lifecycle.baseline.unpublish, [
    retrievalRuntimeCanaries.unpublish.id,
  ]);
  assert.deepEqual(lifecycle.baseline.remove, [retrievalRuntimeCanaries.remove.id]);

  const updatePosition = sources.findIndex(
    ({ id }) => id === retrievalRuntimeCanaries.updateBefore.id,
  );
  const currentUpdate = canarySource(
    retrievalRuntimeCanaries.updateAfter,
    sources[0]?.vector.length ?? 0,
  );
  revisions.set(
    currentUpdate.articleId,
    await publishFixtureRevision(
      repository,
      currentUpdate,
      updatePosition,
      "updated",
      revisions.get(currentUpdate.articleId),
    ),
  );
  lifecycle.afterUpdate = {
    updateBefore: await queryCanary(
      retrieve,
      retrievalRuntimeCanaries.updateBefore.query,
    ),
    updateAfter: await queryCanary(
      retrieve,
      retrievalRuntimeCanaries.updateAfter.query,
    ),
  };
  assert.deepEqual(lifecycle.afterUpdate.updateBefore, []);
  assert.deepEqual(lifecycle.afterUpdate.updateAfter, [
    retrievalRuntimeCanaries.updateAfter.id,
  ]);

  const unpublishPosition = sources.findIndex(
    ({ id }) => id === retrievalRuntimeCanaries.unpublish.id,
  );
  const unpublishSource = sources[unpublishPosition] as SeedSource;
  const unpublishRevision = revisions.get(unpublishSource.articleId);
  assert.ok(unpublishRevision);
  const unpublished = await repository.unpublishArticle({
    actor: draftActor,
    articleId: unpublishSource.articleId,
    expectedReviewState: "published",
    expectedWorkingRevisionNumber: unpublishRevision.revisionNumber,
    note: "Retrieval lifecycle verification",
    revisionId: unpublishRevision.revisionId,
    workspaceId,
  });
  assert.equal(unpublished.status, "transitioned");
  lifecycle.afterUnpublish = await queryCanary(
    retrieve,
    retrievalRuntimeCanaries.unpublish.query,
  );
  assert.deepEqual(lifecycle.afterUnpublish, []);

  const removedRevision = revisions.get(retrievalRuntimeCanaries.remove.articleId);
  assert.ok(removedRevision);
  const archived = await repository.archiveArticle({
    actor: draftActor,
    articleId: retrievalRuntimeCanaries.remove.articleId,
    expectedPublicStatus: "published",
    expectedReviewState: "published",
    expectedWorkingRevisionNumber: removedRevision.revisionNumber,
    note: "Retrieval lifecycle verification",
    revisionId: removedRevision.revisionId,
    workspaceId,
  });
  assert.equal(archived.status, "transitioned");
  lifecycle.afterDelete = await queryCanary(
    retrieve,
    retrievalRuntimeCanaries.remove.query,
  );
  assert.deepEqual(lifecycle.afterDelete, []);

  return {
    adapter,
    lexicalSourceIds,
    hybridSourceIds,
    lexicalDigest: digest(lexicalSourceIds),
    hybridDigest: digest(hybridSourceIds),
    answerableSourceIds: answerableSourceIds(lexicalSourceIds),
    answerableSourceIdsDigest: digest(answerableSourceIds(lexicalSourceIds)),
    answerableRecallAt5: answerableRecallAt5(lexicalSourceIds),
    lifecycle,
  } satisfies RepositoryScenario;
}

function rawText(value: unknown, dataTypeId: number): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (dataTypeId === 114 || dataTypeId === 3_802) {
    return JSON.stringify(value);
  }
  if (dataTypeId === 16 && typeof value === "boolean") {
    return value ? "t" : "f";
  }
  if (Buffer.isBuffer(value)) {
    return `\\x${value.toString("hex")}`;
  }
  if (value instanceof Uint8Array) {
    return `\\x${Buffer.from(value).toString("hex")}`;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function neonResult(result: QueryArrayResult<unknown[]>) {
  return {
    command: result.command,
    rowCount: result.rowCount ?? 0,
    fields: result.fields.map((field: FieldDef) => ({
      name: field.name,
      tableID: field.tableID,
      columnID: field.columnID,
      dataTypeID: field.dataTypeID,
      dataTypeSize: field.dataTypeSize,
      dataTypeModifier: field.dataTypeModifier,
      format: field.format,
    })),
    rows: result.rows.map((row) =>
      row.map((value, index) =>
        rawText(value, result.fields[index]?.dataTypeID ?? 0),
      ),
    ),
  };
}

async function readRequest(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maximumRequestBytes) {
      throw new Error("Neon bridge request exceeds the local harness limit");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function validNeonQuery(value: unknown): value is NeonQuery {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as NeonQuery).query === "string" &&
    ((value as NeonQuery).params === undefined ||
      Array.isArray((value as NeonQuery).params))
  );
}

async function executeNeonQuery(client: PoolClient, query: NeonQuery) {
  return neonResult(
    await client.query<unknown[]>({
      text: query.query,
      values: query.params ?? [],
      rowMode: "array",
    }),
  );
}

async function startNeonBridge(pool: Pool): Promise<NeonBridge> {
  let requestCount = 0;
  let batchCount = 0;
  let queryCount = 0;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") {
        sendJson(response, 405, { message: "POST is required" });
        return;
      }
      requestCount += 1;
      const body = await readRequest(request);
      const client = await pool.connect();
      try {
        if (
          typeof body === "object" &&
          body !== null &&
          Array.isArray((body as { queries?: unknown }).queries)
        ) {
          const queries = (body as { queries: unknown[] }).queries;
          if (!queries.every(validNeonQuery)) {
            throw new Error("Neon bridge received an invalid batch query");
          }
          batchCount += 1;
          queryCount += queries.length;
          await client.query("begin");
          try {
            const results = [];
            for (const query of queries) {
              results.push(await executeNeonQuery(client, query));
            }
            await client.query("commit");
            sendJson(response, 200, { results });
          } catch (error) {
            await client.query("rollback");
            throw error;
          }
          return;
        }
        if (!validNeonQuery(body)) {
          throw new Error("Neon bridge received an invalid query");
        }
        queryCount += 1;
        sendJson(response, 200, await executeNeonQuery(client, body));
      } finally {
        client.release();
      }
    })().catch((error: unknown) => {
      const databaseError = error as Error & {
        code?: string;
        detail?: string;
        hint?: string;
        severity?: string;
      };
      if (!response.headersSent) {
        sendJson(response, 400, {
          message: databaseError.message,
          code: databaseError.code,
          detail: databaseError.detail,
          hint: databaseError.hint,
          severity: databaseError.severity,
        });
      } else {
        response.destroy(databaseError);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Neon bridge did not expose a TCP address");
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}/sql`,
    requests: () => requestCount,
    batches: () => batchCount,
    queries: () => queryCount,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

async function freeTcpPort() {
  const server = createTcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("A local workerd port could not be allocated");
  }
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

function resolveWorkerdExecutable() {
  const launcherPath = path.join(process.cwd(), "node_modules/.bin/workerd");
  const launcher = readFileSync(launcherPath, "utf8");
  const executableMatch = launcher.match(/"\$basedir\/([^"]*\/bin\/workerd)"/u);
  if (!executableMatch?.[1]) {
    throw new Error("The installed workerd executable could not be resolved");
  }
  return realpathSync(path.resolve(path.dirname(launcherPath), executableMatch[1]));
}

async function sampleRssBytes(processId: number) {
  const { stdout } = await execFileAsync("ps", [
    "-o",
    "rss=",
    "-p",
    String(processId),
  ]);
  const kilobytes = Number(stdout.trim());
  return Number.isFinite(kilobytes) ? kilobytes * 1_024 : 0;
}

async function waitForWorkerd(process: ChildProcess, url: string, logPath: string) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < readinessTimeoutMs) {
    if (process.exitCode !== null) {
      throw new Error(`workerd exited before readiness; inspect ${logPath}`);
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "describe" }),
      });
      if (response.ok) {
        return;
      }
      lastError = new Error(`workerd readiness returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `workerd did not become ready: ${String(lastError)}; inspect ${logPath}`,
  );
}

async function startWorkerd(
  id: number,
  executable: string,
  configPath: string,
  logDirectory: string,
): Promise<WorkerdProcess> {
  const port = await freeTcpPort();
  const url = `http://127.0.0.1:${port}`;
  const logPath = path.join(logDirectory, `workerd-${id}.log`);
  const log = createWriteStream(logPath, { flags: "wx" });
  await once(log, "open");
  const child = spawn(
    executable,
    ["serve", `-shttp=127.0.0.1:${port}`, configPath, "config"],
    { stdio: ["ignore", log, log] },
  );
  let peakRssBytes = 0;
  let sampling = true;
  let stopped = false;
  const samplingLoop = (async () => {
    while (sampling && child.exitCode === null) {
      try {
        peakRssBytes = Math.max(peakRssBytes, await sampleRssBytes(child.pid as number));
      } catch {
        if (child.exitCode !== null) {
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  try {
    await waitForWorkerd(child, url, logPath);
  } catch (error) {
    sampling = false;
    child.kill("SIGTERM");
    await samplingLoop;
    log.end();
    throw error;
  }
  const baselineRssBytes = await sampleRssBytes(child.pid as number);
  peakRssBytes = Math.max(peakRssBytes, baselineRssBytes);
  return {
    id,
    port,
    url,
    logPath,
    process: child,
    baselineRssBytes,
    peakRssBytes: () => peakRssBytes,
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      sampling = false;
      await samplingLoop;
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          once(child, "exit"),
          new Promise((resolve) => setTimeout(resolve, 3_000)),
        ]);
      }
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      log.end();
      await once(log, "finish");
    },
  };
}

async function postWorkerd<T>(runtime: WorkerdProcess, body: unknown): Promise<T> {
  const response = await fetch(runtime.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `workerd ${runtime.id} returned HTTP ${response.status}: ${responseText}; inspect ${runtime.logPath}`,
    );
  }
  return JSON.parse(responseText) as T;
}

async function workerdSourceIds(runtime: WorkerdProcess) {
  const sourceIds: SourceIdsByQuestion = {};
  for (const question of syntheticRetrievalFixtureV1.questions) {
    const response = await postWorkerd<WorkerdQueryResponse>(runtime, {
      action: "query",
      query: question.question,
      mode: "lexical",
      topK: 5,
    });
    sourceIds[question.id] = response.sourceIds;
  }
  return sourceIds;
}

async function runWorkerdParityScenario(
  runtime: WorkerdProcess,
  expectedLexicalSourceIds: SourceIdsByQuestion,
) {
  const sourceIds = await workerdSourceIds(runtime);
  assert.deepEqual(
    sourceIds,
    expectedLexicalSourceIds,
    `workerd parity isolate ${runtime.id} top-five source IDs differ from Postgres`,
  );
  return {
    id: runtime.id,
    questionCount: Object.keys(sourceIds).length,
    lexicalDigest: digest(sourceIds),
    exactTopFiveParity: true,
  };
}

async function runWorkerdScenario(
  runtime: WorkerdProcess,
  expectedLexicalSourceIds: SourceIdsByQuestion,
) {
  const sourceIds = await workerdSourceIds(runtime);
  assert.deepEqual(
    answerableSourceIds(sourceIds),
    answerableSourceIds(expectedLexicalSourceIds),
    `workerd ${runtime.id} answerable source IDs differ from Postgres`,
  );

  async function canary(query: string) {
    return (
      await postWorkerd<WorkerdQueryResponse>(runtime, {
        action: "query",
        query,
        mode: "lexical",
        topK: 5,
      })
    ).sourceIds;
  }

  const lifecycle: LifecycleReport = {
    baseline: {
      updateBefore: await canary(retrievalRuntimeCanaries.updateBefore.query),
      unpublish: await canary(retrievalRuntimeCanaries.unpublish.query),
      remove: await canary(retrievalRuntimeCanaries.remove.query),
    },
    afterUpdate: { updateBefore: [], updateAfter: [] },
    afterUnpublish: [],
    afterDelete: [],
  };
  assert.deepEqual(lifecycle.baseline.updateBefore, [
    retrievalRuntimeCanaries.updateBefore.id,
  ]);
  assert.deepEqual(lifecycle.baseline.unpublish, [
    retrievalRuntimeCanaries.unpublish.id,
  ]);
  assert.deepEqual(lifecycle.baseline.remove, [retrievalRuntimeCanaries.remove.id]);

  const warmBenchmark = await postWorkerd<WorkerdWarmBenchmarkResponse>(runtime, {
    action: "benchmark-warm",
  });
  assert.deepEqual(warmBenchmark.corpus, retrievalRuntimeCorpusLimit);
  assert.equal(
    warmBenchmark.warmSamples,
    retrievalRuntimeCorpusLimit.warmSamples,
  );

  await postWorkerd(runtime, { action: "advance" });
  lifecycle.afterUpdate = {
    updateBefore: await canary(retrievalRuntimeCanaries.updateBefore.query),
    updateAfter: await canary(retrievalRuntimeCanaries.updateAfter.query),
  };
  lifecycle.afterUnpublish = await canary(
    retrievalRuntimeCanaries.unpublish.query,
  );
  lifecycle.afterDelete = await canary(retrievalRuntimeCanaries.remove.query);
  assert.deepEqual(lifecycle.afterUpdate.updateBefore, []);
  assert.deepEqual(lifecycle.afterUpdate.updateAfter, [
    retrievalRuntimeCanaries.updateAfter.id,
  ]);
  assert.deepEqual(lifecycle.afterUnpublish, []);
  assert.deepEqual(lifecycle.afterDelete, []);

  return {
    id: runtime.id,
    lexicalDigest: digest(sourceIds),
    answerableSourceIds: answerableSourceIds(sourceIds),
    answerableSourceIdsDigest: digest(answerableSourceIds(sourceIds)),
    lifecycle,
    warmBenchmark,
  };
}

async function runRebuildSample(runtime: WorkerdProcess) {
  const primed = await postWorkerd<{ sourceId: string }>(runtime, {
    action: "benchmark-rebuild-prime",
  });
  const rebuilt = await postWorkerd<WorkerdRebuildBenchmarkResponse>(runtime, {
    action: "benchmark-rebuild",
  });
  assert.equal(rebuilt.sourceId, primed.sourceId);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return rebuilt;
}

async function prepareWorkerdBundle(
  logDirectory: string,
  label: "capacity" | "parity",
  chunkCount: number,
) {
  const moduleName = `retrieval-workerd-${label}.js`;
  const workerPath = path.join(logDirectory, moduleName);
  await build({
    entryPoints: [path.join(process.cwd(), "scripts/retrieval-workerd.ts")],
    outfile: workerPath,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "info",
    define: {
      RETRIEVAL_RUNTIME_CHUNK_COUNT: JSON.stringify(chunkCount),
    },
  });
  const configPath = path.join(logDirectory, `workerd-${label}.capnp`);
  await writeFile(
    configPath,
    `using Workerd = import "/workerd/workerd.capnp";\n\nconst config :Workerd.Config = (\n  services = [(\n    name = "runtime",\n    worker = (\n      modules = [(name = "${moduleName}", esModule = embed "${moduleName}")],\n      compatibilityDate = "2026-08-27",\n    ),\n  )],\n  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "runtime")],\n);\n`,
    "utf8",
  );
  return configPath;
}

async function main() {
  const logDirectory = await mkdtemp(
    path.join(tmpdir(), "opas-retrieval-runtime-"),
  );
  const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const runtimes: WorkerdProcess[] = [];
  let bridge: NeonBridge | null = null;
  const previousFetchEndpoint = neonConfig.fetchEndpoint;
  try {
    const postgresDatabase = createPostgresDatabase(pool, {
      schema: postgresSchema,
    });
    await migratePostgres(postgresDatabase, {
      migrationsFolder: path.join(process.cwd(), "drizzle/postgres"),
    });

    await postgresDatabase.insert(postgresSchema.workspaces).values({
      id: workspaceId,
      slug: "runtime-postgres",
      name: "Runtime Postgres",
    });
    await createRuntimeAuthor(pool);
    const postgres = await runRepositoryScenario(
      createPostgresRepository(postgresDatabase),
      createPostgresCategoryAuthoringRepository(postgresDatabase),
      "postgres-node",
    );
    await pool.query("delete from workspaces where id = $1", [workspaceId]);

    bridge = await startNeonBridge(pool);
    neonConfig.fetchEndpoint = bridge.endpoint;
    const neonDatabase = createNeonDatabase(neon(container.getConnectionUri()), {
      schema: postgresSchema,
    });
    await neonDatabase.insert(postgresSchema.workspaces).values({
      id: workspaceId,
      slug: "runtime-neon",
      name: "Runtime Neon",
    });
    await createRuntimeAuthor(pool);
    const neonScenario = await runRepositoryScenario(
      createPostgresRepository(neonDatabase),
      createPostgresCategoryAuthoringRepository(neonDatabase),
      "neon-http",
    );
    assert.deepEqual(
      neonScenario.lexicalSourceIds,
      postgres.lexicalSourceIds,
      "Neon lexical source IDs differ from local Postgres",
    );
    assert.deepEqual(
      neonScenario.hybridSourceIds,
      postgres.hybridSourceIds,
      "Neon hybrid source IDs differ from local Postgres",
    );

    const parityWorkerdConfigPath = await prepareWorkerdBundle(
      logDirectory,
      "parity",
      sharedRuntimeSourceCount,
    );
    const capacityWorkerdConfigPath = await prepareWorkerdBundle(
      logDirectory,
      "capacity",
      retrievalRuntimeCorpusLimit.chunkCount,
    );
    const workerdExecutable = resolveWorkerdExecutable();
    for (let id = 1; id <= retrievalRuntimeCorpusLimit.isolateCount; id += 1) {
      runtimes.push(
        await startWorkerd(
          id,
          workerdExecutable,
          parityWorkerdConfigPath,
          logDirectory,
        ),
      );
    }
    const parityRuntimes = [...runtimes];
    const parityWorkerdResults = await Promise.all(
      parityRuntimes.map((runtime) =>
        runWorkerdParityScenario(runtime, postgres.lexicalSourceIds),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const runtime of parityRuntimes) {
      await runtime.stop();
    }

    const capacityRuntimes: WorkerdProcess[] = [];
    for (let id = 11; id < 11 + retrievalRuntimeCorpusLimit.isolateCount; id += 1) {
      const runtime = await startWorkerd(
        id,
        workerdExecutable,
        capacityWorkerdConfigPath,
        logDirectory,
      );
      capacityRuntimes.push(runtime);
      runtimes.push(runtime);
    }
    const capacityWorkerdResults = await Promise.all(
      capacityRuntimes.map((runtime) =>
        runWorkerdScenario(runtime, postgres.lexicalSourceIds),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rebuildSamples: Array<{
      id: number;
      elapsedMs: number;
      baselineRssBytes: number;
      peakRssBytes: number;
      logPath: string;
    }> = [];
    for (
      let sample = 0;
      sample < retrievalRuntimeCorpusLimit.rebuildSamples;
      sample += 1
    ) {
      const runtime = await startWorkerd(
        101 + sample,
        workerdExecutable,
        capacityWorkerdConfigPath,
        logDirectory,
      );
      runtimes.push(runtime);
      const rebuilt = await runRebuildSample(runtime);
      rebuildSamples.push({
        id: runtime.id,
        elapsedMs: rebuilt.elapsedMs,
        baselineRssBytes: runtime.baselineRssBytes,
        peakRssBytes: runtime.peakRssBytes(),
        logPath: runtime.logPath,
      });
      await runtime.stop();
    }
    const workerdPeakRssBytes = runtimes.map((runtime) => ({
      id: runtime.id,
      baselineRssBytes: runtime.baselineRssBytes,
      peakRssBytes: runtime.peakRssBytes(),
      logPath: runtime.logPath,
    }));
    const maximumWorkerdPeakRssBytes = Math.max(
      ...workerdPeakRssBytes.map(({ peakRssBytes }) => peakRssBytes),
    );

    const report = {
      status:
        maximumWorkerdPeakRssBytes <=
        retrievalRuntimeCorpusLimit.maximumPeakRssBytes
          ? "passed"
          : "failed-memory-limit",
      generatedAt: new Date().toISOString(),
      fixture: {
        id: syntheticRetrievalFixtureV1.id,
        version: syntheticRetrievalFixtureV1.version,
        provenance: syntheticRetrievalFixtureV1.provenance,
        questionCount: syntheticRetrievalFixtureV1.questions.length,
        sharedSourceCount: sharedRuntimeSourceCount,
      },
      corpusLimit: retrievalRuntimeCorpusLimit,
      calibration: retrievalRuntimeCalibration,
      repositories: [postgres, neonScenario].map((scenario) => ({
        adapter: scenario.adapter,
        lexicalDigest: scenario.lexicalDigest,
        hybridDigest: scenario.hybridDigest,
        answerableSourceIds: scenario.answerableSourceIds,
        answerableSourceIdsDigest: scenario.answerableSourceIdsDigest,
        answerableRecallAt5: scenario.answerableRecallAt5,
        lifecycle: scenario.lifecycle,
      })),
      neonBridge: {
        endpoint: bridge.endpoint,
        requests: bridge.requests(),
        batches: bridge.batches(),
        queries: bridge.queries(),
      },
      workerd: {
        executable: workerdExecutable,
        logDirectory,
        parityIsolates: parityWorkerdResults.map((result) => ({
          ...result,
          baselineRssBytes:
            workerdPeakRssBytes.find(({ id }) => id === result.id)
              ?.baselineRssBytes ?? 0,
          peakRssBytes:
            workerdPeakRssBytes.find(({ id }) => id === result.id)
              ?.peakRssBytes ?? 0,
        })),
        capacityIsolates: capacityWorkerdResults.map((result) => ({
          ...result,
          peakRssBytes:
            workerdPeakRssBytes.find(({ id }) => id === result.id)
              ?.peakRssBytes ?? 0,
          baselineRssBytes:
            workerdPeakRssBytes.find(({ id }) => id === result.id)
              ?.baselineRssBytes ?? 0,
        })),
        rebuildBenchmark: {
          p95Ms: retrievalRuntimeP95(
            rebuildSamples.map(({ elapsedMs }) => elapsedMs),
          ),
          samples: rebuildSamples,
        },
        maximumPeakRssBytes: maximumWorkerdPeakRssBytes,
        memoryLimitBytes: retrievalRuntimeCorpusLimit.maximumPeakRssBytes,
      },
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (
      maximumWorkerdPeakRssBytes >
      retrievalRuntimeCorpusLimit.maximumPeakRssBytes
    ) {
      throw new Error(
        `workerd peak RSS ${maximumWorkerdPeakRssBytes} exceeds ${retrievalRuntimeCorpusLimit.maximumPeakRssBytes} bytes`,
      );
    }
  } finally {
    neonConfig.fetchEndpoint = previousFetchEndpoint;
    for (const runtime of runtimes) {
      await runtime.stop();
    }
    if (bridge) {
      await bridge.close();
    }
    await pool.end();
    await container.stop();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
