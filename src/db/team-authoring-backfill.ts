// ABOUTME: Runs the deterministic, fence-held baseline article revision backfill.
// ABOUTME: Shares chunking, hashes, identities, and restart behavior across database dialects.

import {
  articleRevisionHash,
  migrationArticleRevisionId,
  serializeArticleRevision,
  type ArticleRevisionSnapshot,
} from "@/content/article-revision";

const encoder = new TextEncoder();

export const teamAuthoringBackfillChunkSize = 25;
export const teamAuthoringBackfillVersion = 1;
export const migrationRevisionActorLabel = "OPAS migration";

export type TeamAuthoringBackfillCursor = Readonly<{
  articleId: string;
  workspaceId: string;
}>;

export type TeamAuthoringBackfillArticle = Readonly<{
  articleId: string;
  assetIdsAndHashes: readonly Readonly<{ hash: string; id: string }>[];
  authorName: string;
  categoryId: string;
  categoryName: string;
  categorySlug: string;
  isFaq: boolean;
  mdx: string;
  position: number;
  slug: string;
  status: "draft" | "published";
  title: string;
  workspaceId: string;
}>;

export type TeamAuthoringBaseline = Readonly<{
  article: TeamAuthoringBackfillArticle;
  revisionHash: string;
  revisionId: string;
  serialization: string;
}>;

export type TeamAuthoringStoredBaseline = Readonly<{
  article: TeamAuthoringBackfillArticle;
  revisionHash: string;
  revisionId: string;
}>;

export type TeamAuthoringBackfillCompletion = Readonly<{
  articleCount: number;
  completedAt: Date;
  projectionHash: string;
  version: 1;
  workspaceId: string;
}>;

export type TeamAuthoringBackfillInspection = Readonly<{
  completedWorkspaceIds: readonly string[];
  guardsInstalled: boolean;
  pendingArticleCount: number;
  workspaceIds: readonly string[];
}>;

export type TeamAuthoringBackfillStore = Readonly<{
  applyChunk(rows: readonly TeamAuthoringBaseline[]): Promise<void>;
  assertAllWorkspacesPaused(): Promise<TeamAuthoringBackfillInspection>;
  audit(rows: readonly TeamAuthoringBackfillCompletion[]): Promise<void>;
  auditCompleted(rows: readonly TeamAuthoringBackfillCompletion[]): Promise<void>;
  finalize(
    rows: readonly TeamAuthoringBackfillCompletion[],
    installGuards: boolean,
  ): Promise<void>;
  readArticleChunk(
    cursor: TeamAuthoringBackfillCursor | null,
    limit: number,
  ): Promise<readonly TeamAuthoringBackfillArticle[]>;
  readMigrationRevisionChunk(
    cursor: TeamAuthoringBackfillCursor | null,
    limit: number,
  ): Promise<readonly TeamAuthoringStoredBaseline[]>;
  verifyChunk(rows: readonly TeamAuthoringBaseline[]): Promise<void>;
}>;

export type TeamAuthoringBackfillOptions = Readonly<{
  clock?: () => Date;
  interruptAfterChunks?: number;
}>;

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function teamAuthoringBackfillProjectionHash(
  workspaceId: string,
  baselines: readonly TeamAuthoringBaseline[],
) {
  return sha256(
    JSON.stringify([
      "opas.team-authoring-backfill.v1",
      workspaceId,
      baselines.map((row) => [
        row.article.articleId,
        row.revisionId,
        row.revisionHash,
        row.serialization,
      ]),
    ]),
  );
}

function snapshot(article: TeamAuthoringBackfillArticle): ArticleRevisionSnapshot {
  return {
    workspaceId: article.workspaceId,
    articleId: article.articleId,
    categoryId: article.categoryId,
    categorySlug: article.categorySlug,
    categoryName: article.categoryName,
    slug: article.slug,
    title: article.title,
    mdx: article.mdx,
    isFaq: article.isFaq,
    authorName: article.authorName,
    position: article.position,
    assetHashes: article.assetIdsAndHashes.map(({ hash }) => hash),
  };
}

export async function createTeamAuthoringBaseline(
  article: TeamAuthoringBackfillArticle,
): Promise<TeamAuthoringBaseline> {
  const revisionSnapshot = snapshot(article);
  return {
    article,
    revisionHash: await articleRevisionHash(revisionSnapshot),
    revisionId: await migrationArticleRevisionId(article.workspaceId, article.articleId),
    serialization: serializeArticleRevision(revisionSnapshot),
  };
}

async function completionRows(
  workspaceIds: readonly string[],
  baselines: readonly TeamAuthoringBaseline[],
  completedAt: Date,
) {
  const byWorkspace = new Map<string, TeamAuthoringBaseline[]>();
  for (const workspaceId of workspaceIds) byWorkspace.set(workspaceId, []);
  for (const baseline of baselines) {
    const rows = byWorkspace.get(baseline.article.workspaceId);
    if (!rows) {
      throw new Error("AUTHORING_BACKFILL_WORKSPACE_CHANGED");
    }
    rows.push(baseline);
  }

  return Promise.all(
    [...byWorkspace].map(async ([workspaceId, rows]) => ({
      articleCount: rows.length,
      completedAt,
      projectionHash: await teamAuthoringBackfillProjectionHash(workspaceId, rows),
      version: teamAuthoringBackfillVersion,
      workspaceId,
    }) satisfies TeamAuthoringBackfillCompletion),
  );
}

export async function runTeamAuthoringBackfill(
  store: TeamAuthoringBackfillStore,
  options: TeamAuthoringBackfillOptions = {},
) {
  const initial = await store.assertAllWorkspacesPaused();
  const completed = new Set(initial.completedWorkspaceIds);
  if (
    completed.size !== 0 &&
    completed.size !== initial.workspaceIds.length &&
    !initial.guardsInstalled
  ) {
    throw new Error("AUTHORING_BACKFILL_LEDGER_PARTIAL");
  }
  if (initial.completedWorkspaceIds.some((workspaceId) =>
    !initial.workspaceIds.includes(workspaceId)
  )) {
    throw new Error("AUTHORING_BACKFILL_LEDGER_INVALID");
  }

  if (initial.guardsInstalled && initial.pendingArticleCount !== 0) {
    throw new Error("AUTHORING_BACKFILL_LEDGER_PARTIAL");
  }
  const alreadyCompleted =
    initial.guardsInstalled && completed.size === initial.workspaceIds.length;
  const useStoredBaselines = initial.guardsInstalled;
  const baselines: TeamAuthoringBaseline[] = [];
  let cursor: TeamAuthoringBackfillCursor | null = null;
  let chunkCount = 0;

  while (true) {
    await store.assertAllWorkspacesPaused();
    const storedRows: readonly TeamAuthoringStoredBaseline[] | null = useStoredBaselines
      ? await store.readMigrationRevisionChunk(cursor, teamAuthoringBackfillChunkSize)
      : null;
    const articles: readonly TeamAuthoringBackfillArticle[] = storedRows
      ? storedRows.map((row) => row.article)
      : await store.readArticleChunk(cursor, teamAuthoringBackfillChunkSize);
    if (articles.length === 0) break;
    const chunk = await Promise.all(articles.map(createTeamAuthoringBaseline));
    if (storedRows) {
      for (const [index, expected] of chunk.entries()) {
        const stored = storedRows[index]!;
        if (
          expected.revisionId !== stored.revisionId ||
          expected.revisionHash !== stored.revisionHash
        ) {
          throw new Error("AUTHORING_BACKFILL_MISMATCH");
        }
      }
    } else {
      await store.applyChunk(chunk);
    }
    baselines.push(...chunk);
    chunkCount += 1;
    cursor = {
      articleId: articles.at(-1)!.articleId,
      workspaceId: articles.at(-1)!.workspaceId,
    };
    if (options.interruptAfterChunks === chunkCount) {
      throw new Error("AUTHORING_BACKFILL_INTERRUPTED");
    }
  }

  const finalInspection = await store.assertAllWorkspacesPaused();
  if (
    finalInspection.workspaceIds.length !== initial.workspaceIds.length ||
    finalInspection.workspaceIds.some(
      (workspaceId, index) => workspaceId !== initial.workspaceIds[index],
    )
  ) {
    throw new Error("AUTHORING_BACKFILL_WORKSPACE_CHANGED");
  }
  const completion = await completionRows(
    initial.workspaceIds,
    baselines,
    options.clock?.() ?? new Date(),
  );
  if (useStoredBaselines) {
    await store.auditCompleted(completion);
  } else {
    await store.audit(completion);
  }
  if (!alreadyCompleted) {
    await store.finalize(completion, !initial.guardsInstalled);
  }

  return {
    alreadyCompleted,
    articleCount: baselines.length,
    chunkCount,
    completion,
  } as const;
}
