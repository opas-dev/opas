// ABOUTME: Stores versioned evidence, embeddings, jobs, and evaluations in Postgres and Neon.
// ABOUTME: Keeps publication invalidation and retry checkpoints atomic within each deployment driver.
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  validateChunkEmbeddingBatch,
  validateArticleEvidenceInitialization,
  validateArticleEvidenceInitializationQuery,
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
  validateEvaluationRunResultsUpdate,
  validateEvaluationRunStart,
  validateEvidenceCandidateRevalidation,
  validateEvidenceCommit,
  validateEvidenceReviewRequest,
  validateQuestionSet,
} from "@/db/evidence";
import type {
  ActiveChunkEmbedding,
  ArticleEvidenceCommit,
  ArticleEvidenceInitialization,
  EvidenceRepository,
  EvidenceChunkRecord,
  SavedQuestion,
} from "@/db/repository";
import type {
  EmbeddingWorkerGeneration,
  EmbeddingWorkerJob,
  EmbeddingWorkerWork,
} from "@/ai/embedding-worker";
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
} from "@/db/schema/postgres";
import type * as schema from "@/db/schema/postgres";

type PostgresDatabase =
  | NodePgDatabase<typeof schema>
  | NeonHttpDatabase<typeof schema>;

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

function articleEvidenceInitializationStatements(
  database: PostgresDatabase,
  initialization: ArticleEvidenceInitialization,
) {
  const exactArticle = exactUnindexedArticle(initialization);
  return [
    sql`
      select articles.id
      from articles
      inner join categories on categories.id = articles.category_id
      where ${exactArticle}
      for update of articles, categories
    `,
    sql`
      select 1 / case when exists (
        select 1
        from articles
        inner join categories on categories.id = articles.category_id
        where ${exactArticle}
      ) then 1 else 0 end
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
    if (typeof current !== "object" || current === null) {
      return false;
    }
    if ("code" in current && current.code === "22012") {
      return true;
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

function isNeonDatabase(
  database: PostgresDatabase,
): database is NeonHttpDatabase<typeof schema> {
  return "batch" in database;
}

async function executeAtomically(database: PostgresDatabase, statements: SQL[]) {
  if (statements.length === 0) {
    return;
  }

  if (isNeonDatabase(database)) {
    const queries = statements.map((statement) => database.execute(statement));
    type Query = (typeof queries)[number];
    await database.batch(queries as [Query, ...Query[]]);
    return;
  }

  await database.transaction(async (transaction) => {
    for (const statement of statements) {
      await transaction.execute(statement);
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

function validEvidenceArticleStatement(commit: ArticleEvidenceCommit) {
  return sql`
    select cast(
      case when exists (
        select 1
        from articles
        inner join categories on categories.id = articles.category_id
        where articles.id = ${commit.articleId}
          and articles.workspace_id = ${commit.workspaceId}
          and articles.status = 'published'
          and articles.content_hash = ${commit.articleContentHash}
          and categories.workspace_id = articles.workspace_id
          and categories.slug = ${commit.categorySlug}
      ) then '1' else 'invalid article evidence' end
      as integer
    )
  `;
}

function lockEvidenceCategoryStatement(commit: ArticleEvidenceCommit) {
  return sql`
    select categories.id
    from categories
    inner join articles on articles.category_id = categories.id
    where articles.id = ${commit.articleId}
      and articles.workspace_id = ${commit.workspaceId}
      and categories.workspace_id = articles.workspace_id
      and categories.slug = ${commit.categorySlug}
    for update of categories
  `;
}

export function articleEvidenceCommitStatements(
  database: PostgresDatabase,
  commits: readonly ArticleEvidenceCommit[],
  changedAt: Date,
) {
  if (commits.length === 0) {
    return [];
  }

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

  const statements: SQL[] = [
    database
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
  ];

  for (const commit of commits) {
    const serializedChunks = JSON.stringify(
      commit.chunks.map((chunk) => ({
        id: chunk.id,
        content_hash: chunk.contentHash,
        embedding_input_hash: chunk.embeddingInputHash,
        ordinal: chunk.ordinal,
        title: chunk.title,
        heading_path: chunk.headingPath,
        canonical_url: chunk.canonicalUrl,
        markdown: chunk.markdown,
        evidence_text: chunk.evidenceText,
        embedding_text: chunk.embeddingText,
        source_line_start: chunk.sourceLineRange.start,
        source_line_end: chunk.sourceLineRange.end,
      })),
    );

    statements.push(
      lockEvidenceCategoryStatement(commit),
      database
        .update(articles)
        .set({ contentHash: commit.articleContentHash })
        .where(
          and(
            eq(articles.workspaceId, commit.workspaceId),
            eq(articles.id, commit.articleId),
            eq(articles.status, "published"),
          ),
        )
        .getSQL(),
      validEvidenceArticleStatement(commit),
      database
        .update(embeddingJobs)
        .set({
          status: "superseded",
          leaseToken: null,
          leaseExpiresAt: null,
          completedAt: changedAt,
          updatedAt: changedAt,
        })
        .where(
          and(
            eq(embeddingJobs.workspaceId, commit.workspaceId),
            eq(embeddingJobs.articleId, commit.articleId),
            inArray(embeddingJobs.status, ["pending", "leased", "retryable"]),
          ),
        )
        .getSQL(),
      sql`
        update evidence_chunks
        set ordinal = ordinal + ${evidenceOrdinalOffset}
        where workspace_id = ${commit.workspaceId}
          and article_id = ${commit.articleId}
      `,
      sql`
        delete from evidence_chunks as stored
        where stored.workspace_id = ${commit.workspaceId}
          and stored.article_id = ${commit.articleId}
          and not exists (
            select 1
            from jsonb_to_recordset(${serializedChunks}::jsonb)
              as incoming(id text, content_hash text, embedding_input_hash text)
            where incoming.id = stored.id
              and incoming.content_hash = stored.content_hash
              and incoming.embedding_input_hash = stored.embedding_input_hash
          )
      `,
    );

    if (commit.chunks.length > 0) {
      statements.push(sql`
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
          incoming.id,
          ${commit.workspaceId},
          ${commit.articleId},
          ${commit.articleContentHash},
          incoming.content_hash,
          incoming.embedding_input_hash,
          (
            select generation from workspace_index_states
            where workspace_id = ${commit.workspaceId}
          ),
          incoming.ordinal,
          incoming.title,
          incoming.heading_path,
          incoming.canonical_url,
          incoming.markdown,
          incoming.evidence_text,
          incoming.embedding_text,
          incoming.source_line_start,
          incoming.source_line_end,
          'published',
          ${changedAt},
          ${changedAt}
        from jsonb_to_recordset(${serializedChunks}::jsonb) as incoming(
          id text,
          content_hash text,
          embedding_input_hash text,
          ordinal integer,
          title text,
          heading_path jsonb,
          canonical_url text,
          markdown text,
          evidence_text text,
          embedding_text text,
          source_line_start integer,
          source_line_end integer
        )
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
      `);
    }

    statements.push(
      database
        .insert(embeddingJobs)
        .values({
          id: commit.job.id,
          workspaceId: commit.workspaceId,
          articleId: commit.articleId,
          articleContentHash: commit.articleContentHash,
          embeddingGenerationId: commit.job.embeddingGenerationId,
          indexGeneration: sql<number>`(
            select generation from workspace_index_states
            where workspace_id = ${commit.workspaceId}
          )`,
          status: "pending",
          attempts: 0,
          maximumAttempts: commit.job.maximumAttempts,
          checkpoint: 0,
          availableAt: commit.job.availableAt,
          createdAt: changedAt,
          updatedAt: changedAt,
        })
        .getSQL(),
    );
  }

  return statements;
}

export function articleEvidenceInvalidationStatements(
  database: PostgresDatabase,
  workspaceId: string,
  articleIds: readonly string[],
  invalidatedAt: Date,
) {
  if (articleIds.length === 0) {
    return [];
  }

  const serializedArticleIds = JSON.stringify([...new Set(articleIds)]);
  return [
    sql`
      insert into workspace_index_states (workspace_id, generation, updated_at)
      select ${workspaceId}, 1, ${invalidatedAt}
      where exists (
        select 1 from articles
        where articles.workspace_id = ${workspaceId}
          and articles.id in (
            select value from jsonb_array_elements_text(${serializedArticleIds}::jsonb)
          )
          and articles.content_hash is not null
      ) or exists (
        select 1 from evidence_chunks
        where evidence_chunks.workspace_id = ${workspaceId}
          and evidence_chunks.article_id in (
            select value from jsonb_array_elements_text(${serializedArticleIds}::jsonb)
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
          completed_at = ${invalidatedAt},
          updated_at = ${invalidatedAt}
      where workspace_id = ${workspaceId}
        and article_id in (
          select value from jsonb_array_elements_text(${serializedArticleIds}::jsonb)
        )
        and status in ('pending', 'leased', 'retryable')
    `,
    sql`
      delete from evidence_chunks
      where workspace_id = ${workspaceId}
        and article_id in (
          select value from jsonb_array_elements_text(${serializedArticleIds}::jsonb)
        )
    `,
    sql`
      update articles
      set content_hash = null
      where workspace_id = ${workspaceId}
        and id in (
          select value from jsonb_array_elements_text(${serializedArticleIds}::jsonb)
        )
    `,
  ];
}

export function createPostgresEvidenceRepository(
  database: PostgresDatabase,
): EvidenceRepository {
  async function readJob(workspaceId: string, id: string) {
    const [job] = await database
      .select(jobFields)
      .from(embeddingJobs)
      .where(and(eq(embeddingJobs.workspaceId, workspaceId), eq(embeddingJobs.id, id)))
      .limit(1);
    return job ?? null;
  }

  async function readState(workspaceId: string) {
    const [state] = await database
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
    const [job] = await database
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
    const [coverage] = await database
      .select({
        covered: sql<boolean>`
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
    return coverage?.covered === true;
  }

  return {
    getIndexingState: readState,

    async listUnindexedPublishedArticles(workspaceId, limit) {
      validateArticleEvidenceInitializationQuery(workspaceId, limit);
      return database
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
      const candidateId = `embedding_generation_${crypto.randomUUID()}`;
      await executeAtomically(database, [
        sql`
          insert into workspace_index_states (workspace_id, generation, updated_at)
          values (${workspaceId}, 0, ${reconciledAt})
          on conflict (workspace_id) do nothing
        `,
        sql`
          select workspace_id
          from workspace_index_states
          where workspace_id = ${workspaceId}
          for update
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
            ${reconciledAt}
          where not exists (
            select 1
            from embedding_generations as existing
            where existing.workspace_id = ${workspaceId}
              and existing.provider = ${metadata.provider}
              and existing.model = ${metadata.model}
              and existing.dimension = ${metadata.dimension}
              and existing.configuration_hash = ${metadata.configurationHash}
              and (
                existing.status = 'building'
                or (
                  existing.status = 'active'
                  and exists (
                    select 1
                    from workspace_index_states
                    where workspace_index_states.workspace_id = existing.workspace_id
                      and workspace_index_states.active_embedding_generation_id = existing.id
                  )
                )
              )
          )
        `,
        sql`
          with target as (
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
          ), current_publication as (
            select distinct on (source.article_id)
              source.article_id,
              source.article_content_hash,
              source.index_generation,
              source.maximum_attempts,
              source.available_at
            from embedding_jobs as source
            inner join articles as current_article
              on current_article.id = source.article_id
             and current_article.workspace_id = source.workspace_id
             and current_article.status = 'published'
             and current_article.content_hash = source.article_content_hash
            where source.workspace_id = ${workspaceId}
              and source.embedding_generation_id is null
              and source.status in ('pending', 'retryable')
            order by source.article_id,
                     source.index_generation desc,
                     source.created_at desc,
                     source.id desc
          )
          update embedding_jobs as exact_job
          set index_generation = current_publication.index_generation,
              status = 'pending',
              attempts = 0,
              maximum_attempts = current_publication.maximum_attempts,
              checkpoint = 0,
              available_at = current_publication.available_at,
              lease_token = null,
              lease_expires_at = null,
              last_error_code = null,
              updated_at = ${reconciledAt},
              completed_at = null
          from target, current_publication
          where exact_job.workspace_id = ${workspaceId}
            and exact_job.article_id = current_publication.article_id
            and exact_job.article_content_hash = current_publication.article_content_hash
            and exact_job.embedding_generation_id = target.id
            and exact_job.status in ('completed', 'failed', 'superseded')
        `,
        sql`
          with target as (
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
          )
          update embedding_jobs as publication_job
          set status = 'superseded',
              lease_token = null,
              lease_expires_at = null,
              completed_at = ${reconciledAt},
              updated_at = ${reconciledAt}
          where publication_job.workspace_id = ${workspaceId}
            and publication_job.embedding_generation_id is null
            and publication_job.status in ('pending', 'retryable')
            and exists (
              select 1
              from articles as current_article
              inner join target on true
              inner join embedding_jobs as exact_job
                on exact_job.workspace_id = publication_job.workspace_id
               and exact_job.article_id = publication_job.article_id
               and exact_job.article_content_hash = publication_job.article_content_hash
               and exact_job.embedding_generation_id = target.id
              where current_article.id = publication_job.article_id
                and current_article.workspace_id = publication_job.workspace_id
                and current_article.status = 'published'
                and current_article.content_hash = publication_job.article_content_hash
            )
        `,
        sql`
          with target as (
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
          )
          update embedding_jobs as publication_job
          set embedding_generation_id = target.id,
              updated_at = ${reconciledAt}
          from target
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
                and exact_job.embedding_generation_id = target.id
            )
        `,
        sql`
          with target as (
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
          )
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
            'embedding_job_' || md5(
              random()::text || clock_timestamp()::text || current_article.id || target.id
            ),
            current_article.workspace_id,
            current_article.id,
            current_article.content_hash,
            target.id,
            source.index_generation,
            'pending',
            0,
            source.maximum_attempts,
            0,
            ${reconciledAt},
            ${reconciledAt},
            ${reconciledAt}
          from articles as current_article
          inner join lateral (
            select source_job.index_generation, source_job.maximum_attempts
            from embedding_jobs as source_job
            where source_job.workspace_id = current_article.workspace_id
              and source_job.article_id = current_article.id
              and source_job.article_content_hash = current_article.content_hash
            order by source_job.index_generation desc,
                     source_job.created_at desc,
                     source_job.id desc
            limit 1
          ) as source on true
          inner join target on true
          where current_article.workspace_id = ${workspaceId}
            and current_article.status = 'published'
            and current_article.content_hash is not null
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

      const [generation] = await database
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
      await database.insert(embeddingGenerations).values(generation);
    },

    async getActiveEmbeddingGeneration(workspaceId) {
      const [generation] = await database
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
      const rows = await database
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
          select pg_advisory_xact_lock(
            hashtextextended(${JSON.stringify([claim.workspaceId, claim.leaseToken])}, 0)
          )
        `,
        sql`
          update embedding_jobs
          set status = 'failed',
              lease_token = null,
              lease_expires_at = null,
              last_error_code = 'lease-expired',
              completed_at = ${claim.claimedAt},
              updated_at = ${claim.claimedAt}
          where workspace_id = ${claim.workspaceId}
            and embedding_generation_id = ${claim.embeddingGenerationId}
            and status = 'leased'
            and lease_expires_at <= ${claim.claimedAt}
            and attempts >= maximum_attempts
        `,
        sql`
          with candidate as (
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
                (candidate_job.status in ('pending', 'retryable') and candidate_job.available_at <= ${claim.claimedAt})
                or (candidate_job.status = 'leased' and candidate_job.lease_expires_at <= ${claim.claimedAt})
              )
              and not exists (
                select 1
                from embedding_jobs as active_lease
                where active_lease.workspace_id = ${claim.workspaceId}
                  and active_lease.lease_token = ${claim.leaseToken}
                  and active_lease.status = 'leased'
                  and active_lease.lease_expires_at > ${claim.claimedAt}
              )
            order by
              case when candidate_job.lease_token = ${claim.leaseToken} then 0 else 1 end,
              candidate_job.available_at,
              candidate_job.created_at,
              candidate_job.id
            for update skip locked
            limit 1
          )
          update embedding_jobs
          set status = 'leased',
              attempts = attempts + 1,
              lease_token = ${claim.leaseToken},
              lease_expires_at = ${claim.leaseExpiresAt},
              updated_at = ${claim.claimedAt}
          where workspace_id = ${claim.workspaceId}
            and embedding_generation_id = ${claim.embeddingGenerationId}
            and id = (select id from candidate)
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
      const [work] = await database
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
          chunks: sql<
            readonly {
              id: string;
              contentHash: string;
              embeddingInputHash: string;
              embeddingText: string;
            }[]
          >`coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', missing_chunk.id,
                'contentHash', missing_chunk.content_hash,
                'embeddingInputHash', missing_chunk.embedding_input_hash,
                'embeddingText', missing_chunk.embedding_text
              )
              order by missing_chunk.ordinal, missing_chunk.id
            )
            from (
              select
                job_chunk.id,
                job_chunk.content_hash,
                job_chunk.embedding_input_hash,
                job_chunk.embedding_text,
                job_chunk.ordinal
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
          ), '[]'::jsonb)`,
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
        chunks: work.chunks,
        completedChunkCount: Number(work.completedChunkCount),
        totalChunkCount: Number(work.totalChunkCount),
      };
    },

    async saveEmbeddingJobBatch(batch) {
      const [generation] = await database
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
      const serializedEmbeddings = JSON.stringify(
        batch.embeddings.map((embedding) => ({
          chunk_id: embedding.chunkId,
          content_hash: embedding.contentHash,
          embedding_input_hash: embedding.embeddingInputHash,
          vector: embedding.vector,
        })),
      );
      await database.execute(sql`
        with incoming as (
          select *
          from jsonb_to_recordset(${serializedEmbeddings}::jsonb) as value(
            chunk_id text,
            content_hash text,
            embedding_input_hash text,
            vector jsonb
          )
        ), eligible as (
          select incoming.*
          from incoming
          inner join evidence_chunks as current_chunk
            on current_chunk.id = incoming.chunk_id
           and current_chunk.workspace_id = ${batch.workspaceId}
           and current_chunk.content_hash = incoming.content_hash
           and current_chunk.embedding_input_hash = incoming.embedding_input_hash
          inner join embedding_jobs as leased_job
            on leased_job.id = ${batch.id}
           and leased_job.workspace_id = current_chunk.workspace_id
           and leased_job.article_id = current_chunk.article_id
           and leased_job.article_content_hash = current_chunk.article_content_hash
           and leased_job.embedding_generation_id = ${batch.embeddingGenerationId}
           and leased_job.status = 'leased'
           and leased_job.lease_token = ${batch.leaseToken}
           and leased_job.lease_expires_at > ${batch.checkedAt}
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
        ), complete_batch as (
          select
            (select count(*) from incoming) =
            (select count(*) from eligible) as allowed
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
          eligible.chunk_id,
          ${batch.embeddingGenerationId},
          ${batch.workspaceId},
          eligible.content_hash,
          eligible.embedding_input_hash,
          ${generation.dimension},
          eligible.vector,
          ${batch.checkedAt}
        from eligible
        cross join complete_batch
        where complete_batch.allowed
        on conflict (chunk_id, embedding_generation_id) do update set
          content_hash = excluded.content_hash,
          embedding_input_hash = excluded.embedding_input_hash,
          dimension = excluded.dimension,
          vector = excluded.vector,
          created_at = excluded.created_at
      `);
      const [saved] = await database
        .select({
          saved: sql<boolean>`
            ${embeddingJobs.embeddingGenerationId} = ${batch.embeddingGenerationId}
            and not exists (
              select 1
              from jsonb_to_recordset(${serializedEmbeddings}::jsonb) as incoming(
                chunk_id text,
                content_hash text,
                embedding_input_hash text,
                vector jsonb
              )
              where not exists (
                select 1
                from chunk_embeddings as stored_embedding
                where stored_embedding.chunk_id = incoming.chunk_id
                  and stored_embedding.workspace_id = ${batch.workspaceId}
                  and stored_embedding.embedding_generation_id = ${batch.embeddingGenerationId}
                  and stored_embedding.content_hash = incoming.content_hash
                  and stored_embedding.embedding_input_hash = incoming.embedding_input_hash
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
      return saved?.saved === true;
    },

    async checkpointEmbeddingJob(checkpoint) {
      validateEmbeddingJobCheckpoint(checkpoint);
      const updated = await database
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
            sql`${checkpoint.leaseExpiresAt} > ${embeddingJobs.leaseExpiresAt}`,
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
        .returning();
      return updated.length === 1;
    },

    async retryEmbeddingJob(retry) {
      validateEmbeddingJobRetry(retry);
      const updated = await database
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
        .returning();
      return updated.length === 1;
    },

    async failEmbeddingJob(failure) {
      validateEmbeddingJobFailure(failure);
      const updated = await database
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
        .returning();
      return updated.length === 1;
    },

    async completeEmbeddingJob(completion) {
      validateEmbeddingJobCompletion(completion);
      const updated = await database
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
        .returning();
      return updated.length === 1;
    },

    async saveChunkEmbeddings(batch) {
      const [generation] = await database
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
      if (batch.embeddings.length === 0) {
        return;
      }
      await database
        .insert(chunkEmbeddings)
        .values(
          batch.embeddings.map((embedding) => ({
              chunkId: embedding.chunkId,
              embeddingGenerationId: batch.embeddingGenerationId,
              workspaceId: batch.workspaceId,
              contentHash: embedding.contentHash,
              embeddingInputHash: embedding.embeddingInputHash,
              dimension: generation.dimension,
              vector: embedding.vector,
              createdAt: batch.createdAt,
            })),
        )
        .onConflictDoUpdate({
          target: [chunkEmbeddings.chunkId, chunkEmbeddings.embeddingGenerationId],
          set: {
            contentHash: sql`excluded.content_hash`,
            embeddingInputHash: sql`excluded.embedding_input_hash`,
            dimension: sql`excluded.dimension`,
            vector: sql`excluded.vector`,
            createdAt: sql`excluded.created_at`,
          },
        });
    },

    async activateEmbeddingGeneration(activation) {
      validateEmbeddingGenerationActivation(activation);
      const { activatedAt, embeddingGenerationId, metadata, workspaceId } = activation;
      await executeAtomically(database, [
        sql`
          insert into workspace_index_states (workspace_id, generation, updated_at)
          values (${workspaceId}, 0, ${activatedAt})
          on conflict (workspace_id) do nothing
        `,
        sql`
          select workspace_id
          from workspace_index_states
          where workspace_id = ${workspaceId}
          for update
        `,
        sql`
          update embedding_generations as target
          set status = 'active',
              activated_at = case
                when target.status = 'building' then ${activatedAt}
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
            and not exists (
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
        `,
        sql`
          update workspace_index_states as state
          set active_embedding_generation_id = ${embeddingGenerationId},
              updated_at = ${activatedAt}
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
                and not exists (
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
            )
        `,
        sql`
          update embedding_generations as previous
          set status = 'retired', retired_at = ${activatedAt}
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
                and not exists (
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
            )
        `,
      ]);
      const [state, generation, covered] = await Promise.all([
        readState(workspaceId),
        database
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
      const rows = await database
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
      return rows;
    },

    async revalidateEvidenceCandidates(request) {
      validateEvidenceCandidateRevalidation(request);
      if (request.candidates.length === 0) {
        return [];
      }
      const serializedCandidates = JSON.stringify(request.candidates);
      const result = await database.execute<{
        chunk_id: string;
        article_id: string;
        article_content_hash: string;
        content_hash: string;
      }>(sql`
        select
          incoming.value->>'chunkId' as chunk_id,
          incoming.value->>'articleId' as article_id,
          incoming.value->>'articleContentHash' as article_content_hash,
          incoming.value->>'contentHash' as content_hash
        from jsonb_array_elements(${serializedCandidates}::jsonb)
          with ordinality as incoming(value, ordinal)
        inner join workspace_index_states as state
          on state.workspace_id = ${request.workspaceId}
         and state.generation = ${request.generation}
        inner join evidence_chunks as current_chunk
          on current_chunk.id = incoming.value->>'chunkId'
         and current_chunk.workspace_id = state.workspace_id
         and current_chunk.article_id = incoming.value->>'articleId'
         and current_chunk.article_content_hash = incoming.value->>'articleContentHash'
         and current_chunk.content_hash = incoming.value->>'contentHash'
         and current_chunk.index_generation <= state.generation
        inner join articles as current_article
          on current_article.id = current_chunk.article_id
         and current_article.workspace_id = current_chunk.workspace_id
         and current_article.status = 'published'
         and current_article.content_hash = current_chunk.article_content_hash
        order by incoming.ordinal
      `);
      return result.rows.map((candidate) => ({
        chunkId: candidate.chunk_id,
        articleId: candidate.article_id,
        articleContentHash: candidate.article_content_hash,
        contentHash: candidate.content_hash,
      }));
    },

    async saveQuestionSet(questionSet) {
      validateQuestionSet(questionSet);
      await database.insert(savedQuestionSets).values({
        ...questionSet,
        questions: questionSet.questions,
      });
    },

    async getQuestionSet(workspaceId, id) {
      const [questionSet] = await database
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

    async listQuestionSets(workspaceId, limit) {
      validateEvidenceReviewRequest(workspaceId, limit);
      const rows = await database
        .select()
        .from(savedQuestionSets)
        .where(eq(savedQuestionSets.workspaceId, workspaceId))
        .orderBy(desc(savedQuestionSets.createdAt), asc(savedQuestionSets.id))
        .limit(limit);
      return rows.map((questionSet) => ({
        ...questionSet,
        questions: questionSet.questions as readonly SavedQuestion[],
      }));
    },

    async startEvaluationRun(run) {
      validateEvaluationRunStart(run);
      await database.insert(evaluationRuns).values({
        ...run,
        status: "running",
        results: null,
        completedAt: null,
      });
    },

    async finishEvaluationRun(completion) {
      validateEvaluationRunCompletion(completion);
      const updated = await database
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
        .returning();
      if (updated.length !== 1) {
        throw new Error("Running evaluation record was not found");
      }
    },

    async updateEvaluationRunResults(update) {
      validateEvaluationRunResultsUpdate(update);
      const updated = await database
        .update(evaluationRuns)
        .set({ results: update.results })
        .where(
          and(
            eq(evaluationRuns.workspaceId, update.workspaceId),
            eq(evaluationRuns.id, update.id),
            eq(evaluationRuns.status, "completed"),
          ),
        )
        .returning();
      if (updated.length !== 1) {
        throw new Error("Completed evaluation record was not found");
      }
    },

    async getEvaluationRun(workspaceId, id) {
      const [run] = await database
        .select()
        .from(evaluationRuns)
        .where(and(eq(evaluationRuns.workspaceId, workspaceId), eq(evaluationRuns.id, id)))
        .limit(1);
      return run ?? null;
    },

    async listEvaluationRuns(workspaceId, limit) {
      validateEvidenceReviewRequest(workspaceId, limit);
      return database
        .select()
        .from(evaluationRuns)
        .where(eq(evaluationRuns.workspaceId, workspaceId))
        .orderBy(desc(evaluationRuns.startedAt), asc(evaluationRuns.id))
        .limit(limit);
    },
  };
}
