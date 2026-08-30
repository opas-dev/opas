// ABOUTME: Stores versioned evidence, embeddings, jobs, and evaluations in Postgres and Neon.
// ABOUTME: Keeps publication invalidation and retry checkpoints atomic within each deployment driver.
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  validateChunkEmbeddingBatch,
  validateEmbeddingGeneration,
  validateEmbeddingJobCheckpoint,
  validateEmbeddingJobClaim,
  validateEmbeddingJobCompletion,
  validateEmbeddingJobRetry,
  validateEvaluationRunCompletion,
  validateEvaluationRunStart,
  validateEvidenceCommit,
  validateQuestionSet,
} from "@/db/evidence";
import type {
  ActiveChunkEmbedding,
  EvidenceRepository,
  EvidenceChunkRecord,
  SavedQuestion,
} from "@/db/repository";
import {
  articles,
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

  async function readLiveLease(
    workspaceId: string,
    leaseToken: string,
    checkedAt: Date,
  ) {
    const [job] = await database
      .select(jobFields)
      .from(embeddingJobs)
      .where(
        and(
          eq(embeddingJobs.workspaceId, workspaceId),
          eq(embeddingJobs.leaseToken, leaseToken),
          eq(embeddingJobs.status, "leased"),
          gt(embeddingJobs.leaseExpiresAt, checkedAt),
        ),
      )
      .limit(1);
    return job ?? null;
  }

  async function hasExactEmbeddingCoverage(
    workspaceId: string,
    embeddingGenerationId: string,
  ) {
    const [coverage] = await database
      .select({
        covered: sql<boolean>`
          exists (
            select 1 from evidence_chunks
            where evidence_chunks.workspace_id = ${workspaceId}
          )
          and not exists (
            select 1
            from evidence_chunks
            where evidence_chunks.workspace_id = ${workspaceId}
              and not exists (
                select 1
                from chunk_embeddings
                inner join embedding_generations
                  on embedding_generations.id = chunk_embeddings.embedding_generation_id
                 and embedding_generations.workspace_id = chunk_embeddings.workspace_id
                where chunk_embeddings.chunk_id = evidence_chunks.id
                  and chunk_embeddings.workspace_id = evidence_chunks.workspace_id
                  and chunk_embeddings.embedding_generation_id = ${embeddingGenerationId}
                  and chunk_embeddings.content_hash = evidence_chunks.content_hash
                  and chunk_embeddings.embedding_input_hash = evidence_chunks.embedding_input_hash
                  and chunk_embeddings.dimension = embedding_generations.dimension
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
      validateEvidenceCommit(commit);
      const changedAt = new Date();
      const serializedChunkIdentities = JSON.stringify(
        commit.chunks.map((chunk) => ({
          id: chunk.id,
          content_hash: chunk.contentHash,
          embedding_input_hash: chunk.embeddingInputHash,
        })),
      );
      const statements: SQL[] = [
        database
          .insert(workspaceIndexStates)
          .values({
            workspaceId: commit.workspaceId,
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
              from jsonb_to_recordset(${serializedChunkIdentities}::jsonb)
                as incoming(id text, content_hash text, embedding_input_hash text)
              where incoming.id = stored.id
                and incoming.content_hash = stored.content_hash
                and incoming.embedding_input_hash = stored.embedding_input_hash
            )
        `,
      ];

      if (commit.chunks.length > 0) {
        statements.push(
          database
            .insert(evidenceChunks)
            .values(
              commit.chunks.map((chunk) => ({
                id: chunk.id,
                workspaceId: commit.workspaceId,
                articleId: commit.articleId,
                articleContentHash: commit.articleContentHash,
                contentHash: chunk.contentHash,
                embeddingInputHash: chunk.embeddingInputHash,
                indexGeneration: sql<number>`(
                  select generation from workspace_index_states
                  where workspace_id = ${commit.workspaceId}
                )`,
                ordinal: chunk.ordinal,
                title: chunk.title,
                headingPath: chunk.headingPath,
                canonicalUrl: chunk.canonicalUrl,
                markdown: chunk.markdown,
                evidenceText: chunk.evidenceText,
                embeddingText: chunk.embeddingText,
                sourceLineStart: chunk.sourceLineRange.start,
                sourceLineEnd: chunk.sourceLineRange.end,
                publicationState: "published" as const,
                createdAt: changedAt,
                updatedAt: changedAt,
              })),
            )
            .onConflictDoUpdate({
              target: evidenceChunks.id,
              set: {
                articleContentHash: commit.articleContentHash,
                indexGeneration: sql<number>`(
                  select generation from workspace_index_states
                  where workspace_id = ${commit.workspaceId}
                )`,
                ordinal: sql`excluded.ordinal`,
                title: sql`excluded.title`,
                headingPath: sql`excluded.heading_path`,
                canonicalUrl: sql`excluded.canonical_url`,
                markdown: sql`excluded.markdown`,
                evidenceText: sql`excluded.evidence_text`,
                embeddingText: sql`excluded.embedding_text`,
                sourceLineStart: sql`excluded.source_line_start`,
                sourceLineEnd: sql`excluded.source_line_end`,
                publicationState: "published",
                updatedAt: changedAt,
              },
            })
            .getSQL(),
        );
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

      await executeAtomically(database, statements);
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
      await executeAtomically(database, [
        database
          .insert(workspaceIndexStates)
          .values({ workspaceId, generation: 1, updatedAt: invalidatedAt })
          .onConflictDoUpdate({
            target: workspaceIndexStates.workspaceId,
            set: {
              generation: sql`${workspaceIndexStates.generation} + 1`,
              updatedAt: invalidatedAt,
            },
          })
          .getSQL(),
        database
          .update(embeddingJobs)
          .set({
            status: "superseded",
            leaseToken: null,
            leaseExpiresAt: null,
            completedAt: invalidatedAt,
            updatedAt: invalidatedAt,
          })
          .where(
            and(
              eq(embeddingJobs.workspaceId, workspaceId),
              eq(embeddingJobs.articleId, articleId),
              inArray(embeddingJobs.status, ["pending", "leased", "retryable"]),
            ),
          )
          .getSQL(),
        database
          .delete(evidenceChunks)
          .where(
            and(
              eq(evidenceChunks.workspaceId, workspaceId),
              eq(evidenceChunks.articleId, articleId),
            ),
          )
          .getSQL(),
      ]);
      const state = await readState(workspaceId);
      if (!state) {
        throw new Error("Invalidated evidence indexing state could not be read");
      }
      return state;
    },

    async listEvidenceChunks(workspaceId) {
      const rows = await database
        .select()
        .from(evidenceChunks)
        .where(eq(evidenceChunks.workspaceId, workspaceId))
        .orderBy(asc(evidenceChunks.articleId), asc(evidenceChunks.ordinal), asc(evidenceChunks.id));
      return evidenceRows(rows);
    },

    getEmbeddingJob: readJob,

    async claimEmbeddingJob(claim) {
      validateEmbeddingJobClaim(claim);
      const existingLease = await readLiveLease(
        claim.workspaceId,
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
            and status = 'leased'
            and lease_expires_at <= ${claim.claimedAt}
            and attempts >= maximum_attempts
        `,
        sql`
          with candidate as (
            select candidate_job.id
            from embedding_jobs as candidate_job
            where candidate_job.workspace_id = ${claim.workspaceId}
              and candidate_job.attempts < candidate_job.maximum_attempts
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
            and id = (select id from candidate)
        `,
      ]);
      return readLiveLease(claim.workspaceId, claim.leaseToken, claim.claimedAt);
    },

    async checkpointEmbeddingJob(checkpoint) {
      validateEmbeddingJobCheckpoint(checkpoint);
      const updated = await database
        .update(embeddingJobs)
        .set({
          checkpoint: checkpoint.completedChunkCount,
          updatedAt: checkpoint.checkedAt,
        })
        .where(
          and(
            eq(embeddingJobs.workspaceId, checkpoint.workspaceId),
            eq(embeddingJobs.id, checkpoint.id),
            eq(embeddingJobs.status, "leased"),
            eq(embeddingJobs.leaseToken, checkpoint.leaseToken),
            gt(embeddingJobs.leaseExpiresAt, checkpoint.checkedAt),
            lt(embeddingJobs.checkpoint, checkpoint.completedChunkCount),
          ),
        )
        .returning();
      return updated.length === 1;
    },

    async retryEmbeddingJob(retry) {
      validateEmbeddingJobRetry(retry);
      const job = await readJob(retry.workspaceId, retry.id);
      const terminal = job ? job.attempts >= job.maximumAttempts : false;
      const updated = await database
        .update(embeddingJobs)
        .set({
          status: terminal ? "failed" : "retryable",
          availableAt: retry.availableAt,
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: retry.errorCode,
          updatedAt: retry.checkedAt,
          completedAt: terminal ? retry.checkedAt : null,
        })
        .where(
          and(
            eq(embeddingJobs.workspaceId, retry.workspaceId),
            eq(embeddingJobs.id, retry.id),
            eq(embeddingJobs.status, "leased"),
            eq(embeddingJobs.leaseToken, retry.leaseToken),
            gt(embeddingJobs.leaseExpiresAt, retry.checkedAt),
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

    async activateEmbeddingGeneration(workspaceId, embeddingGenerationId, activatedAt) {
      await executeAtomically(database, [
        sql`
          select workspace_id
          from workspace_index_states
          where workspace_id = ${workspaceId}
          for update
        `,
        sql`
          update embedding_generations as target
          set status = 'active', activated_at = ${activatedAt}, retired_at = null
          where target.id = ${embeddingGenerationId}
            and target.workspace_id = ${workspaceId}
            and target.status in ('building', 'active')
            and exists (
              select 1 from evidence_chunks
              where evidence_chunks.workspace_id = target.workspace_id
            )
            and not exists (
              select 1
              from evidence_chunks
              where evidence_chunks.workspace_id = target.workspace_id
                and not exists (
                  select 1
                  from chunk_embeddings
                  where chunk_embeddings.chunk_id = evidence_chunks.id
                    and chunk_embeddings.workspace_id = evidence_chunks.workspace_id
                    and chunk_embeddings.embedding_generation_id = target.id
                    and chunk_embeddings.content_hash = evidence_chunks.content_hash
                    and chunk_embeddings.embedding_input_hash = evidence_chunks.embedding_input_hash
                    and chunk_embeddings.dimension = target.dimension
                )
            )
        `,
        sql`
          update embedding_generations
          set status = 'retired', retired_at = ${activatedAt}
          where workspace_id = ${workspaceId}
            and id <> ${embeddingGenerationId}
            and status = 'active'
            and exists (
              select 1 from embedding_generations as target
              where target.id = ${embeddingGenerationId}
                and target.workspace_id = ${workspaceId}
                and target.status = 'active'
                and target.activated_at = ${activatedAt}
                and exists (
                  select 1 from evidence_chunks
                  where evidence_chunks.workspace_id = target.workspace_id
                )
                and not exists (
                  select 1
                  from evidence_chunks
                  where evidence_chunks.workspace_id = target.workspace_id
                    and not exists (
                      select 1
                      from chunk_embeddings
                      where chunk_embeddings.chunk_id = evidence_chunks.id
                        and chunk_embeddings.workspace_id = evidence_chunks.workspace_id
                        and chunk_embeddings.embedding_generation_id = target.id
                        and chunk_embeddings.content_hash = evidence_chunks.content_hash
                        and chunk_embeddings.embedding_input_hash = evidence_chunks.embedding_input_hash
                        and chunk_embeddings.dimension = target.dimension
                    )
                )
            )
        `,
        sql`
          insert into workspace_index_states (
            workspace_id,
            generation,
            active_embedding_generation_id,
            updated_at
          )
          select workspace_id, 0, id, ${activatedAt}
          from embedding_generations
          where id = ${embeddingGenerationId}
            and workspace_id = ${workspaceId}
            and status = 'active'
            and activated_at = ${activatedAt}
            and exists (
              select 1 from evidence_chunks
              where evidence_chunks.workspace_id = embedding_generations.workspace_id
            )
            and not exists (
              select 1
              from evidence_chunks
              where evidence_chunks.workspace_id = embedding_generations.workspace_id
                and not exists (
                  select 1
                  from chunk_embeddings
                  where chunk_embeddings.chunk_id = evidence_chunks.id
                    and chunk_embeddings.workspace_id = evidence_chunks.workspace_id
                    and chunk_embeddings.embedding_generation_id = embedding_generations.id
                    and chunk_embeddings.content_hash = evidence_chunks.content_hash
                    and chunk_embeddings.embedding_input_hash = evidence_chunks.embedding_input_hash
                    and chunk_embeddings.dimension = embedding_generations.dimension
                )
            )
          on conflict (workspace_id) do update
          set active_embedding_generation_id = excluded.active_embedding_generation_id,
              updated_at = excluded.updated_at
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
        generation?.status === "active" &&
        generation.activatedAt?.getTime() === activatedAt.getTime()
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
        .where(eq(chunkEmbeddings.workspaceId, workspaceId))
        .orderBy(asc(evidenceChunks.articleId), asc(evidenceChunks.ordinal), asc(evidenceChunks.id));
      return rows;
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

    async getEvaluationRun(workspaceId, id) {
      const [run] = await database
        .select()
        .from(evaluationRuns)
        .where(and(eq(evaluationRuns.workspaceId, workspaceId), eq(evaluationRuns.id, id)))
        .limit(1);
      return run ?? null;
    },
  };
}
