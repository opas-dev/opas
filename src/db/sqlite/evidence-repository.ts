// ABOUTME: Stores versioned evidence, embeddings, jobs, and evaluations in SQLite and D1.
// ABOUTME: Keeps publication invalidation and retry checkpoints atomic within each deployment driver.
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AnyD1Database, DrizzleD1Database } from "drizzle-orm/d1";

import {
  validateArticleEvidenceInitialization,
  validateArticleEvidenceInitializationQuery,
  validateChunkEmbeddingBatch,
  validateEmbeddingGenerationActivation,
  validateEmbeddingGenerationReconciliation,
  validateEmbeddingGeneration,
  validateEmbeddingJobBatch,
  validateEmbeddingJobCheckpoint,
  validateEmbeddingJobClaim,
  validateEmbeddingJobCompletion,
  validateEmbeddingJobFailure,
  validateEmbeddingJobRetry,
  validateEmbeddingJobWorkRequest,
  validateEvaluationRunCompletion,
  validateEvaluationRunStart,
  validateEvidenceCandidateRevalidation,
  validateEvidenceCommit,
  validateQuestionSet,
} from "@/db/evidence";
import type {
  EmbeddingWorkerGeneration,
  EmbeddingWorkerJob,
  EmbeddingWorkerWork,
} from "@/ai/embedding-worker";
import type {
  ActiveChunkEmbedding,
  ArticleEvidenceCommit,
  ArticleEvidenceInitialization,
  EvidenceChunkRecord,
  EvidenceRepository,
  SavedQuestion,
} from "@/db/repository";
import {
  articles,
  categories,
  chunkEmbeddings,
  embeddingGenerations,
  embeddingJobs,
  evaluationRuns,
  evidenceChunks,
  savedQuestionSets,
  workspaceIndexStates,
} from "@/db/schema/sqlite";
import type * as schema from "@/db/schema/sqlite";

type D1BackedDatabase = DrizzleD1Database<typeof schema> & {
  $client: AnyD1Database;
};

type SqliteDatabase = D1BackedDatabase | BetterSQLite3Database<typeof schema>;

const evidenceOrdinalOffset = 1_000_000;
const embeddingWorkMaximumChunks = 256;

function exactUnindexedArticle(
  initialization: ArticleEvidenceInitialization,
) {
  const { article } = initialization;
  return sql`
    articles.id = ${article.id}
    and articles.workspace_id = ${article.workspaceId}
    and articles.category_id = ${article.categoryId}
    and articles.slug = ${article.slug}
    and articles.title = ${article.title}
    and articles.mdx = ${article.mdx}
    and articles.status = 'published'
    and articles.content_hash is null
    and categories.id = articles.category_id
    and categories.workspace_id = articles.workspace_id
    and categories.slug = ${article.categorySlug}
  `;
}

export function articleEvidenceInitializationStatements(
  database: SqliteDatabase,
  initialization: ArticleEvidenceInitialization,
) {
  const exactArticle = exactUnindexedArticle(initialization);
  return [
    sql`
      select case when exists (
        select 1
        from articles
        inner join categories on categories.id = articles.category_id
        where ${exactArticle}
      ) then json_extract('1', '$') else json_extract('invalid', '$') end
    `,
    ...articleEvidenceCommitStatements(
      database,
      [initialization.evidence],
      initialization.initializedAt,
    ),
  ];
}

function isArticleEvidenceInitializationConflict(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (current instanceof Error && /malformed JSON/iu.test(current.message)) {
      return true;
    }
    if (typeof current !== "object" || current === null) {
      return false;
    }
    current = "cause" in current ? current.cause : null;
  }
  return false;
}

const indexingStateFields = {
  workspaceId: workspaceIndexStates.workspaceId,
  generation: workspaceIndexStates.generation,
  activeEmbeddingGenerationId: workspaceIndexStates.activeEmbeddingGenerationId,
  updatedAt: workspaceIndexStates.updatedAt,
};

const generationFields = {
  id: embeddingGenerations.id,
  workspaceId: embeddingGenerations.workspaceId,
  provider: embeddingGenerations.provider,
  model: embeddingGenerations.model,
  dimension: embeddingGenerations.dimension,
  configurationHash: embeddingGenerations.configurationHash,
  status: embeddingGenerations.status,
  createdAt: embeddingGenerations.createdAt,
  activatedAt: embeddingGenerations.activatedAt,
  retiredAt: embeddingGenerations.retiredAt,
};

const jobFields = {
  id: embeddingJobs.id,
  workspaceId: embeddingJobs.workspaceId,
  articleId: embeddingJobs.articleId,
  articleContentHash: embeddingJobs.articleContentHash,
  embeddingGenerationId: embeddingJobs.embeddingGenerationId,
  indexGeneration: embeddingJobs.indexGeneration,
  status: embeddingJobs.status,
  attempts: embeddingJobs.attempts,
  maximumAttempts: embeddingJobs.maximumAttempts,
  checkpoint: embeddingJobs.checkpoint,
  availableAt: embeddingJobs.availableAt,
  leaseToken: embeddingJobs.leaseToken,
  leaseExpiresAt: embeddingJobs.leaseExpiresAt,
  lastErrorCode: embeddingJobs.lastErrorCode,
  createdAt: embeddingJobs.createdAt,
  updatedAt: embeddingJobs.updatedAt,
  completedAt: embeddingJobs.completedAt,
};

function isD1Database(
  database: SqliteDatabase,
): database is D1BackedDatabase {
  return "batch" in database && "$client" in database;
}

async function executeAtomically(database: SqliteDatabase, statements: SQL[]) {
  if (statements.length === 0) {
    return;
  }

  if (isD1Database(database)) {
    const queries = statements.map((statement) => {
      const query = database.run(statement).getQuery();
      return database.$client.prepare(query.sql).bind(...query.params);
    });
    await database.$client.batch(queries);
    return;
  }

  database.transaction((transaction) => {
    for (const statement of statements) {
      transaction.run(statement);
    }
  });
}

function evidenceRows(rows: Array<typeof evidenceChunks.$inferSelect>): EvidenceChunkRecord[] {
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    articleId: row.articleId,
    articleContentHash: row.articleContentHash,
    contentHash: row.contentHash,
    embeddingInputHash: row.embeddingInputHash,
    indexGeneration: row.indexGeneration,
    ordinal: row.ordinal,
    title: row.title,
    headingPath: row.headingPath,
    canonicalUrl: row.canonicalUrl,
    markdown: row.markdown,
    evidenceText: row.evidenceText,
    embeddingText: row.embeddingText,
    sourceLineRange: {
      start: row.sourceLineStart,
      end: row.sourceLineEnd,
    },
    publicationState: row.publicationState,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export function articleEvidenceCommitStatements(
  database: SqliteDatabase,
  commits: readonly ArticleEvidenceCommit[],
  changedAt: Date,
) {
  if (commits.length === 0) {
    return [];
  }

  const executableDatabase = database as DrizzleD1Database<typeof schema>;
  const workspaceId = commits[0]?.workspaceId;
  const articleIds = new Set<string>();
  const jobIds = new Set<string>();
  for (const commit of commits) {
    validateEvidenceCommit(commit);
    if (
      commit.workspaceId !== workspaceId ||
      articleIds.has(commit.articleId) ||
      jobIds.has(commit.job.id)
    ) {
      throw new Error("Evidence publication requires one workspace and unique articles and jobs");
    }
    articleIds.add(commit.articleId);
    jobIds.add(commit.job.id);
  }

  const serializedCommits = JSON.stringify(
    commits.map((commit) => ({
      ...commit,
      job: {
        ...commit.job,
        availableAt: commit.job.availableAt.getTime(),
      },
    })),
  );
  const changedAtTimestamp = changedAt.getTime();
  return [
    executableDatabase
      .insert(workspaceIndexStates)
      .values({
        workspaceId: workspaceId as string,
        generation: 1,
        updatedAt: changedAt,
      })
      .onConflictDoUpdate({
        target: workspaceIndexStates.workspaceId,
        set: {
          generation: sql`${workspaceIndexStates.generation} + 1`,
          updatedAt: changedAt,
        },
      })
      .getSQL(),
    sql`
      update articles
      set content_hash = (
        select json_extract(publication.value, '$.articleContentHash')
        from json_each(${serializedCommits}) as publication
        where json_extract(publication.value, '$.articleId') = articles.id
      )
      where workspace_id = ${workspaceId as string}
        and status = 'published'
        and id in (
          select json_extract(value, '$.articleId')
          from json_each(${serializedCommits})
        )
    `,
    sql`
      select case when not exists (
        select 1
        from json_each(${serializedCommits}) as publication
        where not exists (
          select 1
          from articles
          inner join categories on categories.id = articles.category_id
          where articles.id = json_extract(publication.value, '$.articleId')
            and articles.workspace_id = json_extract(publication.value, '$.workspaceId')
            and articles.status = 'published'
            and articles.content_hash = json_extract(publication.value, '$.articleContentHash')
            and categories.workspace_id = articles.workspace_id
            and categories.slug = json_extract(publication.value, '$.categorySlug')
        )
      ) then 1 else json('invalid article evidence') end
    `,
    sql`
      update embedding_jobs
      set status = 'superseded',
          lease_token = null,
          lease_expires_at = null,
          completed_at = ${changedAtTimestamp},
          updated_at = ${changedAtTimestamp}
      where workspace_id = ${workspaceId as string}
        and article_id in (
          select json_extract(value, '$.articleId')
          from json_each(${serializedCommits})
        )
        and status in ('pending', 'leased', 'retryable')
    `,
    sql`
      update evidence_chunks
      set ordinal = ordinal + ${evidenceOrdinalOffset}
      where workspace_id = ${workspaceId as string}
        and article_id in (
          select json_extract(value, '$.articleId')
          from json_each(${serializedCommits})
        )
    `,
    sql`
      delete from evidence_chunks as stored
      where stored.workspace_id = ${workspaceId as string}
        and stored.article_id in (
          select json_extract(value, '$.articleId')
          from json_each(${serializedCommits})
        )
        and not exists (
          select 1
          from json_each(${serializedCommits}) as publication
          inner join json_each(publication.value, '$.chunks') as incoming
          where json_extract(publication.value, '$.articleId') = stored.article_id
            and json_extract(incoming.value, '$.id') = stored.id
            and json_extract(incoming.value, '$.contentHash') = stored.content_hash
            and json_extract(incoming.value, '$.embeddingInputHash') = stored.embedding_input_hash
        )
    `,
    sql`
      insert into evidence_chunks (
        id,
        workspace_id,
        article_id,
        article_content_hash,
        content_hash,
        embedding_input_hash,
        index_generation,
        ordinal,
        title,
        heading_path,
        canonical_url,
        markdown,
        evidence_text,
        embedding_text,
        source_line_start,
        source_line_end,
        publication_state,
        created_at,
        updated_at
      )
      select
        json_extract(incoming.value, '$.id'),
        json_extract(publication.value, '$.workspaceId'),
        json_extract(publication.value, '$.articleId'),
        json_extract(publication.value, '$.articleContentHash'),
        json_extract(incoming.value, '$.contentHash'),
        json_extract(incoming.value, '$.embeddingInputHash'),
        (
          select generation from workspace_index_states
          where workspace_id = ${workspaceId as string}
        ),
        json_extract(incoming.value, '$.ordinal'),
        json_extract(incoming.value, '$.title'),
        json_extract(incoming.value, '$.headingPath'),
        json_extract(incoming.value, '$.canonicalUrl'),
        json_extract(incoming.value, '$.markdown'),
        json_extract(incoming.value, '$.evidenceText'),
        json_extract(incoming.value, '$.embeddingText'),
        json_extract(incoming.value, '$.sourceLineRange.start'),
        json_extract(incoming.value, '$.sourceLineRange.end'),
        'published',
        ${changedAtTimestamp},
        ${changedAtTimestamp}
      from json_each(${serializedCommits}) as publication
      inner join json_each(publication.value, '$.chunks') as incoming
      where true
      on conflict (id) do update set
        article_content_hash = excluded.article_content_hash,
        index_generation = excluded.index_generation,
        ordinal = excluded.ordinal,
        title = excluded.title,
        heading_path = excluded.heading_path,
        canonical_url = excluded.canonical_url,
        markdown = excluded.markdown,
        evidence_text = excluded.evidence_text,
        embedding_text = excluded.embedding_text,
        source_line_start = excluded.source_line_start,
        source_line_end = excluded.source_line_end,
        publication_state = excluded.publication_state,
        updated_at = excluded.updated_at
    `,
    sql`
      insert into embedding_jobs (
        id,
        workspace_id,
        article_id,
        article_content_hash,
        embedding_generation_id,
        index_generation,
        status,
        attempts,
        maximum_attempts,
        checkpoint,
        available_at,
        created_at,
        updated_at
      )
      select
        json_extract(value, '$.job.id'),
        json_extract(value, '$.workspaceId'),
        json_extract(value, '$.articleId'),
        json_extract(value, '$.articleContentHash'),
        json_extract(value, '$.job.embeddingGenerationId'),
        (
          select generation from workspace_index_states
          where workspace_id = ${workspaceId as string}
        ),
        'pending',
        0,
        json_extract(value, '$.job.maximumAttempts'),
        0,
        json_extract(value, '$.job.availableAt'),
        ${changedAtTimestamp},
        ${changedAtTimestamp}
      from json_each(${serializedCommits})
    `,
  ];
}

export function articleEvidenceInvalidationStatements(
  _database: SqliteDatabase,
  workspaceId: string,
  articleIds: readonly string[],
  invalidatedAt: Date,
) {
  if (articleIds.length === 0) {
    return [];
  }

  const serializedArticleIds = JSON.stringify([...new Set(articleIds)]);
  const changedAt = invalidatedAt.getTime();
  return [
    sql`
      insert into workspace_index_states (workspace_id, generation, updated_at)
      select ${workspaceId}, 1, ${changedAt}
      where exists (
        select 1 from articles
        where articles.workspace_id = ${workspaceId}
          and articles.id in (
            select value from json_each(${serializedArticleIds})
          )
          and articles.content_hash is not null
      ) or exists (
        select 1 from evidence_chunks
        where evidence_chunks.workspace_id = ${workspaceId}
          and evidence_chunks.article_id in (
            select value from json_each(${serializedArticleIds})
          )
      )
      on conflict (workspace_id) do update
      set generation = workspace_index_states.generation + 1,
          updated_at = excluded.updated_at
    `,
    sql`
      update embedding_jobs
      set status = 'superseded',
          lease_token = null,
          lease_expires_at = null,
          completed_at = ${changedAt},
          updated_at = ${changedAt}
      where workspace_id = ${workspaceId}
        and article_id in (
          select value from json_each(${serializedArticleIds})
        )
        and status in ('pending', 'leased', 'retryable')
    `,
    sql`
      delete from evidence_chunks
      where workspace_id = ${workspaceId}
        and article_id in (
          select value from json_each(${serializedArticleIds})
        )
    `,
    sql`
      update articles
      set content_hash = null
      where workspace_id = ${workspaceId}
        and id in (
          select value from json_each(${serializedArticleIds})
        )
    `,
  ];
}

export function createSqliteEvidenceRepository(
  database: SqliteDatabase,
): EvidenceRepository {
  const executableDatabase = database as DrizzleD1Database<typeof schema>;

  async function readJob(workspaceId: string, id: string) {
    const [job] = await executableDatabase
      .select(jobFields)
      .from(embeddingJobs)
      .where(and(eq(embeddingJobs.workspaceId, workspaceId), eq(embeddingJobs.id, id)))
      .limit(1);
    return job ?? null;
  }

  async function readState(workspaceId: string) {
    const [state] = await executableDatabase
      .select(indexingStateFields)
      .from(workspaceIndexStates)
      .where(eq(workspaceIndexStates.workspaceId, workspaceId))
      .limit(1);
    return state ?? null;
  }

  async function readLiveWorkerLease(
    workspaceId: string,
    embeddingGenerationId: string,
    leaseToken: string,
    checkedAt: Date,
  ): Promise<EmbeddingWorkerJob | null> {
    const [job] = await executableDatabase
      .select({
        id: embeddingJobs.id,
        attempts: embeddingJobs.attempts,
        maximumAttempts: embeddingJobs.maximumAttempts,
        embeddingGenerationId: embeddingJobs.embeddingGenerationId,
      })
      .from(embeddingJobs)
      .innerJoin(
        articles,
        and(
          eq(articles.id, embeddingJobs.articleId),
          eq(articles.workspaceId, embeddingJobs.workspaceId),
          eq(articles.status, "published"),
          eq(articles.contentHash, embeddingJobs.articleContentHash),
        ),
      )
      .innerJoin(
        embeddingGenerations,
        and(
          eq(embeddingGenerations.id, embeddingJobs.embeddingGenerationId),
          eq(embeddingGenerations.workspaceId, embeddingJobs.workspaceId),
          inArray(embeddingGenerations.status, ["building", "active"]),
        ),
      )
      .where(
        and(
          eq(embeddingJobs.workspaceId, workspaceId),
          eq(embeddingJobs.embeddingGenerationId, embeddingGenerationId),
          eq(embeddingJobs.leaseToken, leaseToken),
          eq(embeddingJobs.status, "leased"),
          gt(embeddingJobs.leaseExpiresAt, checkedAt),
        ),
      )
      .limit(1);
    return job?.embeddingGenerationId
      ? {
          ...job,
          embeddingGenerationId: job.embeddingGenerationId,
        }
      : null;
  }

  async function hasExactEmbeddingCoverage(
    workspaceId: string,
    embeddingGenerationId: string,
  ) {
    const [coverage] = await executableDatabase
      .select({
        covered: sql<number>`
          not exists (
            select 1
            from articles as current_article
            where current_article.workspace_id = ${workspaceId}
              and current_article.status = 'published'
              and current_article.content_hash is not null
              and (
                not exists (
                  select 1
                  from embedding_jobs as completed_job
                  where completed_job.workspace_id = current_article.workspace_id
                    and completed_job.article_id = current_article.id
                    and completed_job.article_content_hash = current_article.content_hash
                    and completed_job.embedding_generation_id = ${embeddingGenerationId}
                    and completed_job.status = 'completed'
                )
                or exists (
                  select 1
                  from evidence_chunks as current_chunk
                  where current_chunk.workspace_id = current_article.workspace_id
                    and current_chunk.article_id = current_article.id
                    and current_chunk.article_content_hash = current_article.content_hash
                    and not exists (
                      select 1
                      from chunk_embeddings
                      inner join embedding_generations
                        on embedding_generations.id = chunk_embeddings.embedding_generation_id
                       and embedding_generations.workspace_id = chunk_embeddings.workspace_id
                      where chunk_embeddings.chunk_id = current_chunk.id
                        and chunk_embeddings.workspace_id = current_chunk.workspace_id
                        and chunk_embeddings.embedding_generation_id = ${embeddingGenerationId}
                        and chunk_embeddings.content_hash = current_chunk.content_hash
                        and chunk_embeddings.embedding_input_hash = current_chunk.embedding_input_hash
                        and chunk_embeddings.dimension = embedding_generations.dimension
                    )
                )
              )
          )
        `,
      })
      .from(embeddingGenerations)
      .where(
        and(
          eq(embeddingGenerations.workspaceId, workspaceId),
          eq(embeddingGenerations.id, embeddingGenerationId),
        ),
      )
      .limit(1);
    return coverage?.covered === 1;
  }

  return {
    getIndexingState: readState,

    async listUnindexedPublishedArticles(workspaceId, limit) {
      validateArticleEvidenceInitializationQuery(workspaceId, limit);
      return executableDatabase
        .select({
          id: articles.id,
          workspaceId: articles.workspaceId,
          categoryId: articles.categoryId,
          categorySlug: categories.slug,
          slug: articles.slug,
          title: articles.title,
          mdx: articles.mdx,
          status: articles.status,
          isFaq: articles.isFaq,
          authorName: articles.authorName,
          position: articles.position,
          publishedAt: articles.publishedAt,
        })
        .from(articles)
        .innerJoin(
          categories,
          and(
            eq(categories.id, articles.categoryId),
            eq(categories.workspaceId, articles.workspaceId),
          ),
        )
        .where(
          and(
            eq(articles.workspaceId, workspaceId),
            eq(articles.status, "published"),
            sql`${articles.contentHash} is null`,
          ),
        )
        .orderBy(asc(articles.position), asc(articles.id))
        .limit(limit);
    },

    async initializeArticleEvidence(initialization) {
      validateArticleEvidenceInitialization(initialization);
      try {
        await executeAtomically(
          database,
          articleEvidenceInitializationStatements(database, initialization),
        );
      } catch (error) {
        if (isArticleEvidenceInitializationConflict(error)) {
          return false;
        }
        throw error;
      }
      const job = await readJob(
        initialization.evidence.workspaceId,
        initialization.evidence.job.id,
      );
      return job?.articleContentHash === initialization.evidence.articleContentHash;
    },

    async reconcileEmbeddingGeneration(reconciliation) {
      validateEmbeddingGenerationReconciliation(reconciliation);
      const { metadata, reconciledAt, workspaceId } = reconciliation;
      const reconciledTimestamp = reconciledAt.getTime();
      const candidateId = `embedding_generation_${crypto.randomUUID()}`;
      const targetGeneration = sql`
        select generation.id
        from embedding_generations as generation
        left join workspace_index_states as state
          on state.workspace_id = generation.workspace_id
        where generation.workspace_id = ${workspaceId}
          and generation.provider = ${metadata.provider}
          and generation.model = ${metadata.model}
          and generation.dimension = ${metadata.dimension}
          and generation.configuration_hash = ${metadata.configurationHash}
          and (
            generation.status = 'building'
            or (
              generation.status = 'active'
              and state.active_embedding_generation_id = generation.id
            )
          )
        order by case when generation.status = 'active' then 0 else 1 end,
                 generation.created_at,
                 generation.id
        limit 1
      `;
      await executeAtomically(database, [
        sql`
          insert into workspace_index_states (workspace_id, generation, updated_at)
          values (${workspaceId}, 0, ${reconciledTimestamp})
          on conflict (workspace_id) do nothing
        `,
        sql`
          update workspace_index_states
          set updated_at = updated_at
          where workspace_id = ${workspaceId}
        `,
        sql`
          insert into embedding_generations (
            id,
            workspace_id,
            provider,
            model,
            dimension,
            configuration_hash,
            status,
            created_at
          )
          select
            ${candidateId},
            ${workspaceId},
            ${metadata.provider},
            ${metadata.model},
            ${metadata.dimension},
            ${metadata.configurationHash},
            'building',
            ${reconciledTimestamp}
          where not exists (
            select 1
            from embedding_generations as existing
            left join workspace_index_states as state
              on state.workspace_id = existing.workspace_id
            where existing.workspace_id = ${workspaceId}
              and existing.provider = ${metadata.provider}
              and existing.model = ${metadata.model}
              and existing.dimension = ${metadata.dimension}
              and existing.configuration_hash = ${metadata.configurationHash}
              and (
                existing.status = 'building'
                or (
                  existing.status = 'active'
                  and state.active_embedding_generation_id = existing.id
                )
              )
          )
        `,
        sql`
          update embedding_jobs as exact_job
          set index_generation = (
                select source.index_generation
                from embedding_jobs as source
                where source.workspace_id = exact_job.workspace_id
                  and source.article_id = exact_job.article_id
                  and source.article_content_hash = exact_job.article_content_hash
                  and source.embedding_generation_id is null
                  and source.status in ('pending', 'retryable')
                order by source.index_generation desc, source.created_at desc, source.id desc
                limit 1
              ),
              status = 'pending',
              attempts = 0,
              maximum_attempts = (
                select source.maximum_attempts
                from embedding_jobs as source
                where source.workspace_id = exact_job.workspace_id
                  and source.article_id = exact_job.article_id
                  and source.article_content_hash = exact_job.article_content_hash
                  and source.embedding_generation_id is null
                  and source.status in ('pending', 'retryable')
                order by source.index_generation desc, source.created_at desc, source.id desc
                limit 1
              ),
              checkpoint = 0,
              available_at = (
                select source.available_at
                from embedding_jobs as source
                where source.workspace_id = exact_job.workspace_id
                  and source.article_id = exact_job.article_id
                  and source.article_content_hash = exact_job.article_content_hash
                  and source.embedding_generation_id is null
                  and source.status in ('pending', 'retryable')
                order by source.index_generation desc, source.created_at desc, source.id desc
                limit 1
              ),
              lease_token = null,
              lease_expires_at = null,
              last_error_code = null,
              updated_at = ${reconciledTimestamp},
              completed_at = null
          where exact_job.workspace_id = ${workspaceId}
            and exact_job.embedding_generation_id = (${targetGeneration})
            and exact_job.status in ('completed', 'failed', 'superseded')
            and exists (
              select 1
              from embedding_jobs as source
              inner join articles as current_article
                on current_article.id = source.article_id
               and current_article.workspace_id = source.workspace_id
               and current_article.status = 'published'
               and current_article.content_hash = source.article_content_hash
              where source.workspace_id = exact_job.workspace_id
                and source.article_id = exact_job.article_id
                and source.article_content_hash = exact_job.article_content_hash
                and source.embedding_generation_id is null
                and source.status in ('pending', 'retryable')
            )
        `,
        sql`
          update embedding_jobs as publication_job
          set status = 'superseded',
              lease_token = null,
              lease_expires_at = null,
              completed_at = ${reconciledTimestamp},
              updated_at = ${reconciledTimestamp}
          where publication_job.workspace_id = ${workspaceId}
            and publication_job.embedding_generation_id is null
            and publication_job.status in ('pending', 'retryable')
            and exists (
              select 1
              from articles as current_article
              where current_article.id = publication_job.article_id
                and current_article.workspace_id = publication_job.workspace_id
                and current_article.status = 'published'
                and current_article.content_hash = publication_job.article_content_hash
            )
            and exists (
              select 1
              from embedding_jobs as exact_job
              where exact_job.workspace_id = publication_job.workspace_id
                and exact_job.article_id = publication_job.article_id
                and exact_job.article_content_hash = publication_job.article_content_hash
                and exact_job.embedding_generation_id = (${targetGeneration})
            )
        `,
        sql`
          update embedding_jobs as publication_job
          set embedding_generation_id = (${targetGeneration}),
              updated_at = ${reconciledTimestamp}
          where publication_job.workspace_id = ${workspaceId}
            and publication_job.embedding_generation_id is null
            and publication_job.status in ('pending', 'retryable')
            and exists (
              select 1
              from articles as current_article
              where current_article.id = publication_job.article_id
                and current_article.workspace_id = publication_job.workspace_id
                and current_article.status = 'published'
                and current_article.content_hash = publication_job.article_content_hash
            )
            and not exists (
              select 1
              from embedding_jobs as exact_job
              where exact_job.workspace_id = publication_job.workspace_id
                and exact_job.article_id = publication_job.article_id
                and exact_job.article_content_hash = publication_job.article_content_hash
                and exact_job.embedding_generation_id = (${targetGeneration})
            )
        `,
        sql`
          with target as (${targetGeneration})
          insert into embedding_jobs (
            id,
            workspace_id,
            article_id,
            article_content_hash,
            embedding_generation_id,
            index_generation,
            status,
            attempts,
            maximum_attempts,
            checkpoint,
            available_at,
            created_at,
            updated_at
          )
          select
            'embedding_job_' || lower(hex(randomblob(16))),
            current_article.workspace_id,
            current_article.id,
            current_article.content_hash,
            target.id,
            (
              select source_job.index_generation
              from embedding_jobs as source_job
              where source_job.workspace_id = current_article.workspace_id
                and source_job.article_id = current_article.id
                and source_job.article_content_hash = current_article.content_hash
              order by source_job.index_generation desc,
                       source_job.created_at desc,
                       source_job.id desc
              limit 1
            ),
            'pending',
            0,
            (
              select source_job.maximum_attempts
              from embedding_jobs as source_job
              where source_job.workspace_id = current_article.workspace_id
                and source_job.article_id = current_article.id
                and source_job.article_content_hash = current_article.content_hash
              order by source_job.index_generation desc,
                       source_job.created_at desc,
                       source_job.id desc
              limit 1
            ),
            0,
            ${reconciledTimestamp},
            ${reconciledTimestamp},
            ${reconciledTimestamp}
          from articles as current_article
          cross join target
          where current_article.workspace_id = ${workspaceId}
            and current_article.status = 'published'
            and current_article.content_hash is not null
            and exists (
              select 1
              from embedding_jobs as source_job
              where source_job.workspace_id = current_article.workspace_id
                and source_job.article_id = current_article.id
                and source_job.article_content_hash = current_article.content_hash
            )
            and not exists (
              select 1
              from embedding_jobs as exact_job
              where exact_job.workspace_id = current_article.workspace_id
                and exact_job.article_id = current_article.id
                and exact_job.article_content_hash = current_article.content_hash
                and exact_job.embedding_generation_id = target.id
            )
          on conflict (
            workspace_id,
            article_id,
            article_content_hash,
            embedding_generation_id
          ) do nothing
        `,
      ]);

      const [generation] = await executableDatabase
        .select({
          id: embeddingGenerations.id,
          workspaceId: embeddingGenerations.workspaceId,
          provider: embeddingGenerations.provider,
          model: embeddingGenerations.model,
          dimension: embeddingGenerations.dimension,
          configurationHash: embeddingGenerations.configurationHash,
          status: embeddingGenerations.status,
        })
        .from(embeddingGenerations)
        .leftJoin(
          workspaceIndexStates,
          eq(workspaceIndexStates.workspaceId, embeddingGenerations.workspaceId),
        )
        .where(
          and(
            eq(embeddingGenerations.workspaceId, workspaceId),
            eq(embeddingGenerations.provider, metadata.provider),
            eq(embeddingGenerations.model, metadata.model),
            eq(embeddingGenerations.dimension, metadata.dimension),
            eq(embeddingGenerations.configurationHash, metadata.configurationHash),
            sql`(
              ${embeddingGenerations.status} = 'building'
              or (
                ${embeddingGenerations.status} = 'active'
                and ${workspaceIndexStates.activeEmbeddingGenerationId} = ${embeddingGenerations.id}
              )
            )`,
          ),
        )
        .orderBy(
          sql`case when ${embeddingGenerations.status} = 'active' then 0 else 1 end`,
          asc(embeddingGenerations.createdAt),
          asc(embeddingGenerations.id),
        )
        .limit(1);
      if (!generation) {
        throw new Error("Embedding generation reconciliation did not produce a generation");
      }
      return {
        ...generation,
        provider: metadata.provider,
      } satisfies EmbeddingWorkerGeneration;
    },

    async createEmbeddingGeneration(generation) {
      validateEmbeddingGeneration(generation);
      await executableDatabase.insert(embeddingGenerations).values(generation);
    },

    async getActiveEmbeddingGeneration(workspaceId) {
      const [generation] = await executableDatabase
        .select(generationFields)
        .from(workspaceIndexStates)
        .innerJoin(
          embeddingGenerations,
          and(
            eq(
              embeddingGenerations.id,
              workspaceIndexStates.activeEmbeddingGenerationId,
            ),
            eq(embeddingGenerations.workspaceId, workspaceIndexStates.workspaceId),
          ),
        )
        .where(eq(workspaceIndexStates.workspaceId, workspaceId))
        .limit(1);
      return generation ?? null;
    },

    async commitArticleEvidence(commit) {
      const changedAt = new Date();
      await executeAtomically(
        database,
        articleEvidenceCommitStatements(database, [commit], changedAt),
      );
      const [state, job] = await Promise.all([
        readState(commit.workspaceId),
        readJob(commit.workspaceId, commit.job.id),
      ]);
      if (!state || !job) {
        throw new Error("Committed evidence indexing records could not be read");
      }
      return { ...state, generation: job.indexGeneration };
    },

    async invalidateArticleEvidence(workspaceId, articleId, invalidatedAt) {
      await executeAtomically(
        database,
        articleEvidenceInvalidationStatements(
          database,
          workspaceId,
          [articleId],
          invalidatedAt,
        ),
      );
      const state = await readState(workspaceId);
      if (!state) {
        throw new Error("Invalidated evidence indexing state could not be read");
      }
      return state;
    },

    async listEvidenceChunks(workspaceId) {
      const rows = await executableDatabase
        .select({ evidence: evidenceChunks })
        .from(evidenceChunks)
        .innerJoin(
          articles,
          and(
            eq(articles.workspaceId, evidenceChunks.workspaceId),
            eq(articles.id, evidenceChunks.articleId),
            eq(articles.status, "published"),
            eq(articles.contentHash, evidenceChunks.articleContentHash),
          ),
        )
        .where(eq(evidenceChunks.workspaceId, workspaceId))
        .orderBy(asc(evidenceChunks.articleId), asc(evidenceChunks.ordinal), asc(evidenceChunks.id));
      return evidenceRows(rows.map(({ evidence }) => evidence));
    },

    getEmbeddingJob: readJob,

    async claimEmbeddingJob(claim) {
      validateEmbeddingJobClaim(claim);
      const claimedAt = claim.claimedAt.getTime();
      const leaseExpiresAt = claim.leaseExpiresAt.getTime();
      const existingLease = await readLiveWorkerLease(
        claim.workspaceId,
        claim.embeddingGenerationId,
        claim.leaseToken,
        claim.claimedAt,
      );
      if (existingLease) {
        return existingLease;
      }
      await executeAtomically(database, [
        sql`
          update embedding_jobs
          set status = 'failed',
              lease_token = null,
              lease_expires_at = null,
              last_error_code = 'lease-expired',
              completed_at = ${claimedAt},
              updated_at = ${claimedAt}
          where workspace_id = ${claim.workspaceId}
            and embedding_generation_id = ${claim.embeddingGenerationId}
            and status = 'leased'
            and lease_expires_at <= ${claimedAt}
            and attempts >= maximum_attempts
        `,
        sql`
          update embedding_jobs
          set status = 'leased',
              attempts = attempts + 1,
              lease_token = ${claim.leaseToken},
              lease_expires_at = ${leaseExpiresAt},
              updated_at = ${claimedAt}
          where workspace_id = ${claim.workspaceId}
            and embedding_generation_id = ${claim.embeddingGenerationId}
            and id = (
              select candidate_job.id
              from embedding_jobs as candidate_job
              where candidate_job.workspace_id = ${claim.workspaceId}
                and candidate_job.embedding_generation_id = ${claim.embeddingGenerationId}
                and candidate_job.attempts < candidate_job.maximum_attempts
                and exists (
                  select 1
                  from articles as current_article
                  where current_article.id = candidate_job.article_id
                    and current_article.workspace_id = candidate_job.workspace_id
                    and current_article.status = 'published'
                    and current_article.content_hash = candidate_job.article_content_hash
                )
                and exists (
                  select 1
                  from embedding_generations as generation
                  where generation.id = candidate_job.embedding_generation_id
                    and generation.workspace_id = candidate_job.workspace_id
                    and generation.status in ('building', 'active')
                )
                and (
                  (candidate_job.status in ('pending', 'retryable') and candidate_job.available_at <= ${claimedAt})
                  or (candidate_job.status = 'leased' and candidate_job.lease_expires_at <= ${claimedAt})
                )
                and not exists (
                  select 1
                  from embedding_jobs as active_lease
                  where active_lease.workspace_id = ${claim.workspaceId}
                    and active_lease.lease_token = ${claim.leaseToken}
                    and active_lease.status = 'leased'
                    and active_lease.lease_expires_at > ${claimedAt}
                )
              order by
                case when candidate_job.lease_token = ${claim.leaseToken} then 0 else 1 end,
                candidate_job.available_at,
                candidate_job.created_at,
                candidate_job.id
              limit 1
            )
            and attempts < maximum_attempts
            and (
              (status in ('pending', 'retryable') and available_at <= ${claimedAt})
              or (status = 'leased' and lease_expires_at <= ${claimedAt})
            )
        `,
      ]);
      return readLiveWorkerLease(
        claim.workspaceId,
        claim.embeddingGenerationId,
        claim.leaseToken,
        claim.claimedAt,
      );
    },

    async getEmbeddingJobWork(request): Promise<EmbeddingWorkerWork | null> {
      validateEmbeddingJobWorkRequest(request);
      const [work] = await executableDatabase
        .select({
          jobId: embeddingJobs.id,
          attempts: embeddingJobs.attempts,
          maximumAttempts: embeddingJobs.maximumAttempts,
          embeddingGenerationId: embeddingJobs.embeddingGenerationId,
          generationId: embeddingGenerations.id,
          provider: embeddingGenerations.provider,
          model: embeddingGenerations.model,
          dimension: embeddingGenerations.dimension,
          configurationHash: embeddingGenerations.configurationHash,
          generationStatus: embeddingGenerations.status,
          totalChunkCount: sql<number>`(
            select count(*)
            from evidence_chunks as job_chunk
            where job_chunk.workspace_id = ${embeddingJobs.workspaceId}
              and job_chunk.article_id = ${embeddingJobs.articleId}
              and job_chunk.article_content_hash = ${embeddingJobs.articleContentHash}
          )`,
          completedChunkCount: sql<number>`(
            select count(*)
            from evidence_chunks as job_chunk
            inner join chunk_embeddings as stored_embedding
              on stored_embedding.chunk_id = job_chunk.id
             and stored_embedding.workspace_id = job_chunk.workspace_id
             and stored_embedding.embedding_generation_id = ${embeddingJobs.embeddingGenerationId}
             and stored_embedding.content_hash = job_chunk.content_hash
             and stored_embedding.embedding_input_hash = job_chunk.embedding_input_hash
             and stored_embedding.dimension = ${embeddingGenerations.dimension}
            where job_chunk.workspace_id = ${embeddingJobs.workspaceId}
              and job_chunk.article_id = ${embeddingJobs.articleId}
              and job_chunk.article_content_hash = ${embeddingJobs.articleContentHash}
          )`,
          chunksJson: sql<string>`coalesce((
            select json_group_array(
              json_object(
                'id', missing_chunk.id,
                'contentHash', missing_chunk.content_hash,
                'embeddingInputHash', missing_chunk.embedding_input_hash,
                'embeddingText', missing_chunk.embedding_text
              )
            )
            from (
              select
                job_chunk.id,
                job_chunk.content_hash,
                job_chunk.embedding_input_hash,
                job_chunk.embedding_text
              from evidence_chunks as job_chunk
              where job_chunk.workspace_id = ${embeddingJobs.workspaceId}
                and job_chunk.article_id = ${embeddingJobs.articleId}
                and job_chunk.article_content_hash = ${embeddingJobs.articleContentHash}
                and not exists (
                  select 1
                  from chunk_embeddings as stored_embedding
                  where stored_embedding.chunk_id = job_chunk.id
                    and stored_embedding.workspace_id = job_chunk.workspace_id
                    and stored_embedding.embedding_generation_id = ${embeddingJobs.embeddingGenerationId}
                    and stored_embedding.content_hash = job_chunk.content_hash
                    and stored_embedding.embedding_input_hash = job_chunk.embedding_input_hash
                    and stored_embedding.dimension = ${embeddingGenerations.dimension}
                )
              order by job_chunk.ordinal, job_chunk.id
              limit ${embeddingWorkMaximumChunks}
            ) as missing_chunk
          ), '[]')`,
        })
        .from(embeddingJobs)
        .innerJoin(
          embeddingGenerations,
          and(
            eq(embeddingGenerations.id, embeddingJobs.embeddingGenerationId),
            eq(embeddingGenerations.workspaceId, embeddingJobs.workspaceId),
            inArray(embeddingGenerations.status, ["building", "active"]),
          ),
        )
        .innerJoin(
          articles,
          and(
            eq(articles.id, embeddingJobs.articleId),
            eq(articles.workspaceId, embeddingJobs.workspaceId),
            eq(articles.status, "published"),
            eq(articles.contentHash, embeddingJobs.articleContentHash),
          ),
        )
        .where(
          and(
            eq(embeddingJobs.workspaceId, request.workspaceId),
            eq(embeddingJobs.id, request.id),
            eq(embeddingJobs.status, "leased"),
            eq(embeddingJobs.leaseToken, request.leaseToken),
            gt(embeddingJobs.leaseExpiresAt, request.checkedAt),
          ),
        )
        .limit(1);
      if (
        !work?.embeddingGenerationId ||
        (work.provider !== "cloudflare-workers-ai" &&
          work.provider !== "openai-compatible")
      ) {
        return null;
      }
      return {
        job: {
          id: work.jobId,
          attempts: work.attempts,
          maximumAttempts: work.maximumAttempts,
          embeddingGenerationId: work.embeddingGenerationId,
        },
        generation: {
          id: work.generationId,
          workspaceId: request.workspaceId,
          provider: work.provider,
          model: work.model,
          dimension: work.dimension,
          configurationHash: work.configurationHash,
          status: work.generationStatus,
        },
        chunks: JSON.parse(work.chunksJson) as EmbeddingWorkerWork["chunks"],
        completedChunkCount: Number(work.completedChunkCount),
        totalChunkCount: Number(work.totalChunkCount),
      };
    },

    async saveEmbeddingJobBatch(batch) {
      const [generation] = await executableDatabase
        .select({ dimension: embeddingGenerations.dimension })
        .from(embeddingGenerations)
        .where(
          and(
            eq(embeddingGenerations.workspaceId, batch.workspaceId),
            eq(embeddingGenerations.id, batch.embeddingGenerationId),
            inArray(embeddingGenerations.status, ["building", "active"]),
          ),
        )
        .limit(1);
      if (!generation) {
        return false;
      }
      validateEmbeddingJobBatch(batch, generation.dimension);
      const serializedEmbeddings = JSON.stringify(batch.embeddings);
      await executeAtomically(database, [
        sql`
          with eligible as (
            select incoming.value
            from json_each(${serializedEmbeddings}) as incoming
            inner join evidence_chunks as current_chunk
              on current_chunk.id = json_extract(incoming.value, '$.chunkId')
             and current_chunk.workspace_id = ${batch.workspaceId}
             and current_chunk.content_hash = json_extract(incoming.value, '$.contentHash')
             and current_chunk.embedding_input_hash = json_extract(incoming.value, '$.embeddingInputHash')
            inner join embedding_jobs as leased_job
              on leased_job.id = ${batch.id}
             and leased_job.workspace_id = current_chunk.workspace_id
             and leased_job.article_id = current_chunk.article_id
             and leased_job.article_content_hash = current_chunk.article_content_hash
             and leased_job.embedding_generation_id = ${batch.embeddingGenerationId}
             and leased_job.status = 'leased'
             and leased_job.lease_token = ${batch.leaseToken}
             and leased_job.lease_expires_at > ${batch.checkedAt.getTime()}
            inner join articles as current_article
              on current_article.id = leased_job.article_id
             and current_article.workspace_id = leased_job.workspace_id
             and current_article.status = 'published'
             and current_article.content_hash = leased_job.article_content_hash
            inner join embedding_generations as generation
              on generation.id = leased_job.embedding_generation_id
             and generation.workspace_id = leased_job.workspace_id
             and generation.dimension = ${generation.dimension}
             and generation.status in ('building', 'active')
          )
          insert into chunk_embeddings (
            chunk_id,
            embedding_generation_id,
            workspace_id,
            content_hash,
            embedding_input_hash,
            dimension,
            vector,
            created_at
          )
          select
            json_extract(eligible.value, '$.chunkId'),
            ${batch.embeddingGenerationId},
            ${batch.workspaceId},
            json_extract(eligible.value, '$.contentHash'),
            json_extract(eligible.value, '$.embeddingInputHash'),
            ${generation.dimension},
            json_extract(eligible.value, '$.vector'),
            ${batch.checkedAt.getTime()}
          from eligible
          where (select count(*) from eligible) =
            json_array_length(${serializedEmbeddings})
          on conflict (chunk_id, embedding_generation_id) do update set
            content_hash = excluded.content_hash,
            embedding_input_hash = excluded.embedding_input_hash,
            dimension = excluded.dimension,
            vector = excluded.vector,
            created_at = excluded.created_at
        `,
      ]);
      const [saved] = await executableDatabase
        .select({
          saved: sql<number>`
            ${embeddingJobs.embeddingGenerationId} = ${batch.embeddingGenerationId}
            and not exists (
              select 1
              from json_each(${serializedEmbeddings}) as incoming
              where not exists (
                select 1
                from chunk_embeddings as stored_embedding
                where stored_embedding.chunk_id = json_extract(incoming.value, '$.chunkId')
                  and stored_embedding.workspace_id = ${batch.workspaceId}
                  and stored_embedding.embedding_generation_id = ${batch.embeddingGenerationId}
                  and stored_embedding.content_hash = json_extract(incoming.value, '$.contentHash')
                  and stored_embedding.embedding_input_hash = json_extract(incoming.value, '$.embeddingInputHash')
                  and stored_embedding.dimension = ${generation.dimension}
              )
            )
          `,
        })
        .from(embeddingJobs)
        .innerJoin(
          articles,
          and(
            eq(articles.id, embeddingJobs.articleId),
            eq(articles.workspaceId, embeddingJobs.workspaceId),
            eq(articles.status, "published"),
            eq(articles.contentHash, embeddingJobs.articleContentHash),
          ),
        )
        .where(
          and(
            eq(embeddingJobs.workspaceId, batch.workspaceId),
            eq(embeddingJobs.id, batch.id),
            eq(embeddingJobs.status, "leased"),
            eq(embeddingJobs.leaseToken, batch.leaseToken),
            gt(embeddingJobs.leaseExpiresAt, batch.checkedAt),
          ),
        )
        .limit(1);
      return saved?.saved === 1;
    },

    async checkpointEmbeddingJob(checkpoint) {
      validateEmbeddingJobCheckpoint(checkpoint);
      const updated = await executableDatabase
        .update(embeddingJobs)
        .set({
          checkpoint: checkpoint.completedChunkCount,
          leaseExpiresAt: checkpoint.leaseExpiresAt,
          updatedAt: checkpoint.checkedAt,
        })
        .where(
          and(
            eq(embeddingJobs.workspaceId, checkpoint.workspaceId),
            eq(embeddingJobs.id, checkpoint.id),
            eq(embeddingJobs.status, "leased"),
            eq(embeddingJobs.leaseToken, checkpoint.leaseToken),
            gt(embeddingJobs.leaseExpiresAt, checkpoint.checkedAt),
            sql`${checkpoint.leaseExpiresAt.getTime()} > ${embeddingJobs.leaseExpiresAt}`,
            sql`${embeddingJobs.checkpoint} <= ${checkpoint.completedChunkCount}`,
            sql`${checkpoint.completedChunkCount} = (
              select count(*)
              from evidence_chunks as job_chunk
              inner join chunk_embeddings as stored_embedding
                on stored_embedding.chunk_id = job_chunk.id
               and stored_embedding.workspace_id = job_chunk.workspace_id
               and stored_embedding.embedding_generation_id = ${embeddingJobs.embeddingGenerationId}
               and stored_embedding.content_hash = job_chunk.content_hash
               and stored_embedding.embedding_input_hash = job_chunk.embedding_input_hash
              inner join embedding_generations as generation
                on generation.id = stored_embedding.embedding_generation_id
               and generation.workspace_id = stored_embedding.workspace_id
               and generation.dimension = stored_embedding.dimension
              where job_chunk.workspace_id = ${embeddingJobs.workspaceId}
                and job_chunk.article_id = ${embeddingJobs.articleId}
                and job_chunk.article_content_hash = ${embeddingJobs.articleContentHash}
            )`,
            sql`exists (
              select 1
              from articles as current_article
              where current_article.id = ${embeddingJobs.articleId}
                and current_article.workspace_id = ${embeddingJobs.workspaceId}
                and current_article.status = 'published'
                and current_article.content_hash = ${embeddingJobs.articleContentHash}
            )`,
          ),
        )
        .returning({ id: embeddingJobs.id });
      return updated.length === 1;
    },

    async retryEmbeddingJob(retry) {
      validateEmbeddingJobRetry(retry);
      const updated = await executableDatabase
        .update(embeddingJobs)
        .set({
          status: "retryable",
          availableAt: retry.availableAt,
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: retry.errorCode,
          updatedAt: retry.checkedAt,
          completedAt: null,
        })
        .where(
          and(
            eq(embeddingJobs.workspaceId, retry.workspaceId),
            eq(embeddingJobs.id, retry.id),
            eq(embeddingJobs.status, "leased"),
            eq(embeddingJobs.leaseToken, retry.leaseToken),
            gt(embeddingJobs.leaseExpiresAt, retry.checkedAt),
            sql`${embeddingJobs.attempts} < ${embeddingJobs.maximumAttempts}`,
            sql`exists (
              select 1 from articles as current_article
              where current_article.id = ${embeddingJobs.articleId}
                and current_article.workspace_id = ${embeddingJobs.workspaceId}
                and current_article.status = 'published'
                and current_article.content_hash = ${embeddingJobs.articleContentHash}
            )`,
          ),
        )
        .returning({ id: embeddingJobs.id });
      return updated.length === 1;
    },

    async failEmbeddingJob(failure) {
      validateEmbeddingJobFailure(failure);
      const updated = await executableDatabase
        .update(embeddingJobs)
        .set({
          status: "failed",
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: failure.errorCode,
          updatedAt: failure.checkedAt,
          completedAt: failure.checkedAt,
        })
        .where(
          and(
            eq(embeddingJobs.workspaceId, failure.workspaceId),
            eq(embeddingJobs.id, failure.id),
            eq(embeddingJobs.status, "leased"),
            eq(embeddingJobs.leaseToken, failure.leaseToken),
            gt(embeddingJobs.leaseExpiresAt, failure.checkedAt),
            sql`exists (
              select 1 from articles as current_article
              where current_article.id = ${embeddingJobs.articleId}
                and current_article.workspace_id = ${embeddingJobs.workspaceId}
                and current_article.status = 'published'
                and current_article.content_hash = ${embeddingJobs.articleContentHash}
            )`,
          ),
        )
        .returning({ id: embeddingJobs.id });
      return updated.length === 1;
    },

    async completeEmbeddingJob(completion) {
      validateEmbeddingJobCompletion(completion);
      const updated = await executableDatabase
        .update(embeddingJobs)
        .set({
          status: "completed",
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          completedAt: completion.checkedAt,
          updatedAt: completion.checkedAt,
        })
        .where(
          and(
            eq(embeddingJobs.workspaceId, completion.workspaceId),
            eq(embeddingJobs.id, completion.id),
            eq(embeddingJobs.status, "leased"),
            eq(embeddingJobs.leaseToken, completion.leaseToken),
            gt(embeddingJobs.leaseExpiresAt, completion.checkedAt),
            sql`exists (
              select 1
              from articles as current_article
              where current_article.id = ${embeddingJobs.articleId}
                and current_article.workspace_id = ${embeddingJobs.workspaceId}
                and current_article.status = 'published'
                and current_article.content_hash = ${embeddingJobs.articleContentHash}
            )`,
            sql`exists (
              select 1
              from embedding_generations as current_generation
              where current_generation.id = ${embeddingJobs.embeddingGenerationId}
                and current_generation.workspace_id = ${embeddingJobs.workspaceId}
                and current_generation.status in ('building', 'active')
            )`,
            sql`not exists (
              select 1
              from evidence_chunks as job_chunk
              where job_chunk.workspace_id = ${embeddingJobs.workspaceId}
                and job_chunk.article_id = ${embeddingJobs.articleId}
                and job_chunk.article_content_hash = ${embeddingJobs.articleContentHash}
                and not exists (
                  select 1
                  from chunk_embeddings as stored_embedding
                  inner join embedding_generations as generation
                    on generation.id = stored_embedding.embedding_generation_id
                   and generation.workspace_id = stored_embedding.workspace_id
                   and generation.dimension = stored_embedding.dimension
                  where stored_embedding.chunk_id = job_chunk.id
                    and stored_embedding.workspace_id = job_chunk.workspace_id
                    and stored_embedding.embedding_generation_id = ${embeddingJobs.embeddingGenerationId}
                    and stored_embedding.content_hash = job_chunk.content_hash
                    and stored_embedding.embedding_input_hash = job_chunk.embedding_input_hash
                    and generation.status in ('building', 'active')
                )
            )`,
          ),
        )
        .returning({ id: embeddingJobs.id });
      return updated.length === 1;
    },

    async saveChunkEmbeddings(batch) {
      const [generation] = await executableDatabase
        .select(generationFields)
        .from(embeddingGenerations)
        .where(
          and(
            eq(embeddingGenerations.workspaceId, batch.workspaceId),
            eq(embeddingGenerations.id, batch.embeddingGenerationId),
          ),
        )
        .limit(1);
      if (!generation) {
        throw new Error("Embedding generation does not exist in this workspace");
      }
      validateChunkEmbeddingBatch(batch, generation.dimension);
      const serializedEmbeddings = JSON.stringify(batch.embeddings);
      await executeAtomically(database, [
        sql`
          insert into chunk_embeddings (
            chunk_id,
            embedding_generation_id,
            workspace_id,
            content_hash,
            embedding_input_hash,
            dimension,
            vector,
            created_at
          )
          select
            json_extract(value, '$.chunkId'),
            ${batch.embeddingGenerationId},
            ${batch.workspaceId},
            json_extract(value, '$.contentHash'),
            json_extract(value, '$.embeddingInputHash'),
            ${generation.dimension},
            json_extract(value, '$.vector'),
            ${batch.createdAt.getTime()}
          from json_each(${serializedEmbeddings})
          where true
          on conflict (chunk_id, embedding_generation_id) do update set
            content_hash = excluded.content_hash,
            embedding_input_hash = excluded.embedding_input_hash,
            dimension = excluded.dimension,
            vector = excluded.vector,
            created_at = excluded.created_at
        `,
      ]);
    },

    async activateEmbeddingGeneration(activation) {
      validateEmbeddingGenerationActivation(activation);
      const { activatedAt, embeddingGenerationId, metadata, workspaceId } = activation;
      const activatedTimestamp = activatedAt.getTime();
      const exactCoverage = sql`
        not exists (
          select 1
          from articles as current_article
          where current_article.workspace_id = target.workspace_id
            and current_article.status = 'published'
            and current_article.content_hash is not null
            and (
              not exists (
                select 1
                from embedding_jobs as completed_job
                where completed_job.workspace_id = current_article.workspace_id
                  and completed_job.article_id = current_article.id
                  and completed_job.article_content_hash = current_article.content_hash
                  and completed_job.embedding_generation_id = target.id
                  and completed_job.status = 'completed'
              )
              or exists (
                select 1
                from evidence_chunks as current_chunk
                where current_chunk.workspace_id = current_article.workspace_id
                  and current_chunk.article_id = current_article.id
                  and current_chunk.article_content_hash = current_article.content_hash
                  and not exists (
                    select 1
                    from chunk_embeddings as stored_embedding
                    where stored_embedding.chunk_id = current_chunk.id
                      and stored_embedding.workspace_id = current_chunk.workspace_id
                      and stored_embedding.embedding_generation_id = target.id
                      and stored_embedding.content_hash = current_chunk.content_hash
                      and stored_embedding.embedding_input_hash = current_chunk.embedding_input_hash
                      and stored_embedding.dimension = target.dimension
                  )
              )
            )
        )
      `;
      await executeAtomically(database, [
        sql`
          insert into workspace_index_states (workspace_id, generation, updated_at)
          values (${workspaceId}, 0, ${activatedTimestamp})
          on conflict (workspace_id) do nothing
        `,
        sql`
          update workspace_index_states
          set updated_at = updated_at
          where workspace_id = ${workspaceId}
        `,
        sql`
          update embedding_generations as target
          set status = 'active',
              activated_at = case
                when target.status = 'building' then ${activatedTimestamp}
                else target.activated_at
              end,
              retired_at = null
          where target.id = ${embeddingGenerationId}
            and target.workspace_id = ${workspaceId}
            and target.status in ('building', 'active')
            and target.provider = ${metadata.provider}
            and target.model = ${metadata.model}
            and target.dimension = ${metadata.dimension}
            and target.configuration_hash = ${metadata.configurationHash}
            and ${exactCoverage}
        `,
        sql`
          update workspace_index_states as state
          set active_embedding_generation_id = ${embeddingGenerationId},
              updated_at = ${activatedTimestamp}
          where state.workspace_id = ${workspaceId}
            and exists (
              select 1
              from embedding_generations as target
              where target.id = ${embeddingGenerationId}
                and target.workspace_id = state.workspace_id
                and target.status = 'active'
                and target.provider = ${metadata.provider}
                and target.model = ${metadata.model}
                and target.dimension = ${metadata.dimension}
                and target.configuration_hash = ${metadata.configurationHash}
                and ${exactCoverage}
            )
        `,
        sql`
          update embedding_generations as previous
          set status = 'retired', retired_at = ${activatedTimestamp}
          where previous.workspace_id = ${workspaceId}
            and previous.id <> ${embeddingGenerationId}
            and previous.status = 'active'
            and exists (
              select 1
              from workspace_index_states as state
              inner join embedding_generations as target
                on target.id = state.active_embedding_generation_id
               and target.workspace_id = state.workspace_id
               and target.status = 'active'
              where state.workspace_id = previous.workspace_id
                and target.id = ${embeddingGenerationId}
                and target.provider = ${metadata.provider}
                and target.model = ${metadata.model}
                and target.dimension = ${metadata.dimension}
                and target.configuration_hash = ${metadata.configurationHash}
                and ${exactCoverage}
            )
        `,
      ]);
      const [state, generation, covered] = await Promise.all([
        readState(workspaceId),
        executableDatabase
          .select({
            status: embeddingGenerations.status,
            activatedAt: embeddingGenerations.activatedAt,
          })
          .from(embeddingGenerations)
          .where(
            and(
              eq(embeddingGenerations.workspaceId, workspaceId),
              eq(embeddingGenerations.id, embeddingGenerationId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null),
        hasExactEmbeddingCoverage(workspaceId, embeddingGenerationId),
      ]);
      return (
        covered &&
        state?.activeEmbeddingGenerationId === embeddingGenerationId &&
        generation?.status === "active"
      );
    },

    async listActiveChunkEmbeddings(workspaceId): Promise<ActiveChunkEmbedding[]> {
      return executableDatabase
        .select({
          workspaceId: chunkEmbeddings.workspaceId,
          chunkId: chunkEmbeddings.chunkId,
          articleId: evidenceChunks.articleId,
          contentHash: chunkEmbeddings.contentHash,
          embeddingInputHash: chunkEmbeddings.embeddingInputHash,
          embeddingGenerationId: chunkEmbeddings.embeddingGenerationId,
          provider: embeddingGenerations.provider,
          model: embeddingGenerations.model,
          dimension: chunkEmbeddings.dimension,
          configurationHash: embeddingGenerations.configurationHash,
          vector: chunkEmbeddings.vector,
        })
        .from(chunkEmbeddings)
        .innerJoin(
          evidenceChunks,
          and(
            eq(evidenceChunks.id, chunkEmbeddings.chunkId),
            eq(evidenceChunks.workspaceId, chunkEmbeddings.workspaceId),
            eq(evidenceChunks.contentHash, chunkEmbeddings.contentHash),
            eq(evidenceChunks.embeddingInputHash, chunkEmbeddings.embeddingInputHash),
          ),
        )
        .innerJoin(
          articles,
          and(
            eq(articles.id, evidenceChunks.articleId),
            eq(articles.workspaceId, evidenceChunks.workspaceId),
            eq(articles.status, "published"),
            eq(articles.contentHash, evidenceChunks.articleContentHash),
          ),
        )
        .innerJoin(
          workspaceIndexStates,
          and(
            eq(workspaceIndexStates.workspaceId, chunkEmbeddings.workspaceId),
            eq(
              workspaceIndexStates.activeEmbeddingGenerationId,
              chunkEmbeddings.embeddingGenerationId,
            ),
          ),
        )
        .innerJoin(
          embeddingGenerations,
          and(
            eq(embeddingGenerations.id, chunkEmbeddings.embeddingGenerationId),
            eq(embeddingGenerations.workspaceId, chunkEmbeddings.workspaceId),
            eq(embeddingGenerations.status, "active"),
          ),
        )
        .where(
          and(
            eq(chunkEmbeddings.workspaceId, workspaceId),
            sql`exists (
              select 1
              from embedding_jobs as completed_job
              where completed_job.workspace_id = ${evidenceChunks.workspaceId}
                and completed_job.article_id = ${evidenceChunks.articleId}
                and completed_job.article_content_hash = ${evidenceChunks.articleContentHash}
                and completed_job.embedding_generation_id = ${chunkEmbeddings.embeddingGenerationId}
                and completed_job.status = 'completed'
            )`,
          ),
        )
        .orderBy(asc(evidenceChunks.articleId), asc(evidenceChunks.ordinal), asc(evidenceChunks.id));
    },

    async revalidateEvidenceCandidates(request) {
      validateEvidenceCandidateRevalidation(request);
      if (request.candidates.length === 0) {
        return [];
      }
      const serializedCandidates = JSON.stringify(request.candidates);
      const candidates = await executableDatabase.all<{
        chunkId: string;
        articleId: string;
        articleContentHash: string;
        contentHash: string;
      }>(sql`
        select
          json_extract(incoming.value, '$.chunkId') as chunkId,
          json_extract(incoming.value, '$.articleId') as articleId,
          json_extract(incoming.value, '$.articleContentHash') as articleContentHash,
          json_extract(incoming.value, '$.contentHash') as contentHash
        from json_each(${serializedCandidates}) as incoming
        inner join workspace_index_states as state
          on state.workspace_id = ${request.workspaceId}
         and state.generation = ${request.generation}
        inner join evidence_chunks as current_chunk
          on current_chunk.id = json_extract(incoming.value, '$.chunkId')
         and current_chunk.workspace_id = state.workspace_id
         and current_chunk.article_id = json_extract(incoming.value, '$.articleId')
         and current_chunk.article_content_hash = json_extract(incoming.value, '$.articleContentHash')
         and current_chunk.content_hash = json_extract(incoming.value, '$.contentHash')
         and current_chunk.index_generation <= state.generation
        inner join articles as current_article
          on current_article.id = current_chunk.article_id
         and current_article.workspace_id = current_chunk.workspace_id
         and current_article.status = 'published'
         and current_article.content_hash = current_chunk.article_content_hash
        order by cast(incoming.key as integer)
      `);
      return candidates;
    },

    async saveQuestionSet(questionSet) {
      validateQuestionSet(questionSet);
      await executableDatabase.insert(savedQuestionSets).values({
        ...questionSet,
        questions: questionSet.questions,
      });
    },

    async getQuestionSet(workspaceId, id) {
      const [questionSet] = await executableDatabase
        .select()
        .from(savedQuestionSets)
        .where(
          and(eq(savedQuestionSets.workspaceId, workspaceId), eq(savedQuestionSets.id, id)),
        )
        .limit(1);
      return questionSet
        ? { ...questionSet, questions: questionSet.questions as readonly SavedQuestion[] }
        : null;
    },

    async startEvaluationRun(run) {
      validateEvaluationRunStart(run);
      await executableDatabase.insert(evaluationRuns).values({
        ...run,
        status: "running",
        results: null,
        completedAt: null,
      });
    },

    async finishEvaluationRun(completion) {
      validateEvaluationRunCompletion(completion);
      const updated = await executableDatabase
        .update(evaluationRuns)
        .set({
          status: completion.status,
          results: completion.results,
          completedAt: completion.completedAt,
        })
        .where(
          and(
            eq(evaluationRuns.workspaceId, completion.workspaceId),
            eq(evaluationRuns.id, completion.id),
            eq(evaluationRuns.status, "running"),
          ),
        )
        .returning({ id: evaluationRuns.id });
      if (updated.length !== 1) {
        throw new Error("Running evaluation record was not found");
      }
    },

    async getEvaluationRun(workspaceId, id) {
      const [run] = await executableDatabase
        .select()
        .from(evaluationRuns)
        .where(and(eq(evaluationRuns.workspaceId, workspaceId), eq(evaluationRuns.id, id)))
        .limit(1);
      return run ?? null;
    },
  };
}
