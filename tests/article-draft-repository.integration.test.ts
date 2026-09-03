// ABOUTME: Verifies immutable private draft saves across real Postgres and SQLite semantics.
// ABOUTME: Exercises optimistic races, authorization, slug ownership, assets, and public isolation.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import Database from "better-sqlite3";
import { drizzle as createSqliteDatabase } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";

import { articleRevisionHash } from "@/content/article-revision";
import { AuthoringPausedError } from "@/db/authoring-controls";
import type {
  ArchiveArticleRequest,
  ArticleDraftRepository,
  ArticleWorkingHead,
  ArticleWorkflowResult,
  CreateDraftArticleRequest,
  DraftArticleValues,
  DraftActor,
  DraftWriteResult,
  RestoreRevisionAsDraftRequest,
  SaveDraftArticleRequest,
} from "@/db/article-drafts";
import { createPostgresArticleDraftRepository } from "@/db/postgres/article-draft-repository";
import type {
  CategoryDeleteResult,
  CategorySaveResult,
} from "@/db/category-authoring";
import { createPostgresCategoryAuthoringRepository } from "@/db/postgres/category-authoring-repository";
import { postgresTeamAuthoringGuardStatements } from "@/db/postgres/team-authoring-backfill";
import * as postgresSchema from "@/db/schema/postgres";
import * as sqliteSchema from "@/db/schema/sqlite";
import { createSqliteArticleDraftRepository } from "@/db/sqlite/article-draft-repository";
import { createSqliteCategoryAuthoringRepository } from "@/db/sqlite/category-authoring-repository";
import { sqliteTeamAuthoringGuardStatements } from "@/db/sqlite/team-authoring-backfill";

const migrations = {
  postgres: path.join(process.cwd(), "drizzle/postgres"),
  sqlite: path.join(process.cwd(), "drizzle/sqlite"),
};
const now = new Date("2026-09-03T12:00:00.000Z");
const later = new Date(now.getTime() + 60 * 60 * 1000);
const workspaceId = "workspace_drafts";
const ownerMemberId = "member_owner";
const ownerSessionId = "O".repeat(43);
const memberId = "member_editor";
const sessionId = "S".repeat(43);
const reviewerMemberId = "member_reviewer";
const reviewerSessionId = "R".repeat(43);
const categoryId = "category_guides";
const publicArticleId = "article_public";
const publicAssetHash = "a".repeat(64);
const draftAssetHash = "b".repeat(64);

type Inventory = {
  articleAssets: readonly unknown[];
  articles: readonly unknown[];
  embeddingJobs: readonly unknown[];
  evidenceChunks: readonly unknown[];
  indexingState: readonly unknown[];
};

type Harness = {
  name: string;
  repository: ArticleDraftRepository;
  repositoryForReviewEventIds(ids: readonly string[], changedAt?: Date): ArticleDraftRepository;
  repositoryForRevisionId(id: string): ArticleDraftRepository;
  addAsset(id: string, hash: string): Promise<void>;
  addManifest(id: string, hashes: readonly string[]): Promise<void>;
  addPreviewGrant(id: string, revisionId: string): Promise<void>;
  corruptRevisionMdx(id: string, mdx: string, revisionHash: string): Promise<void>;
  deleteCategory(): Promise<CategoryDeleteResult>;
  disableActor(): Promise<void>;
  enableActor(): Promise<void>;
  execute(postgres: string, sqlite: string, values?: readonly unknown[]): Promise<void>;
  inventory(): Promise<Inventory>;
  pauseAuthoring(paused: boolean): Promise<void>;
  renameCategoryThroughRepository(name: string): Promise<void>;
  renameCategorySlug(slug: string): Promise<CategorySaveResult>;
  revokeActorSession(): Promise<void>;
  setMemberStatus(id: string, status: "active" | "disabled"): Promise<void>;
  setActorRole(role: "editor" | "reviewer"): Promise<void>;
  query<T extends object>(postgres: string, sqlite: string, values?: readonly unknown[]): Promise<T[]>;
  removeAssetForCorruption(id: string): Promise<void>;
  revisionCount(articleId: string): Promise<number>;
  close(): Promise<void>;
  lockAndDisableActor?: () => Promise<() => Promise<void>>;
  lockAndDisableMember?: (id: string) => Promise<() => Promise<void>>;
};

const actors = {
  administrator: { memberId: ownerMemberId, sessionId: ownerSessionId },
  editor: { memberId, sessionId },
  reviewer: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
} as const satisfies Record<string, DraftActor>;

function article(id: string, slug: string, title = "Draft title"): DraftArticleValues {
  return {
    id,
    workspaceId,
    categoryId,
    slug,
    title,
    mdx: `# ${title}\n\nPrivate body.`,
    isFaq: false,
    authorName: "Editor",
    position: 1,
  };
}

function createRequest(
  values: DraftArticleValues,
  hashes: readonly string[] = [],
  manifestId?: string,
): CreateDraftArticleRequest {
  return {
    actor: { memberId, sessionId },
    article: values,
    assets: { hashes, ...(manifestId ? { manifestId } : {}) },
    changeKind: "manual",
  };
}

function saveRequest(
  values: DraftArticleValues,
  expectedWorkingRevisionNumber: number,
  hashes: readonly string[] = [],
  manifestId?: string,
): SaveDraftArticleRequest {
  return {
    ...createRequest(values, hashes, manifestId),
    expectedWorkingRevisionNumber,
  };
}

function outcomeCount(results: readonly DraftWriteResult[], status: DraftWriteResult["status"]) {
  return results.filter((result) => result.status === status).length;
}

function workflowTarget<State extends ArticleWorkingHead["reviewState"]>(
  actor: DraftActor,
  head: ArticleWorkingHead,
  expectedReviewState: State,
) {
  return {
    actor,
    articleId: head.article.id,
    expectedReviewState,
    expectedWorkingRevisionNumber: head.revisionNumber,
    revisionId: head.revisionId,
    workspaceId: head.article.workspaceId,
  };
}

function transitioned(result: ArticleWorkflowResult) {
  assert.equal(result.status, "transitioned");
  if (result.status !== "transitioned") {
    throw new Error(`Workflow did not transition: ${JSON.stringify(result)}`);
  }
  return result;
}

async function workingHead(
  harness: Harness,
  actor: DraftActor = actors.editor,
  articleId = publicArticleId,
) {
  const head = await harness.repository.getArticleWorkingHead({
    actor,
    articleId,
    workspaceId,
  });
  assert.ok(head, `${harness.name} returned the authorized working head`);
  return head;
}

async function completeArticleState(harness: Harness) {
  const tables = [
    "articles",
    "article_assets",
    "article_heads",
    "article_revisions",
    "article_revision_assets",
    "article_slug_claims",
    "article_review_events",
    "asset_manifests",
    "asset_manifest_items",
    "assets",
    "embedding_jobs",
    "evidence_chunks",
    "workspace_index_states",
  ] as const;
  const entries = await Promise.all(
    tables.map(async (table) => [
      table,
      await harness.query<Record<string, unknown>>(
        `select * from ${table} where workspace_id = $1 order by 1, 2`,
        `select * from ${table} where workspace_id = ? order by 1, 2`,
        [workspaceId],
      ),
    ] as const),
  );
  return Object.fromEntries(entries);
}

async function publicBaselineRevisionHash() {
  return articleRevisionHash({
    workspaceId,
    articleId: publicArticleId,
    categoryId,
    categorySlug: "guides",
    categoryName: "Guides",
    slug: "public-guide",
    title: "Public guide",
    mdx: "# Public guide\n\nPublic body.",
    isFaq: true,
    authorName: "OPAS",
    position: 0,
    assetHashes: [publicAssetHash],
  });
}

async function exerciseRepository(harness: Harness) {
  const beforePublic = await harness.inventory();
  await harness.addManifest("manifest_concurrent", [draftAssetHash]);
  const simultaneous = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      harness.repository.saveDraftArticle(
        saveRequest(
          {
            ...article(publicArticleId, "private-guide", `Private edit ${index}`),
            mdx: `# Private edit ${index}\n\nConcurrent private body.`,
          },
          1,
          [publicAssetHash, draftAssetHash],
          "manifest_concurrent",
        ),
      ),
    ),
  );
  assert.equal(outcomeCount(simultaneous, "saved"), 1, `${harness.name} accepted one save`);
  assert.equal(outcomeCount(simultaneous, "conflict"), 11, `${harness.name} rejected stale saves`);
  for (const result of simultaneous) {
    if (result.status === "conflict") {
      assert.equal(result.code, "STALE_REVISION");
      assert.equal(result.currentRevisionNumber, 2);
    }
  }

  const winningTitle = (
    simultaneous.find((result) => result.status === "saved") as Extract<
      DraftWriteResult,
      { status: "saved" }
    >
  ).revisionId;
  assert.match(winningTitle, /^revision_/u);
  assert.equal(await harness.revisionCount(publicArticleId), 2);
  assert.deepEqual(await harness.inventory(), beforePublic, `${harness.name} kept public state exact`);

  const [working] = await harness.query<{
    mdx: string;
    revision_number: number;
    title: string;
  }>(
    `select revision.mdx, revision.revision_number, revision.title
     from article_heads head
     inner join article_revisions revision on revision.id = head.working_revision_id
     where head.workspace_id = $1 and head.article_id = $2`,
    `select revision.mdx, revision.revision_number, revision.title
     from article_heads head
     inner join article_revisions revision on revision.id = head.working_revision_id
     where head.workspace_id = ? and head.article_id = ?`,
    [workspaceId, publicArticleId],
  );
  assert.equal(working.revision_number, 2);

  const second = await harness.repository.saveDraftArticle(
    saveRequest(
      {
        ...article(publicArticleId, "private-guide", "Second private save"),
        mdx: "# Second private save\n\nOnly the newer image remains.",
      },
      2,
      [draftAssetHash],
    ),
  );
  assert.equal(second.status, "saved");
  if (second.status !== "saved") throw new Error("Second save did not persist");
  assert.equal(second.revisionNumber, 3);
  assert.deepEqual(await harness.inventory(), beforePublic);

  await harness.addManifest("manifest_noop", [draftAssetHash]);
  const beforeUnchanged = await completeArticleState(harness);
  const unchanged = await harness.repository.saveDraftArticle(
    saveRequest(
      {
        ...article(publicArticleId, "private-guide", "Second private save"),
        mdx: "# Second private save\n\nOnly the newer image remains.",
      },
      3,
      [draftAssetHash],
      "manifest_noop",
    ),
  );
  assert.deepEqual(unchanged, {
    status: "unchanged",
    articleId: publicArticleId,
    revisionId: second.revisionId,
    revisionNumber: 3,
  });
  assert.equal(await harness.revisionCount(publicArticleId), 3);
  assert.deepEqual(await completeArticleState(harness), beforeUnchanged);

  const retained = await harness.query<{ hash: string; revision_number: number }>(
    `select asset.hash, revision_asset.revision_number
     from article_revision_assets revision_asset
     inner join assets asset on asset.id = revision_asset.asset_id
     where revision_asset.workspace_id = $1 and revision_asset.article_id = $2
     order by revision_asset.revision_number, asset.hash`,
    `select asset.hash, revision_asset.revision_number
     from article_revision_assets revision_asset
     inner join assets asset on asset.id = revision_asset.asset_id
     where revision_asset.workspace_id = ? and revision_asset.article_id = ?
     order by revision_asset.revision_number, asset.hash`,
    [workspaceId, publicArticleId],
  );
  assert.deepEqual(retained, [
    { hash: publicAssetHash, revision_number: 1 },
    { hash: publicAssetHash, revision_number: 2 },
    { hash: draftAssetHash, revision_number: 2 },
    { hash: draftAssetHash, revision_number: 3 },
  ]);

  await harness.addManifest("manifest_rejected", [draftAssetHash]);
  const beforeRejected = await completeArticleState(harness);
  const rejectedAsset = await harness.repository.saveDraftArticle(
    saveRequest(
      article(publicArticleId, "private-guide", "Missing asset"),
      3,
      ["f".repeat(64)],
      "manifest_rejected",
    ),
  );
  assert.deepEqual(rejectedAsset, { status: "rejected", code: "ASSET_UNAVAILABLE" });
  assert.deepEqual(await completeArticleState(harness), beforeRejected);
  assert.deepEqual(await harness.inventory(), beforePublic);

  await harness.addManifest("manifest_failed", [draftAssetHash]);
  const beforeFailed = await completeArticleState(harness);
  await assert.rejects(
    harness.repositoryForRevisionId("revision_public_1").saveDraftArticle(
      saveRequest(
        article(publicArticleId, "failed-private", "Failed write"),
        3,
        [draftAssetHash],
        "manifest_failed",
      ),
    ),
  );
  assert.deepEqual(await completeArticleState(harness), beforeFailed);

  const beforeInvalidRevision = await completeArticleState(harness);
  assert.deepEqual(
    await harness.repository.saveDraftArticle(
      saveRequest(article(publicArticleId, "private-guide", "Invalid token"), 0),
    ),
    { status: "rejected", code: "INVALID_REVISION_NUMBER" },
  );
  assert.deepEqual(await completeArticleState(harness), beforeInvalidRevision);

  const beforePaused = await completeArticleState(harness);
  await harness.pauseAuthoring(true);
  await assert.rejects(
    harness.repository.saveDraftArticle(
      saveRequest(article(publicArticleId, "private-guide", "Paused edit"), 3, [draftAssetHash]),
    ),
    AuthoringPausedError,
  );
  await harness.pauseAuthoring(false);
  assert.deepEqual(await completeArticleState(harness), beforePaused);

  const draft = article("article_rename", "old-draft", "Rename me");
  assert.equal((await harness.repository.createDraftArticle(createRequest(draft))).status, "saved");
  const renamed = await harness.repository.saveDraftArticle(
    saveRequest({ ...draft, slug: "renamed-draft", title: "Renamed" }, 1),
  );
  assert.equal(renamed.status, "saved");
  const reused = await harness.repository.createDraftArticle(
    createRequest(article("article_reused", "old-draft", "Old slug reused")),
  );
  assert.equal(reused.status, "saved", `${harness.name} released compatibility slug`);
  const compatibility = await harness.query<{ slug: string }>(
    "select slug from articles where workspace_id = $1 and id = $2",
    "select slug from articles where workspace_id = ? and id = ?",
    [workspaceId, draft.id],
  );
  assert.equal(compatibility[0]?.slug, "renamed-draft");

  const createRace = await Promise.all([
    harness.repository.createDraftArticle(
      createRequest(article("article_create_race_a", "new-race", "Race A")),
    ),
    harness.repository.createDraftArticle(
      createRequest(article("article_create_race_b", "new-race", "Race B")),
    ),
  ]);
  assert.equal(outcomeCount(createRace, "saved"), 1);
  assert.equal(outcomeCount(createRace, "conflict"), 1);
  assert.equal(
    createRace.find((result) => result.status === "conflict")?.code,
    "SLUG_CONFLICT",
  );

  const raceA = article("article_save_race_a", "save-race-a", "Save race A");
  const raceB = article("article_save_race_b", "save-race-b", "Save race B");
  assert.equal((await harness.repository.createDraftArticle(createRequest(raceA))).status, "saved");
  assert.equal((await harness.repository.createDraftArticle(createRequest(raceB))).status, "saved");
  const saveRace = await Promise.all([
    harness.repository.saveDraftArticle(
      saveRequest({ ...raceA, slug: "shared-draft", title: "Save A" }, 1),
    ),
    harness.repository.saveDraftArticle(
      saveRequest({ ...raceB, slug: "shared-draft", title: "Save B" }, 1),
    ),
  ]);
  assert.equal(outcomeCount(saveRace, "saved"), 1);
  assert.equal(outcomeCount(saveRace, "conflict"), 1);
  assert.equal(
    saveRace.find((result) => result.status === "conflict")?.code,
    "SLUG_CONFLICT",
  );

  await harness.disableActor();
  const revisionCountBeforeForbidden = await harness.revisionCount(publicArticleId);
  const forbidden = await harness.repository.saveDraftArticle(
    saveRequest(article(publicArticleId, "private-guide", "Forbidden edit"), 3, [draftAssetHash]),
  );
  assert.deepEqual(forbidden, { status: "rejected", code: "ACTOR_FORBIDDEN" });
  assert.equal(await harness.revisionCount(publicArticleId), revisionCountBeforeForbidden);
  await harness.enableActor();

  await harness.setActorRole("reviewer");
  assert.deepEqual(
    await harness.repository.saveDraftArticle(
      saveRequest(article(publicArticleId, "private-guide", "Reviewer edit"), 3, [draftAssetHash]),
    ),
    { status: "rejected", code: "ACTOR_FORBIDDEN" },
  );
  assert.equal(await harness.revisionCount(publicArticleId), revisionCountBeforeForbidden);
  await harness.setActorRole("editor");

  if (harness.lockAndDisableActor) {
    const releaseDisable = await harness.lockAndDisableActor();
    const racingSave = harness.repository.saveDraftArticle(
      saveRequest(article(publicArticleId, "private-guide", "Disable race"), 3, [draftAssetHash]),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await releaseDisable();
    assert.deepEqual(await racingSave, { status: "rejected", code: "ACTOR_FORBIDDEN" });
    assert.equal(await harness.revisionCount(publicArticleId), revisionCountBeforeForbidden);
    await harness.enableActor();
  }

  await harness.revokeActorSession();
  assert.deepEqual(
    await harness.repository.saveDraftArticle(
      saveRequest(article(publicArticleId, "private-guide", "Revoked edit"), 3, [draftAssetHash]),
    ),
    { status: "rejected", code: "ACTOR_FORBIDDEN" },
  );
  assert.equal(await harness.revisionCount(publicArticleId), revisionCountBeforeForbidden);
}

async function exerciseWorkflow(harness: Harness) {
  const initialPublic = await harness.inventory();
  let head = await workingHead(harness);
  assert.deepEqual(
    {
      article: head.article,
      assetHashes: head.assetHashes,
      createdByMemberId: head.createdByMemberId,
      publicStatus: head.publicStatus,
      publishedRevisionId: head.publishedRevisionId,
      publishedRevisionNumber: head.publishedRevisionNumber,
      reviewState: head.reviewState,
      revisionId: head.revisionId,
      revisionNumber: head.revisionNumber,
    },
    {
      article: {
        id: publicArticleId,
        workspaceId,
        categoryId,
        slug: "public-guide",
        title: "Public guide",
        mdx: "# Public guide\n\nPublic body.",
        isFaq: true,
        authorName: "OPAS",
        position: 0,
      },
      assetHashes: [publicAssetHash],
      createdByMemberId: memberId,
      publicStatus: "published",
      publishedRevisionId: "revision_public_1",
      publishedRevisionNumber: 1,
      reviewState: "published",
      revisionId: "revision_public_1",
      revisionNumber: 1,
    },
  );

  await harness.addManifest("manifest_workflow", [draftAssetHash]);
  for (let index = 1; index <= 10; index += 1) {
    const title = `Private workflow ${index}`;
    const saved = await harness.repository.saveDraftArticle(
      saveRequest(
        {
          ...article(publicArticleId, "reviewed-guide", title),
          mdx: `# ${title}\n\nPrivate revision ${index}.`,
        },
        head.revisionNumber,
        [draftAssetHash],
        index === 1 ? "manifest_workflow" : undefined,
      ),
    );
    assert.equal(saved.status, "saved");
    if (saved.status !== "saved") throw new Error("Private workflow save failed");
    head = await workingHead(harness);
    assert.equal(head.revisionId, saved.revisionId);
    assert.equal(head.revisionNumber, index + 1);
    assert.equal(head.reviewState, "editing");
    assert.deepEqual(
      await harness.inventory(),
      initialPublic,
      `${harness.name} private save ${index} changed the public projection`,
    );
  }
  assert.equal(head.article.title, "Private workflow 10");
  assert.equal(head.createdByMemberId, memberId);
  assert.equal(head.changeKind, "manual");
  assert.deepEqual(head.assetHashes, [draftAssetHash]);

  const editingTarget = workflowTarget(actors.editor, head, "editing");
  const beforeInvalidRevision = await completeArticleState(harness);
  assert.deepEqual(
    await harness.repository.submitArticleForReview({
      ...editingTarget,
      expectedWorkingRevisionNumber: 0,
    }),
    { status: "rejected", code: "INVALID_REVISION_NUMBER" },
  );
  assert.deepEqual(await completeArticleState(harness), beforeInvalidRevision);

  const beforePaused = await completeArticleState(harness);
  await harness.pauseAuthoring(true);
  await assert.rejects(
    harness.repository.submitArticleForReview(editingTarget),
    AuthoringPausedError,
  );
  await harness.pauseAuthoring(false);
  assert.deepEqual(await completeArticleState(harness), beforePaused);

  const beforeCategoryRace = await harness.inventory();
  const [, categoryRace] = await Promise.all([
    harness.renameCategoryThroughRepository("Guides changed"),
    harness.repository.submitArticleForReview(editingTarget),
  ]);
  assert.ok(
    categoryRace.status === "transitioned" ||
      (categoryRace.status === "rejected" && categoryRace.code === "CATEGORY_CHANGED"),
  );
  assert.deepEqual(await harness.inventory(), beforeCategoryRace);
  await harness.renameCategoryThroughRepository("Guides");
  head = await workingHead(harness);
  if (head.reviewState === "changes_requested") {
    const recapturedCategory = await harness.repository.saveDraftArticle(
      saveRequest(
        { ...head.article, title: `${head.article.title} after category review` },
        head.revisionNumber,
        head.assetHashes,
      ),
    );
    assert.equal(recapturedCategory.status, "saved");
    head = await workingHead(harness);
  }
  assert.equal(head.reviewState, "editing");

  const submitted = transitioned(
    await harness.repository.submitArticleForReview({
      ...workflowTarget(actors.editor, head, "editing"),
      note: "Ready for review",
    }),
  );
  assert.equal(submitted.action, "submitted");
  head = await workingHead(harness);
  assert.equal(head.reviewState, "in_review");
  assert.deepEqual(await harness.inventory(), initialPublic);

  const beforeInvalidNote = await completeArticleState(harness);
  await assert.rejects(
    harness.repository.requestArticleChanges({
      ...workflowTarget(actors.reviewer, head, "in_review"),
      note: " ",
    }),
    /review note is required/iu,
  );
  assert.deepEqual(await completeArticleState(harness), beforeInvalidNote);

  assert.deepEqual(
    await harness.repository.saveDraftArticle(
      saveRequest(
        { ...head.article, title: "Edit while submitted" },
        head.revisionNumber,
        head.assetHashes,
      ),
    ),
    { status: "rejected", code: "INVALID_REVIEW_STATE" },
  );
  assert.deepEqual(
    await harness.repository.submitArticleForReview({
      ...workflowTarget(actors.editor, head, "in_review"),
      expectedReviewState: "editing",
    }),
    {
      status: "conflict",
      code: "INVALID_REVIEW_STATE",
      currentRevisionNumber: head.revisionNumber,
      currentReviewState: "in_review",
    },
  );

  const markedExistingRequest = {
    ...createRequest({
      ...head.article,
      slug: "import-collision",
      title: "Published-marked collision",
    }),
    article: {
      ...head.article,
      slug: "import-collision",
      title: "Published-marked collision",
      status: "published" as const,
    },
    changeKind: "import" as const,
  };
  const beforeImportConflict = await completeArticleState(harness);
  assert.deepEqual(
    await harness.repository.createDraftArticle(markedExistingRequest),
    { status: "conflict", code: "ARTICLE_EXISTS" },
  );
  assert.deepEqual(await completeArticleState(harness), beforeImportConflict);

  assert.deepEqual(
    await harness.repository.withdrawArticleReview(
      workflowTarget(actors.administrator, head, "in_review"),
    ),
    { status: "rejected", code: "ACTOR_FORBIDDEN" },
  );
  transitioned(
    await harness.repository.withdrawArticleReview({
      ...workflowTarget(actors.editor, head, "in_review"),
      note: "One more pass",
    }),
  );
  head = await workingHead(harness);
  assert.equal(head.reviewState, "editing");
  transitioned(
    await harness.repository.submitArticleForReview(
      workflowTarget(actors.editor, head, "editing"),
    ),
  );
  head = await workingHead(harness);

  const reviewRace = await Promise.all([
    harness.repository.requestArticleChanges({
      ...workflowTarget(actors.reviewer, head, "in_review"),
      note: "Clarify this answer",
    }),
    harness.repository.approveArticleRevision({
      ...workflowTarget(actors.administrator, head, "in_review"),
      note: "Approved",
    }),
  ]);
  assert.equal(
    reviewRace.filter((result) => result.status === "transitioned").length,
    1,
  );
  assert.equal(reviewRace.filter((result) => result.status === "conflict").length, 1);
  assert.equal(
    reviewRace.find((result) => result.status === "conflict")?.code,
    "INVALID_REVIEW_STATE",
  );
  head = await workingHead(harness);
  assert.ok(head.reviewState === "approved" || head.reviewState === "changes_requested");
  assert.deepEqual(await harness.inventory(), initialPublic);

  if (head.reviewState === "changes_requested") {
    const corrected = await harness.repository.saveDraftArticle(
      saveRequest(
        {
          ...head.article,
          title: "Reviewed correction",
          mdx: "# Reviewed correction\n\nThe requested clarification.",
        },
        head.revisionNumber,
        head.assetHashes,
      ),
    );
    assert.equal(corrected.status, "saved");
    head = await workingHead(harness);
    transitioned(
      await harness.repository.submitArticleForReview(
        workflowTarget(actors.editor, head, "editing"),
      ),
    );
    head = await workingHead(harness);
    transitioned(
      await harness.repository.approveArticleRevision(
        workflowTarget(actors.reviewer, head, "in_review"),
      ),
    );
    head = await workingHead(harness);
  }
  assert.equal(head.reviewState, "approved");

  const staleApprovedHead = head;
  const editedAfterApproval = await harness.repository.saveDraftArticle(
    saveRequest(
      {
        ...head.article,
        title: "Final reviewed guide",
        mdx: "# Final reviewed guide\n\nThis is the exact publish candidate.",
      },
      head.revisionNumber,
      head.assetHashes,
    ),
  );
  assert.equal(editedAfterApproval.status, "saved");
  head = await workingHead(harness);
  assert.equal(head.reviewState, "editing");
  assert.deepEqual(
    await harness.repository.publishArticleRevision(
      workflowTarget(actors.reviewer, staleApprovedHead, "approved"),
    ),
    {
      status: "conflict",
      code: "STALE_REVISION",
      currentRevisionNumber: head.revisionNumber,
      currentReviewState: "editing",
    },
  );
  assert.deepEqual(await harness.inventory(), initialPublic);

  transitioned(
    await harness.repository.submitArticleForReview(
      workflowTarget(actors.administrator, head, "editing"),
    ),
  );
  head = await workingHead(harness);
  assert.deepEqual(
    await harness.repository.approveArticleRevision(
      workflowTarget(actors.administrator, head, "in_review"),
    ),
    { status: "rejected", code: "SELF_APPROVAL_FORBIDDEN" },
  );
  transitioned(
    await harness.repository.approveArticleRevision(
      workflowTarget(actors.reviewer, head, "in_review"),
    ),
  );
  head = await workingHead(harness);
  assert.equal(head.reviewState, "approved");

  let approvedTarget = workflowTarget(actors.reviewer, head, "approved");
  const beforePublishCategoryRace = await harness.inventory();
  await harness.renameCategoryThroughRepository("Guides changed again");
  const categoryPublishRace = await harness.repository.publishArticleRevision(approvedTarget);
  assert.deepEqual(categoryPublishRace, {
    status: "conflict",
    code: "INVALID_REVIEW_STATE",
    currentRevisionNumber: head.revisionNumber,
    currentReviewState: "changes_requested",
  });
  assert.deepEqual(await harness.inventory(), beforePublishCategoryRace);
  await harness.renameCategoryThroughRepository("Guides");
  head = await workingHead(harness);
  assert.equal(head.reviewState, "changes_requested");
  const recapturedAfterCategoryChange = await harness.repository.saveDraftArticle(
    saveRequest(
      {
        ...head.article,
        title: `${head.article.title} after category change`,
        mdx: `# ${head.article.title} after category change\n\nRecaptured category snapshot.`,
      },
      head.revisionNumber,
      head.assetHashes,
    ),
  );
  assert.equal(recapturedAfterCategoryChange.status, "saved");
  head = await workingHead(harness);
  transitioned(
    await harness.repository.submitArticleForReview(
      workflowTarget(actors.administrator, head, "editing"),
    ),
  );
  head = await workingHead(harness);
  transitioned(
    await harness.repository.approveArticleRevision(
      workflowTarget(actors.reviewer, head, "in_review"),
    ),
  );
  head = await workingHead(harness);
  approvedTarget = workflowTarget(actors.reviewer, head, "approved");
  assert.deepEqual(await harness.deleteCategory(), {
    status: "rejected",
    code: "CATEGORY_REFERENCED",
  });
  assert.deepEqual(await harness.renameCategorySlug("renamed-guides"), {
    status: "rejected",
    code: "LIVE_CATEGORY_SLUG",
  });

  const beforeDisabledPublish = await harness.inventory();
  if (harness.lockAndDisableMember) {
    const releaseDisable = await harness.lockAndDisableMember(reviewerMemberId);
    const pendingPublish = harness.repository.publishArticleRevision(approvedTarget);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await releaseDisable();
    assert.deepEqual(await pendingPublish, {
      status: "rejected",
      code: "ACTOR_FORBIDDEN",
    });
  } else {
    await harness.setMemberStatus(reviewerMemberId, "disabled");
    assert.deepEqual(
      await harness.repository.publishArticleRevision(approvedTarget),
      { status: "rejected", code: "ACTOR_FORBIDDEN" },
    );
  }
  assert.equal(
    await harness.repository.getArticleWorkingHead({
      actor: actors.reviewer,
      articleId: publicArticleId,
      workspaceId,
    }),
    null,
  );
  await harness.setMemberStatus(reviewerMemberId, "active");
  assert.deepEqual(await harness.inventory(), beforeDisabledPublish);

  const publishRace = await Promise.all([
    harness.repository.publishArticleRevision(approvedTarget),
    harness.repository.publishArticleRevision({
      ...approvedTarget,
      actor: actors.administrator,
    }),
  ]);
  assert.equal(publishRace.filter((result) => result.status === "transitioned").length, 1);
  assert.equal(publishRace.filter((result) => result.status === "conflict").length, 1);
  assert.equal(
    publishRace.find((result) => result.status === "conflict")?.code,
    "INVALID_REVIEW_STATE",
  );
  const publishedResult = transitioned(
    publishRace.find((result) => result.status === "transitioned") as ArticleWorkflowResult,
  );
  assert.equal(publishedResult.action, "published");
  assert.ok(publishedResult.evidenceJobId);
  assert.notDeepEqual(await harness.inventory(), initialPublic);

  head = await workingHead(harness);
  assert.equal(head.reviewState, "published");
  assert.equal(head.publicStatus, "published");
  assert.equal(head.publishedRevisionId, head.revisionId);
  assert.equal(head.publishedRevisionNumber, head.revisionNumber);
  const [publicArticle] = await harness.query<{
    author_name: string;
    category_id: string;
    content_hash: string | null;
    is_faq: boolean | number;
    mdx: string;
    position: number;
    published_at: Date | number | null;
    slug: string;
    status: string;
    title: string;
  }>(
    `select author_name, category_id, content_hash, is_faq, mdx, position,
            published_at, slug, status, title
     from articles where workspace_id = $1 and id = $2`,
    `select author_name, category_id, content_hash, is_faq, mdx, position,
            published_at, slug, status, title
     from articles where workspace_id = ? and id = ?`,
    [workspaceId, publicArticleId],
  );
  assert.deepEqual(
    {
      authorName: publicArticle.author_name,
      categoryId: publicArticle.category_id,
      isFaq: Boolean(publicArticle.is_faq),
      mdx: publicArticle.mdx,
      position: publicArticle.position,
      slug: publicArticle.slug,
      status: publicArticle.status,
      title: publicArticle.title,
    },
    {
      authorName: head.article.authorName,
      categoryId: head.article.categoryId,
      isFaq: head.article.isFaq,
      mdx: head.article.mdx,
      position: head.article.position,
      slug: head.article.slug,
      status: "published",
      title: head.article.title,
    },
  );
  assert.ok(publicArticle.content_hash);
  assert.ok(publicArticle.published_at);
  const publicAssets = await harness.query<{ hash: string }>(
    `select asset.hash from article_assets link
     inner join assets asset on asset.id = link.asset_id and asset.workspace_id = link.workspace_id
     where link.workspace_id = $1 and link.article_id = $2 order by asset.hash`,
    `select asset.hash from article_assets link
     inner join assets asset on asset.id = link.asset_id and asset.workspace_id = link.workspace_id
     where link.workspace_id = ? and link.article_id = ? order by asset.hash`,
    [workspaceId, publicArticleId],
  );
  assert.deepEqual(publicAssets, [{ hash: draftAssetHash }]);
  const evidence = await harness.query<{
    article_content_hash: string;
    canonical_url: string;
    publication_state: string;
  }>(
    `select article_content_hash, canonical_url, publication_state from evidence_chunks
     where workspace_id = $1 and article_id = $2 order by ordinal`,
    `select article_content_hash, canonical_url, publication_state from evidence_chunks
     where workspace_id = ? and article_id = ? order by ordinal`,
    [workspaceId, publicArticleId],
  );
  assert.ok(evidence.length >= 1);
  assert.ok(evidence.every((row) => row.article_content_hash === publicArticle.content_hash));
  assert.ok(evidence.every((row) => row.publication_state === "published"));
  assert.ok(
    evidence.every(
      (row) => row.canonical_url === "https://help.example.test/guides/reviewed-guide",
    ),
  );
  const firstPublicationJobs = await harness.query<{
    article_content_hash: string;
    index_generation: number;
    status: string;
  }>(
    `select article_content_hash, index_generation, status from embedding_jobs
     where workspace_id = $1 and article_id = $2 order by id`,
    `select article_content_hash, index_generation, status from embedding_jobs
     where workspace_id = ? and article_id = ? order by id`,
    [workspaceId, publicArticleId],
  );
  assert.deepEqual(firstPublicationJobs, [
    {
      article_content_hash: publicArticle.content_hash,
      index_generation: 1,
      status: "pending",
    },
  ]);
  const [firstIndexState] = await harness.query<{ generation: number }>(
    "select generation from workspace_index_states where workspace_id = $1",
    "select generation from workspace_index_states where workspace_id = ?",
    [workspaceId],
  );
  assert.equal(firstIndexState.generation, 1);
  const publicationEvents = await harness.query<{ action: string }>(
    `select action from article_review_events
     where workspace_id = $1 and article_id = $2 and action = 'published'`,
    `select action from article_review_events
     where workspace_id = ? and article_id = ? and action = 'published'`,
    [workspaceId, publicArticleId],
  );
  assert.deepEqual(publicationEvents, [{ action: "published" }]);

  const firstPublishedRevisionId = head.revisionId;
  const firstPublishedRevisionNumber = head.revisionNumber;
  transitioned(
    await harness.repository.unpublishArticle({
      ...workflowTarget(actors.reviewer, head, "published"),
      note: "Temporarily offline",
    }),
  );
  head = await workingHead(harness);
  assert.equal(head.reviewState, "approved");
  assert.equal(head.publicStatus, "draft");
  assert.equal(head.publishedRevisionId, firstPublishedRevisionId);
  assert.equal(head.publishedRevisionNumber, firstPublishedRevisionNumber);
  let [publicationState] = await harness.query<{
    content_hash: string | null;
    generation: number;
    status: string;
  }>(
    `select article.content_hash, article.status, state.generation
     from articles article
     inner join workspace_index_states state on state.workspace_id = article.workspace_id
     where article.workspace_id = $1 and article.id = $2`,
    `select article.content_hash, article.status, state.generation
     from articles article
     inner join workspace_index_states state on state.workspace_id = article.workspace_id
     where article.workspace_id = ? and article.id = ?`,
    [workspaceId, publicArticleId],
  );
  assert.deepEqual(publicationState, {
    content_hash: null,
    generation: 2,
    status: "draft",
  });
  const [remainingEvidence] = await harness.query<{ count: number | string }>(
    "select count(*) as count from evidence_chunks where workspace_id = $1 and article_id = $2",
    "select count(*) as count from evidence_chunks where workspace_id = ? and article_id = ?",
    [workspaceId, publicArticleId],
  );
  assert.equal(Number(remainingEvidence.count), 0);

  const beforeEmergencyFailures = await completeArticleState(harness);
  await assert.rejects(
    harness.repositoryForReviewEventIds([publishedResult.eventId]).emergencyPublishArticle({
      ...workflowTarget(actors.administrator, head, "approved"),
      reason: "This transaction must roll back",
    }),
  );
  await assert.rejects(
    harness.repository.emergencyPublishArticle({
      ...workflowTarget(actors.administrator, head, "approved"),
      reason: " ",
    }),
    /review note is required/iu,
  );
  assert.deepEqual(
    await harness.repository.emergencyPublishArticle({
      ...workflowTarget(actors.editor, head, "approved"),
      reason: "Incorrect actor",
    }),
    { status: "rejected", code: "ACTOR_FORBIDDEN" },
  );
  assert.deepEqual(await completeArticleState(harness), beforeEmergencyFailures);
  const emergency = transitioned(
    await harness.repository.emergencyPublishArticle({
      ...workflowTarget(actors.administrator, head, "approved"),
      reason: "Urgent support correction",
    }),
  );
  assert.equal(emergency.action, "emergency_published");
  head = await workingHead(harness);
  assert.equal(head.reviewState, "published");
  assert.equal(head.publicStatus, "published");

  const republishedPublic = await harness.inventory();
  const newerPrivate = await harness.repository.saveDraftArticle(
    saveRequest(
      {
        ...head.article,
        title: "Private follow-up",
        mdx: "# Private follow-up\n\nThis revision has not been published.",
      },
      head.revisionNumber,
      head.assetHashes,
    ),
  );
  assert.equal(newerPrivate.status, "saved");
  head = await workingHead(harness);
  assert.equal(head.reviewState, "editing");
  assert.equal(head.publicStatus, "published");
  assert.equal(head.publishedRevisionId, firstPublishedRevisionId);
  assert.deepEqual(await harness.inventory(), republishedPublic);
  transitioned(
    await harness.repository.unpublishArticle(
      workflowTarget(actors.reviewer, head, "editing"),
    ),
  );
  head = await workingHead(harness);
  assert.equal(head.reviewState, "editing");
  assert.equal(head.publicStatus, "draft");
  assert.equal(head.publishedRevisionId, firstPublishedRevisionId);
  assert.notEqual(head.revisionId, firstPublishedRevisionId);
  const unpublishedEvents = await harness.query<{
    revision_id: string;
    revision_number: number;
  }>(
    `select revision_id, revision_number from article_review_events
     where workspace_id = $1 and article_id = $2 and action = 'unpublished'
     order by created_at, id`,
    `select revision_id, revision_number from article_review_events
     where workspace_id = ? and article_id = ? and action = 'unpublished'
     order by created_at, id`,
    [workspaceId, publicArticleId],
  );
  assert.deepEqual(unpublishedEvents.at(-1), {
    revision_id: firstPublishedRevisionId,
    revision_number: firstPublishedRevisionNumber,
  });
  [publicationState] = await harness.query<{
    content_hash: string | null;
    generation: number;
    status: string;
  }>(
    `select article.content_hash, article.status, state.generation
     from articles article
     inner join workspace_index_states state on state.workspace_id = article.workspace_id
     where article.workspace_id = $1 and article.id = $2`,
    `select article.content_hash, article.status, state.generation
     from articles article
     inner join workspace_index_states state on state.workspace_id = article.workspace_id
     where article.workspace_id = ? and article.id = ?`,
    [workspaceId, publicArticleId],
  );
  assert.deepEqual(publicationState, {
    content_hash: null,
    generation: 4,
    status: "draft",
  });
  const finalJobs = await harness.query<{ status: string }>(
    `select status from embedding_jobs
     where workspace_id = $1 and article_id = $2 order by id`,
    `select status from embedding_jobs
     where workspace_id = ? and article_id = ? order by id`,
    [workspaceId, publicArticleId],
  );
  assert.deepEqual(finalJobs, [{ status: "superseded" }, { status: "superseded" }]);
  const emergencyEvents = await harness.query<{ note: string | null }>(
    `select note from article_review_events
     where workspace_id = $1 and article_id = $2 and action = 'emergency_published'`,
    `select note from article_review_events
     where workspace_id = ? and article_id = ? and action = 'emergency_published'`,
    [workspaceId, publicArticleId],
  );
  assert.deepEqual(emergencyEvents, [{ note: "Urgent support correction" }]);

  const combinedArticleId = "article_combined_publish";
  assert.equal(
    (
      await harness.repository.createDraftArticle({
        ...createRequest(article(combinedArticleId, "combined-publish")),
        actor: actors.administrator,
      })
    ).status,
    "saved",
  );
  let combinedHead = await workingHead(harness, actors.administrator, combinedArticleId);
  const reverseClockRepository = harness.repositoryForReviewEventIds(
    ["review_event_zzzz", "review_event_yyyy", "review_event_xxxx"],
    new Date(now.getTime() - 86_400_000),
  );
  transitioned(
    await reverseClockRepository.submitArticleForReview(
      workflowTarget(actors.editor, combinedHead, "editing"),
    ),
  );
  combinedHead = await workingHead(harness, actors.administrator, combinedArticleId);
  assert.equal(combinedHead.submittedByMemberId, memberId);
  transitioned(
    await reverseClockRepository.withdrawArticleReview(
      workflowTarget(actors.editor, combinedHead, "in_review"),
    ),
  );
  combinedHead = await workingHead(harness, actors.administrator, combinedArticleId);
  assert.equal(combinedHead.submittedByMemberId, null);
  transitioned(
    await reverseClockRepository.submitArticleForReview(
      workflowTarget(actors.administrator, combinedHead, "editing"),
    ),
  );
  combinedHead = await workingHead(harness, actors.administrator, combinedArticleId);
  assert.equal(combinedHead.submittedByMemberId, ownerMemberId);
  assert.deepEqual(
    await harness.repository.approveArticleRevision(
      workflowTarget(actors.administrator, combinedHead, "in_review"),
    ),
    { status: "rejected", code: "SELF_APPROVAL_FORBIDDEN" },
  );
  transitioned(
    await harness.repository.withdrawArticleReview(
      workflowTarget(actors.administrator, combinedHead, "in_review"),
    ),
  );
  combinedHead = await workingHead(harness, actors.administrator, combinedArticleId);
  const combinedSubmission = transitioned(
    await harness.repository.submitArticleForReview(
      workflowTarget(actors.editor, combinedHead, "editing"),
    ),
  );
  combinedHead = await workingHead(harness, actors.administrator, combinedArticleId);
  assert.deepEqual(
    await harness.repository.approveAndPublishArticleRevision({
      ...workflowTarget(actors.administrator, combinedHead, "in_review"),
      note: "Creator cannot approve",
    }),
    { status: "rejected", code: "SELF_APPROVAL_FORBIDDEN" },
  );
  let combinedTarget = {
    ...workflowTarget(actors.reviewer, combinedHead, "in_review"),
    note: "Approved and published",
  };
  await harness.renameCategoryThroughRepository("Combined category race");
  assert.deepEqual(
    await harness.repository.approveAndPublishArticleRevision(combinedTarget),
    {
      status: "conflict",
      code: "INVALID_REVIEW_STATE",
      currentRevisionNumber: combinedHead.revisionNumber,
      currentReviewState: "changes_requested",
    },
  );
  await harness.renameCategoryThroughRepository("Guides");
  combinedHead = await workingHead(harness, actors.administrator, combinedArticleId);
  assert.equal(combinedHead.reviewState, "changes_requested");
  const recapturedCombinedCategory = await harness.repository.saveDraftArticle(
    saveRequest(
      {
        ...combinedHead.article,
        title: "Combined publication after category change",
        mdx: "# Combined publication after category change\n\nRecaptured category snapshot.",
      },
      combinedHead.revisionNumber,
      combinedHead.assetHashes,
    ),
  );
  assert.equal(recapturedCombinedCategory.status, "saved");
  combinedHead = await workingHead(harness, actors.administrator, combinedArticleId);
  transitioned(
    await harness.repository.submitArticleForReview(
      workflowTarget(actors.editor, combinedHead, "editing"),
    ),
  );
  combinedHead = await workingHead(harness, actors.administrator, combinedArticleId);
  combinedTarget = {
    ...workflowTarget(actors.reviewer, combinedHead, "in_review"),
    note: "Approved and published",
  };
  const beforeCombinedFailures = await completeArticleState(harness);
  if (harness.lockAndDisableMember) {
    const releaseDisable = await harness.lockAndDisableMember(reviewerMemberId);
    const pending = harness.repository.approveAndPublishArticleRevision(combinedTarget);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await releaseDisable();
    assert.deepEqual(await pending, { status: "rejected", code: "ACTOR_FORBIDDEN" });
  } else {
    await harness.setMemberStatus(reviewerMemberId, "disabled");
    assert.deepEqual(
      await harness.repository.approveAndPublishArticleRevision(combinedTarget),
      { status: "rejected", code: "ACTOR_FORBIDDEN" },
    );
  }
  await harness.setMemberStatus(reviewerMemberId, "active");
  await assert.rejects(
    harness
      .repositoryForReviewEventIds([
        "review_event_combined_approval_rollback",
        combinedSubmission.eventId,
      ])
      .approveAndPublishArticleRevision(combinedTarget),
  );
  assert.deepEqual(await completeArticleState(harness), beforeCombinedFailures);
  const combinedPublication = transitioned(
    await harness.repository.approveAndPublishArticleRevision(combinedTarget),
  );
  assert.ok(combinedPublication.approvalEventId);
  assert.ok(combinedPublication.evidenceJobId);
  const combinedEvents = await harness.query<{ action: string; id: string }>(
    `select id, action from article_review_events
     where workspace_id = $1 and article_id = $2 order by created_at, id`,
    `select id, action from article_review_events
     where workspace_id = ? and article_id = ? order by created_at, id`,
    [workspaceId, combinedArticleId],
  );
  assert.deepEqual(combinedEvents.slice(-2), [
    { action: "approved", id: combinedPublication.approvalEventId },
    { action: "published", id: combinedPublication.eventId },
  ]);

  const markedImport = {
    ...createRequest(article("article_marked_import", "marked-import", "Marked import")),
    article: {
      ...article("article_marked_import", "marked-import", "Marked import"),
      status: "published" as const,
    },
    changeKind: "import" as const,
  };
  const beforeMarkedImportPublic = await harness.inventory();
  assert.equal(
    (await harness.repository.createDraftArticle(markedImport)).status,
    "saved",
  );
  assert.deepEqual(await harness.inventory(), beforeMarkedImportPublic);
  const [importState] = await harness.query<{
    content_hash: string | null;
    published_revision_id: string | null;
    review_state: string;
    status: string;
  }>(
    `select article.content_hash, article.status, head.published_revision_id, head.review_state
     from articles article
     inner join article_heads head on head.workspace_id = article.workspace_id and head.article_id = article.id
     where article.workspace_id = $1 and article.id = 'article_marked_import'`,
    `select article.content_hash, article.status, head.published_revision_id, head.review_state
     from articles article
     inner join article_heads head on head.workspace_id = article.workspace_id and head.article_id = article.id
     where article.workspace_id = ? and article.id = 'article_marked_import'`,
    [workspaceId],
  );
  assert.deepEqual(importState, {
    content_hash: null,
    published_revision_id: null,
    review_state: "editing",
    status: "draft",
  });

  const categoryRaceArticle = article(
    "article_category_repository_race",
    "category-repository-race",
    "Category repository race",
  );
  assert.equal(
    (await harness.repository.createDraftArticle(createRequest(categoryRaceArticle))).status,
    "saved",
  );
  let categoryRaceHead = await workingHead(
    harness,
    actors.editor,
    categoryRaceArticle.id,
  );
  const [categoryRaceSubmission, deleteDuringSubmit, slugDuringSubmit] =
    await Promise.all([
      harness.repository.submitArticleForReview(
        workflowTarget(actors.editor, categoryRaceHead, "editing"),
      ),
      harness.deleteCategory(),
      harness.renameCategorySlug("guides-during-submit"),
    ]);
  assert.equal(categoryRaceSubmission.status, "transitioned");
  assert.deepEqual(deleteDuringSubmit, {
    status: "rejected",
    code: "CATEGORY_REFERENCED",
  });
  assert.deepEqual(slugDuringSubmit, {
    status: "rejected",
    code: "LIVE_CATEGORY_SLUG",
  });
  categoryRaceHead = await workingHead(
    harness,
    actors.editor,
    categoryRaceArticle.id,
  );
  transitioned(
    await harness.repository.approveArticleRevision(
      workflowTarget(actors.reviewer, categoryRaceHead, "in_review"),
    ),
  );
  categoryRaceHead = await workingHead(
    harness,
    actors.editor,
    categoryRaceArticle.id,
  );
  const [categoryRacePublication, deleteDuringPublish, slugDuringPublish] =
    await Promise.all([
      harness.repository.publishArticleRevision(
        workflowTarget(actors.reviewer, categoryRaceHead, "approved"),
      ),
      harness.deleteCategory(),
      harness.renameCategorySlug("guides-during-publish"),
    ]);
  assert.equal(categoryRacePublication.status, "transitioned");
  assert.deepEqual(deleteDuringPublish, {
    status: "rejected",
    code: "CATEGORY_REFERENCED",
  });
  assert.deepEqual(slugDuringPublish, {
    status: "rejected",
    code: "LIVE_CATEGORY_SLUG",
  });
}

function archiveTarget(
  actor: DraftActor,
  head: ArticleWorkingHead,
): ArchiveArticleRequest {
  return {
    actor,
    articleId: head.article.id,
    expectedPublicStatus: head.publicStatus,
    expectedReviewState: head.reviewState,
    expectedWorkingRevisionNumber: head.revisionNumber,
    revisionId: head.revisionId,
    workspaceId: head.article.workspaceId,
  };
}

async function exerciseHistoryAndRecovery(harness: Harness) {
  const initialPublic = await harness.inventory();
  const initialDetailRequest = {
    actor: actors.reviewer,
    articleId: publicArticleId,
    revisionId: "revision_public_1",
    revisionNumber: 1,
    workspaceId,
  } as const;
  const initialHistory = await harness.repository.listArticleRevisionHistory({
    actor: actors.reviewer,
    articleId: publicArticleId,
    limit: 100,
    workspaceId,
  });
  assert.ok(initialHistory);
  assert.deepEqual(initialHistory.items.map((item) => item.revisionNumber), [1]);
  assert.equal(initialHistory.items[0]?.createdByDisplayName, "Editor");
  assert.ok(await harness.repository.getArticleRevisionDetail(initialDetailRequest));
  await harness.setMemberStatus(reviewerMemberId, "disabled");
  assert.equal(
    await harness.repository.listArticleRevisionHistory({
      actor: actors.reviewer,
      articleId: publicArticleId,
      workspaceId,
    }),
    null,
  );
  assert.equal(
    await harness.repository.getArticleRevisionDetail(initialDetailRequest),
    null,
  );
  await harness.setMemberStatus(reviewerMemberId, "active");
  await harness.execute(
    "update workspace_members set role = 'editor', updated_at = current_timestamp where workspace_id = $1 and id = $2",
    "update workspace_members set role = 'editor', updated_at = unixepoch() * 1000 where workspace_id = ? and id = ?",
    [workspaceId, reviewerMemberId],
  );
  assert.ok(
    await harness.repository.listArticleRevisionHistory({
      actor: actors.reviewer,
      articleId: publicArticleId,
      workspaceId,
    }),
  );
  assert.ok(await harness.repository.getArticleRevisionDetail(initialDetailRequest));
  await harness.execute(
    "update workspace_members set role = 'reviewer', updated_at = current_timestamp where workspace_id = $1 and id = $2",
    "update workspace_members set role = 'reviewer', updated_at = unixepoch() * 1000 where workspace_id = ? and id = ?",
    [workspaceId, reviewerMemberId],
  );
  assert.equal(
    await harness.repository.listArticleRevisionHistory({
      actor: { memberId: reviewerMemberId, sessionId: "X".repeat(43) },
      articleId: publicArticleId,
      workspaceId,
    }),
    null,
  );

  const boundedArticle = article(
    "article_bounded_history",
    "bounded-history",
    "Bounded history 1",
  );
  assert.equal(
    (await harness.repository.createDraftArticle(createRequest(boundedArticle))).status,
    "saved",
  );
  for (let revisionNumber = 1; revisionNumber <= 20; revisionNumber += 1) {
    const nextNumber = revisionNumber + 1;
    assert.equal(
      (
        await harness.repository.saveDraftArticle(
          saveRequest(
            {
              ...boundedArticle,
              title: `Bounded history ${nextNumber}`,
              mdx: `# Bounded history ${nextNumber}\n\nRevision ${nextNumber}.`,
            },
            revisionNumber,
          ),
        )
      ).status,
      "saved",
    );
  }
  const boundedHistory = await harness.repository.listArticleRevisionHistory({
    actor: actors.reviewer,
    articleId: boundedArticle.id,
    limit: 1_000,
    workspaceId,
  });
  assert.ok(boundedHistory);
  assert.equal(boundedHistory.items.length, 20);
  assert.deepEqual(
    boundedHistory.items.map((item) => item.revisionNumber),
    Array.from({ length: 20 }, (_, index) => 21 - index),
  );
  assert.equal(boundedHistory.nextBeforeRevisionNumber, 2);
  const boundedLatest = boundedHistory.items[0]!;
  for (let index = 0; index < 51; index += 1) {
    await harness.execute(
      `insert into article_review_events (
         id, workspace_id, article_id, revision_id, revision_number,
         member_id, action, note, created_at
       ) values ($1, $2, $3, $4, $5, $6, 'restored', null, current_timestamp)`,
      `insert into article_review_events (
         id, workspace_id, article_id, revision_id, revision_number,
         member_id, action, note, created_at
       ) values (?, ?, ?, ?, ?, ?, 'restored', null, unixepoch() * 1000)`,
      [
        `review_event_history_cap_${String(index).padStart(2, "0")}`,
        workspaceId,
        boundedArticle.id,
        boundedLatest.revisionId,
        boundedLatest.revisionNumber,
        reviewerMemberId,
      ],
    );
  }
  const boundedDetail = await harness.repository.getArticleRevisionDetail({
    actor: actors.reviewer,
    articleId: boundedArticle.id,
    revisionId: boundedLatest.revisionId,
    revisionNumber: boundedLatest.revisionNumber,
    workspaceId,
  });
  assert.ok(boundedDetail);
  assert.equal(boundedDetail.events.length, 50);
  assert.equal(boundedDetail.eventsTruncated, true);

  transitioned(
    await harness.repository.submitArticleForReview({
      actor: actors.editor,
      articleId: boundedArticle.id,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: boundedLatest.revisionNumber,
      revisionId: boundedLatest.revisionId,
      workspaceId,
    }),
  );
  const beforeInReviewRestore = await completeArticleState(harness);
  const inReviewRestoreRequest = {
    actor: actors.editor,
    articleId: boundedArticle.id,
    expectedReviewState: "in_review",
    expectedWorkingRevisionNumber: boundedLatest.revisionNumber,
    sourceRevisionId: boundedHistory.items.at(-1)!.revisionId,
    sourceRevisionNumber: boundedHistory.items.at(-1)!.revisionNumber,
    workspaceId,
  } as unknown as RestoreRevisionAsDraftRequest;
  assert.deepEqual(
    await harness.repository.restoreRevisionAsDraft(inReviewRestoreRequest),
    {
      status: "conflict",
      code: "INVALID_REVIEW_STATE",
      currentRevisionNumber: boundedLatest.revisionNumber,
      currentReviewState: "in_review",
    },
  );
  assert.deepEqual(await completeArticleState(harness), beforeInReviewRestore);

  const second = await harness.repository.saveDraftArticle(
    saveRequest(
      {
        ...article(publicArticleId, "private-recovery", "Recovery revision two"),
        mdx: "# Recovery revision two\n\nKeep this former head.",
      },
      1,
      [publicAssetHash],
    ),
  );
  assert.equal(second.status, "saved");
  if (second.status !== "saved") throw new Error("Recovery setup save failed");
  const priorRevisionRows = await harness.query<Record<string, unknown>>(
    `select * from article_revisions
     where workspace_id = $1 and article_id = $2 and revision_number <= 2
     order by revision_number`,
    `select * from article_revisions
     where workspace_id = ? and article_id = ? and revision_number <= 2
     order by revision_number`,
    [workspaceId, publicArticleId],
  );
  let head = await workingHead(harness);
  const firstRestoreRequest = {
    actor: actors.editor,
    articleId: publicArticleId,
    changeSummary: "Return to the original guide",
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: head.revisionNumber,
    sourceRevisionId: "revision_public_1",
    sourceRevisionNumber: 1,
    workspaceId,
  } as const;
  const restoredFirst = transitioned(
    await harness.repository.restoreRevisionAsDraft(firstRestoreRequest),
  );
  assert.equal(restoredFirst.revisionNumber, 3);
  assert.notEqual(restoredFirst.revisionId, "revision_public_1");
  assert.deepEqual(
    await harness.query<Record<string, unknown>>(
      `select * from article_revisions
       where workspace_id = $1 and article_id = $2 and revision_number <= 2
       order by revision_number`,
      `select * from article_revisions
       where workspace_id = ? and article_id = ? and revision_number <= 2
       order by revision_number`,
      [workspaceId, publicArticleId],
    ),
    priorRevisionRows,
  );
  assert.deepEqual(await harness.inventory(), initialPublic);

  const firstPage = await harness.repository.listArticleRevisionHistory({
    actor: actors.reviewer,
    articleId: publicArticleId,
    limit: 2,
    workspaceId,
  });
  assert.ok(firstPage);
  assert.deepEqual(firstPage.items.map((item) => item.revisionNumber), [3, 2]);
  assert.equal(firstPage.nextBeforeRevisionNumber, 2);
  assert.equal(firstPage.items[0]?.isWorkingRevision, true);
  assert.equal(firstPage.items[0]?.restoredFromRevisionId, "revision_public_1");
  assert.equal(firstPage.items[1]?.isPublishedRevision, false);
  const secondPage = await harness.repository.listArticleRevisionHistory({
    actor: actors.reviewer,
    articleId: publicArticleId,
    beforeRevisionNumber: firstPage.nextBeforeRevisionNumber!,
    limit: 2,
    workspaceId,
  });
  assert.ok(secondPage);
  assert.deepEqual(secondPage.items.map((item) => item.revisionNumber), [1]);
  assert.equal(secondPage.nextBeforeRevisionNumber, null);
  assert.equal(
    await harness.repository.listArticleRevisionHistory({
      actor: actors.editor,
      articleId: publicArticleId,
      beforeRevisionNumber: 0,
      workspaceId,
    }),
    null,
  );

  const restoredDetail = await harness.repository.getArticleRevisionDetail({
    actor: actors.reviewer,
    articleId: publicArticleId,
    revisionId: restoredFirst.revisionId,
    revisionNumber: restoredFirst.revisionNumber,
    workspaceId,
  });
  assert.ok(restoredDetail);
  assert.equal(restoredDetail.article.title, "Public guide");
  assert.equal(restoredDetail.changeKind, "rollback");
  assert.equal(restoredDetail.changeSummary, "Return to the original guide");
  assert.equal(restoredDetail.createdByDisplayName, "Editor");
  assert.equal(restoredDetail.restoredFromRevisionId, "revision_public_1");
  assert.deepEqual(restoredDetail.assetHashes, [publicAssetHash]);
  assert.deepEqual(restoredDetail.events.map((event) => event.action), ["restored"]);
  assert.equal(restoredDetail.eventsTruncated, false);

  head = await workingHead(harness);
  transitioned(
    await harness.repository.restoreRevisionAsDraft({
      actor: actors.editor,
      articleId: publicArticleId,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: head.revisionNumber,
      sourceRevisionId: second.revisionId,
      sourceRevisionNumber: second.revisionNumber,
      workspaceId,
    }),
  );
  head = await workingHead(harness);
  assert.equal(head.revisionNumber, 4);
  assert.equal(head.article.title, "Recovery revision two");
  assert.deepEqual(head.assetHashes, [publicAssetHash]);

  const doubleRestore = await Promise.all([
    harness.repository.restoreRevisionAsDraft({
      actor: actors.editor,
      articleId: publicArticleId,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: head.revisionNumber,
      sourceRevisionId: second.revisionId,
      sourceRevisionNumber: second.revisionNumber,
      workspaceId,
    }),
    harness.repository.restoreRevisionAsDraft({
      actor: actors.editor,
      articleId: publicArticleId,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: head.revisionNumber,
      sourceRevisionId: second.revisionId,
      sourceRevisionNumber: second.revisionNumber,
      workspaceId,
    }),
  ]);
  assert.equal(doubleRestore.filter((result) => result.status === "transitioned").length, 1);
  assert.equal(doubleRestore.filter((result) => result.status === "conflict").length, 1);
  assert.equal(
    doubleRestore.find((result) => result.status === "conflict")?.code,
    "STALE_REVISION",
  );
  head = await workingHead(harness);
  assert.equal(head.revisionNumber, 5);

  const beforeMissingRevision = await completeArticleState(harness);
  assert.deepEqual(
    await harness.repository.restoreRevisionAsDraft({
      actor: actors.editor,
      articleId: publicArticleId,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: head.revisionNumber,
      sourceRevisionId: "revision_missing",
      sourceRevisionNumber: 99,
      workspaceId,
    }),
    { status: "rejected", code: "REVISION_NOT_FOUND" },
  );
  assert.deepEqual(await completeArticleState(harness), beforeMissingRevision);

  await harness.pauseAuthoring(true);
  await assert.rejects(
    harness.repository.restoreRevisionAsDraft({
      actor: actors.editor,
      articleId: publicArticleId,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: head.revisionNumber,
      sourceRevisionId: "revision_public_1",
      sourceRevisionNumber: 1,
      workspaceId,
    }),
    AuthoringPausedError,
  );
  await harness.pauseAuthoring(false);

  const retiredCategoryId = "category_retired";
  await harness.execute(
    `insert into categories (id, workspace_id, slug, name, position, created_at, updated_at)
     values ($1, $2, 'retired', 'Retired', 1, current_timestamp, current_timestamp)`,
    `insert into categories (id, workspace_id, slug, name, position, created_at, updated_at)
     values (?, ?, 'retired', 'Retired', 1, unixepoch() * 1000, unixepoch() * 1000)`,
    [retiredCategoryId, workspaceId],
  );
  const retiredArticle = {
    ...article("article_retired_category", "retired-category", "Retired category source"),
    categoryId: retiredCategoryId,
  };
  const retiredSource = await harness.repository.createDraftArticle(
    createRequest(retiredArticle),
  );
  assert.equal(retiredSource.status, "saved");
  if (retiredSource.status !== "saved") throw new Error("Retired category setup failed");
  assert.equal(
    (
      await harness.repository.saveDraftArticle(
        saveRequest(
          { ...retiredArticle, categoryId, title: "Current category revision" },
          1,
        ),
      )
    ).status,
    "saved",
  );
  await harness.execute(
    "delete from categories where workspace_id = $1 and id = $2",
    "delete from categories where workspace_id = ? and id = ?",
    [workspaceId, retiredCategoryId],
  );
  const retiredHead = await workingHead(
    harness,
    actors.editor,
    retiredArticle.id,
  );
  const beforeMissingCategory = await completeArticleState(harness);
  assert.deepEqual(
    await harness.repository.restoreRevisionAsDraft({
      actor: actors.editor,
      articleId: retiredArticle.id,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: retiredHead.revisionNumber,
      sourceRevisionId: retiredSource.revisionId,
      sourceRevisionNumber: retiredSource.revisionNumber,
      workspaceId,
    }),
    { status: "rejected", code: "CATEGORY_UNAVAILABLE" },
  );
  assert.deepEqual(await completeArticleState(harness), beforeMissingCategory);

  const slugArticle = article("article_restore_slug", "restore-old", "Restore old slug");
  const slugSource = await harness.repository.createDraftArticle(createRequest(slugArticle));
  assert.equal(slugSource.status, "saved");
  if (slugSource.status !== "saved") throw new Error("Slug restore setup failed");
  assert.equal(
    (
      await harness.repository.saveDraftArticle(
        saveRequest({ ...slugArticle, slug: "restore-current" }, 1),
      )
    ).status,
    "saved",
  );
  assert.equal(
    (
      await harness.repository.createDraftArticle(
        createRequest(article("article_restore_slug_owner", "restore-old", "Slug owner")),
      )
    ).status,
    "saved",
  );
  const slugHead = await workingHead(harness, actors.editor, slugArticle.id);
  const beforeSlugConflict = await completeArticleState(harness);
  assert.deepEqual(
    await harness.repository.restoreRevisionAsDraft({
      actor: actors.editor,
      articleId: slugArticle.id,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: slugHead.revisionNumber,
      sourceRevisionId: slugSource.revisionId,
      sourceRevisionNumber: slugSource.revisionNumber,
      workspaceId,
    }),
    { status: "conflict", code: "SLUG_CONFLICT" },
  );
  assert.deepEqual(await completeArticleState(harness), beforeSlugConflict);

  const restoreRaceSlug = "restore-race-shared";
  const restoreRaceFirstArticle = article(
    "article_restore_race_first",
    restoreRaceSlug,
    "First restore race source",
  );
  const restoreRaceFirstSource = await harness.repository.createDraftArticle(
    createRequest(restoreRaceFirstArticle),
  );
  assert.equal(restoreRaceFirstSource.status, "saved");
  if (restoreRaceFirstSource.status !== "saved") {
    throw new Error("First restore slug-race setup failed");
  }
  assert.equal(
    (
      await harness.repository.saveDraftArticle(
        saveRequest({ ...restoreRaceFirstArticle, slug: "restore-race-first-current" }, 1),
      )
    ).status,
    "saved",
  );
  const restoreRaceSecondArticle = article(
    "article_restore_race_second",
    restoreRaceSlug,
    "Second restore race source",
  );
  const restoreRaceSecondSource = await harness.repository.createDraftArticle(
    createRequest(restoreRaceSecondArticle),
  );
  assert.equal(restoreRaceSecondSource.status, "saved");
  if (restoreRaceSecondSource.status !== "saved") {
    throw new Error("Second restore slug-race setup failed");
  }
  assert.equal(
    (
      await harness.repository.saveDraftArticle(
        saveRequest({ ...restoreRaceSecondArticle, slug: "restore-race-second-current" }, 1),
      )
    ).status,
    "saved",
  );
  const [restoreRaceFirstHead, restoreRaceSecondHead] = await Promise.all([
    workingHead(harness, actors.editor, restoreRaceFirstArticle.id),
    workingHead(harness, actors.editor, restoreRaceSecondArticle.id),
  ]);
  const restoreSlugRace = await Promise.all([
    harness.repository.restoreRevisionAsDraft({
      actor: actors.editor,
      articleId: restoreRaceFirstArticle.id,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: restoreRaceFirstHead.revisionNumber,
      sourceRevisionId: restoreRaceFirstSource.revisionId,
      sourceRevisionNumber: restoreRaceFirstSource.revisionNumber,
      workspaceId,
    }),
    harness.repository.restoreRevisionAsDraft({
      actor: actors.editor,
      articleId: restoreRaceSecondArticle.id,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: restoreRaceSecondHead.revisionNumber,
      sourceRevisionId: restoreRaceSecondSource.revisionId,
      sourceRevisionNumber: restoreRaceSecondSource.revisionNumber,
      workspaceId,
    }),
  ]);
  assert.equal(
    restoreSlugRace.filter((result) => result.status === "transitioned").length,
    1,
  );
  assert.equal(
    restoreSlugRace.filter(
      (result) => result.status === "conflict" && result.code === "SLUG_CONFLICT",
    ).length,
    1,
  );
  assert.equal(
    (await harness.revisionCount(restoreRaceFirstArticle.id)) +
      (await harness.revisionCount(restoreRaceSecondArticle.id)),
    5,
  );

  const unsafeArticle = article("article_unsafe_history", "unsafe-history", "Unsafe source");
  const unsafeSource = await harness.repository.createDraftArticle(createRequest(unsafeArticle));
  assert.equal(unsafeSource.status, "saved");
  if (unsafeSource.status !== "saved") throw new Error("Unsafe restore setup failed");
  assert.equal(
    (
      await harness.repository.saveDraftArticle(
        saveRequest({ ...unsafeArticle, title: "Safe current revision" }, 1),
      )
    ).status,
    "saved",
  );
  const unsafeMdx = "# Unsafe source\n\n{process.env.SECRET}";
  const unsafeHash = await articleRevisionHash({
    workspaceId,
    articleId: unsafeArticle.id,
    categoryId,
    categorySlug: "guides",
    categoryName: "Guides",
    slug: unsafeArticle.slug,
    title: unsafeArticle.title,
    mdx: unsafeMdx,
    isFaq: unsafeArticle.isFaq,
    authorName: unsafeArticle.authorName,
    position: unsafeArticle.position,
    assetHashes: [],
  });
  await harness.corruptRevisionMdx(unsafeSource.revisionId, unsafeMdx, unsafeHash);
  const unsafeHead = await workingHead(harness, actors.editor, unsafeArticle.id);
  const beforeUnsafeRestore = await completeArticleState(harness);
  assert.deepEqual(
    await harness.repository.restoreRevisionAsDraft({
      actor: actors.editor,
      articleId: unsafeArticle.id,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: unsafeHead.revisionNumber,
      sourceRevisionId: unsafeSource.revisionId,
      sourceRevisionNumber: unsafeSource.revisionNumber,
      workspaceId,
    }),
    { status: "rejected", code: "UNSAFE_REVISION" },
  );
  assert.deepEqual(await completeArticleState(harness), beforeUnsafeRestore);

  const missingAssetHash = "c".repeat(64);
  await harness.addAsset("asset_missing_history", missingAssetHash);
  await harness.addManifest("manifest_missing_history", [missingAssetHash]);
  const assetArticle = article("article_missing_asset", "missing-asset", "Asset source");
  const assetSource = await harness.repository.createDraftArticle(
    createRequest(assetArticle, [missingAssetHash], "manifest_missing_history"),
  );
  assert.equal(assetSource.status, "saved");
  if (assetSource.status !== "saved") throw new Error("Missing asset setup failed");
  assert.equal(
    (
      await harness.repository.saveDraftArticle(
        saveRequest({ ...assetArticle, title: "No asset current revision" }, 1),
      )
    ).status,
    "saved",
  );
  await harness.removeAssetForCorruption("asset_missing_history");
  const assetHead = await workingHead(harness, actors.editor, assetArticle.id);
  const beforeMissingAsset = await completeArticleState(harness);
  assert.deepEqual(
    await harness.repository.restoreRevisionAsDraft({
      actor: actors.editor,
      articleId: assetArticle.id,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: assetHead.revisionNumber,
      sourceRevisionId: assetSource.revisionId,
      sourceRevisionNumber: assetSource.revisionNumber,
      workspaceId,
    }),
    { status: "rejected", code: "ASSET_UNAVAILABLE" },
  );
  assert.deepEqual(await completeArticleState(harness), beforeMissingAsset);

  head = await workingHead(harness);
  const slugClaimsBeforeArchive = await harness.query<{
    article_row_claim: boolean | number;
    normalized_slug: string;
    working_claim: boolean | number;
  }>(
    `select normalized_slug, working_claim, article_row_claim
     from article_slug_claims
     where workspace_id = $1 and article_id = $2
     order by normalized_slug`,
    `select normalized_slug, working_claim, article_row_claim
     from article_slug_claims
     where workspace_id = ? and article_id = ?
     order by normalized_slug`,
    [workspaceId, publicArticleId],
  );
  assert.deepEqual(
    slugClaimsBeforeArchive.map((claim) => ({
      articleRowClaim: Boolean(claim.article_row_claim),
      slug: claim.normalized_slug,
      workingClaim: Boolean(claim.working_claim),
    })),
    [
      { articleRowClaim: false, slug: "private-recovery", workingClaim: true },
      { articleRowClaim: true, slug: "public-guide", workingClaim: false },
    ],
  );
  const previewGrantId = "P".repeat(43);
  await harness.addPreviewGrant(previewGrantId, head.revisionId);
  const archiveRequest = {
    ...archiveTarget(actors.reviewer, head),
    note: "No longer current",
  };
  const archiveRace = await Promise.all([
    harness.repository.archiveArticle(archiveRequest),
    harness.repository.archiveArticle(archiveRequest),
  ]);
  assert.equal(archiveRace.filter((result) => result.status === "transitioned").length, 1);
  assert.equal(archiveRace.filter((result) => result.status !== "transitioned").length, 1);
  head = await workingHead(harness);
  assert.ok(head.archivedAt);
  assert.equal(head.publicStatus, "draft");
  assert.equal(head.reviewState, "editing");
  const [archivedPublic] = await harness.query<{
    content_hash: string | null;
    published_assets: number | string;
    status: string;
  }>(
    `select article.content_hash, article.status,
       (select count(*) from article_assets link
        inner join articles live on live.id = link.article_id and live.workspace_id = link.workspace_id
        where link.workspace_id = article.workspace_id and link.article_id = article.id
          and live.status = 'published') as published_assets
     from articles article where article.workspace_id = $1 and article.id = $2`,
    `select article.content_hash, article.status,
       (select count(*) from article_assets link
        inner join articles live on live.id = link.article_id and live.workspace_id = link.workspace_id
        where link.workspace_id = article.workspace_id and link.article_id = article.id
          and live.status = 'published') as published_assets
     from articles article where article.workspace_id = ? and article.id = ?`,
    [workspaceId, publicArticleId],
  );
  assert.deepEqual(
    {
      contentHash: archivedPublic.content_hash,
      publishedAssets: Number(archivedPublic.published_assets),
      status: archivedPublic.status,
    },
    { contentHash: null, publishedAssets: 0, status: "draft" },
  );
  const [revokedPreview] = await harness.query<{
    revoked_at: Date | number | null;
    revoked_by_member_id: string | null;
  }>(
    "select revoked_at, revoked_by_member_id from article_preview_grants where id = $1",
    "select revoked_at, revoked_by_member_id from article_preview_grants where id = ?",
    [previewGrantId],
  );
  assert.ok(revokedPreview.revoked_at);
  assert.equal(revokedPreview.revoked_by_member_id, reviewerMemberId);
  assert.deepEqual(
    await harness.query<{
      article_row_claim: boolean | number;
      normalized_slug: string;
      working_claim: boolean | number;
    }>(
      `select normalized_slug, working_claim, article_row_claim
       from article_slug_claims
       where workspace_id = $1 and article_id = $2
       order by normalized_slug`,
      `select normalized_slug, working_claim, article_row_claim
       from article_slug_claims
       where workspace_id = ? and article_id = ?
       order by normalized_slug`,
      [workspaceId, publicArticleId],
    ),
    slugClaimsBeforeArchive,
  );
  assert.ok(
    await harness.repository.listArticleRevisionHistory({
      actor: actors.editor,
      articleId: publicArticleId,
      workspaceId,
    }),
  );
  assert.deepEqual(
    await harness.repository.restoreRevisionAsDraft({
      actor: actors.editor,
      articleId: publicArticleId,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: head.revisionNumber,
      sourceRevisionId: "revision_public_1",
      sourceRevisionNumber: 1,
      workspaceId,
    }),
    { status: "rejected", code: "ARTICLE_ARCHIVED" },
  );

  const restoreArchiveRequest = archiveTarget(actors.editor, head);
  const restoreArchiveRace = await Promise.all([
    harness.repository.restoreArchivedArticle(restoreArchiveRequest),
    harness.repository.restoreArchivedArticle(restoreArchiveRequest),
  ]);
  assert.equal(
    restoreArchiveRace.filter((result) => result.status === "transitioned").length,
    1,
  );
  assert.equal(
    restoreArchiveRace.filter(
      (result) => result.status === "rejected" && result.code === "ARTICLE_NOT_ARCHIVED",
    ).length,
    1,
  );
  head = await workingHead(harness);
  assert.equal(head.archivedAt, null);
  assert.equal(head.publicStatus, "draft");
  assert.equal(head.reviewState, "editing");
  assert.equal(await harness.revisionCount(publicArticleId), 5);
  assert.deepEqual(head.assetHashes, [publicAssetHash]);
  const beforeForbiddenArchive = await completeArticleState(harness);
  assert.deepEqual(
    await harness.repository.archiveArticle(archiveTarget(actors.editor, head)),
    { status: "rejected", code: "ACTOR_FORBIDDEN" },
  );
  assert.deepEqual(await completeArticleState(harness), beforeForbiddenArchive);
  await harness.execute(
    "update admin_sessions set revoked_at = created_at where workspace_id = $1 and id = $2",
    "update admin_sessions set revoked_at = created_at where workspace_id = ? and id = ?",
    [workspaceId, reviewerSessionId],
  );
  assert.equal(
    await harness.repository.listArticleRevisionHistory({
      actor: actors.reviewer,
      articleId: publicArticleId,
      workspaceId,
    }),
    null,
  );
  assert.equal(
    await harness.repository.getArticleRevisionDetail(initialDetailRequest),
    null,
  );
}

async function createPostgresHarness(): Promise<Harness> {
  const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri(), max: 24 });
  const database = createPostgresDatabase(pool, { schema: postgresSchema });
  try {
    await migratePostgres(database, { migrationsFolder: migrations.postgres });
    const revisionHash = await publicBaselineRevisionHash();
    await pool.query(
      `insert into workspaces (id, slug, name, created_at, updated_at)
       values ($1, 'drafts', 'Drafts', $2, $2)`,
      [workspaceId, now],
    );
    await pool.query(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations, created_at, updated_at
       ) values ($1, $2, 'owner@example.test', 'Owner', 'administrator', 'active', $3, $4, 600000, $5, $5)`,
      [ownerMemberId, workspaceId, "A".repeat(43), "B".repeat(43), now],
    );
    await pool.query(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations,
         created_by_member_id, created_at, updated_at
       ) values ($1, $2, 'editor@example.test', 'Editor', 'editor', 'active',
                 $3, $4, 600000, $5, $6, $6)`,
      [memberId, workspaceId, "C".repeat(43), "D".repeat(43), ownerMemberId, now],
    );
    await pool.query(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations,
         created_by_member_id, created_at, updated_at
       ) values ($1, $2, 'reviewer@example.test', 'Reviewer', 'reviewer', 'active',
                 $3, $4, 600000, $5, $6, $6)`,
      [reviewerMemberId, workspaceId, "E".repeat(43), "F".repeat(43), ownerMemberId, now],
    );
    await pool.query(
      `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
       values ($1, $2, $3, $6, $7),
              ($4, $2, $5, $6, $7),
              ($8, $2, $9, $6, $7)`,
      [
        sessionId,
        workspaceId,
        memberId,
        ownerSessionId,
        ownerMemberId,
        now,
        later,
        reviewerSessionId,
        reviewerMemberId,
      ],
    );
    await pool.query(
      `insert into categories (id, workspace_id, slug, name, position, created_at, updated_at)
       values ($1, $2, 'guides', 'Guides', 0, $3, $3)`,
      [categoryId, workspaceId, now],
    );
    await pool.query(
      `insert into assets (id, workspace_id, hash, media_type, byte_size, content, created_at)
       values ('asset_public', $1, $2, 'image/png', 1, $3, $4),
              ('asset_draft', $1, $5, 'image/png', 1, $6, $4)`,
      [workspaceId, publicAssetHash, Buffer.from([1]), now, draftAssetHash, Buffer.from([2])],
    );
    await pool.query(
      `insert into articles (
         id, workspace_id, category_id, slug, title, mdx, content_hash, status,
         is_faq, author_name, position, published_at, created_at, updated_at
       ) values ($1, $2, $3, 'public-guide', 'Public guide', $4, $5,
                 'published', true, 'OPAS', 0, $6, $6, $6)`,
      [publicArticleId, workspaceId, categoryId, "# Public guide\n\nPublic body.", "e".repeat(64), now],
    );
    await pool.query(
      `insert into article_assets (article_id, asset_id, workspace_id, created_at)
       values ($1, 'asset_public', $2, $3)`,
      [publicArticleId, workspaceId, now],
    );
    await pool.query(
      `insert into article_slug_claims
         (workspace_id, normalized_slug, article_id, working_claim, article_row_claim)
       values ($1, 'public-guide', $2, true, true)`,
      [workspaceId, publicArticleId],
    );
    await pool.query(
      `insert into article_revisions (
         id, workspace_id, article_id, revision_number, category_id, category_slug,
         category_name, slug, title, mdx, is_faq, author_name, position, revision_hash,
         change_kind, created_by_member_id, created_at
       ) values (
         'revision_public_1', $1, $2, 1, $3, 'guides', 'Guides', 'public-guide',
         'Public guide', $4, true, 'OPAS', 0, $5, 'manual', $6, $7
       )`,
      [workspaceId, publicArticleId, categoryId, "# Public guide\n\nPublic body.", revisionHash, memberId, now],
    );
    await pool.query(
      `insert into article_revision_assets
         (workspace_id, article_id, revision_id, revision_number, asset_id)
       values ($1, $2, 'revision_public_1', 1, 'asset_public')`,
      [workspaceId, publicArticleId],
    );
    await pool.query(
      `insert into article_heads (
         article_id, workspace_id, working_revision_id, working_revision_number,
         working_slug, published_revision_id, published_revision_number, review_state
       ) values ($1, $2, 'revision_public_1', 1, 'public-guide', 'revision_public_1', 1, 'published')`,
      [publicArticleId, workspaceId],
    );
    for (const statement of postgresTeamAuthoringGuardStatements) await pool.query(statement);
  } catch (error) {
    await pool.end();
    await container.stop();
    throw error;
  }

  let reviewEventSequence = 0;
  let evidenceSequence = 0;
  const categoryRepository = createPostgresCategoryAuthoringRepository(database, {
    clock: () => now,
  });
  return {
    name: "Postgres",
    repository: createPostgresArticleDraftRepository(database, {
      clock: () => now,
      configuredSiteUrl: "https://help.example.test",
      createEvidenceId: () => `evidence_${++evidenceSequence}`,
      createReviewEventId: () => `review_event_${String(++reviewEventSequence).padStart(4, "0")}`,
    }),
    repositoryForRevisionId(id) {
      return createPostgresArticleDraftRepository(database, {
        clock: () => now,
        createRevisionId: () => id,
      });
    },
    repositoryForReviewEventIds(ids, changedAt = now) {
      let index = 0;
      return createPostgresArticleDraftRepository(database, {
        clock: () => changedAt,
        configuredSiteUrl: "https://help.example.test",
        createReviewEventId: () => ids[index++] ?? ids.at(-1)!,
      });
    },
    async addAsset(id, hash) {
      await pool.query(
        `insert into assets (id, workspace_id, hash, media_type, byte_size, content, created_at)
         values ($1, $2, $3, 'image/png', 1, $4, $5)`,
        [id, workspaceId, hash, Buffer.from([3]), now],
      );
    },
    async addManifest(id, hashes) {
      await pool.query(
        "insert into asset_manifests (id, workspace_id, expires_at, created_at) values ($1, $2, $3, $4)",
        [id, workspaceId, later, now],
      );
      for (const hash of hashes) {
        await pool.query(
          `insert into asset_manifest_items (manifest_id, asset_id, workspace_id, created_at)
           select $1, id, workspace_id, $2 from assets where workspace_id = $3 and hash = $4`,
          [id, now, workspaceId, hash],
        );
      }
    },
    async addPreviewGrant(id, revisionId) {
      await pool.query(
        `insert into article_preview_grants (
           id, workspace_id, revision_id, created_by_member_id, expires_at, created_at
         ) values ($1, $2, $3, $4, $5::timestamptz + interval '7 days', $5::timestamptz)`,
        [id, workspaceId, revisionId, reviewerMemberId, now],
      );
    },
    async corruptRevisionMdx(id, mdx, revisionHash) {
      const client = await pool.connect();
      try {
        await client.query("drop trigger article_revisions_immutable_trigger on article_revisions");
        try {
          await client.query(
            "update article_revisions set mdx = $1, revision_hash = $2 where id = $3",
            [mdx, revisionHash, id],
          );
        } finally {
          await client.query(
            `create trigger article_revisions_immutable_trigger
             before update or delete on article_revisions
             for each row execute function opas_reject_article_revision_mutation()`,
          );
        }
      } finally {
        client.release();
      }
    },
    async deleteCategory() {
      const current = (await categoryRepository.listCategories(workspaceId)).find(
        (category) => category.id === categoryId,
      );
      if (!current) throw new Error("The category delete fixture is missing.");
      return categoryRepository.deleteCategory({
        actor: { ...actors.editor, workspaceId },
        category: { id: current.id, workspaceId: current.workspaceId },
        expectedCategoryVersion: current.version,
      });
    },
    async disableActor() {
      await pool.query(
        "update workspace_members set status = 'disabled', updated_at = $1 where id = $2",
        [now, memberId],
      );
    },
    async enableActor() {
      await pool.query(
        "update workspace_members set status = 'active', updated_at = $1 where id = $2",
        [now, memberId],
      );
    },
    async execute(postgres, _sqlite, values = []) {
      await pool.query(postgres, [...values]);
    },
    async inventory() {
      const [articleRows, articleAssets, embeddingJobs, evidenceChunks, indexingState] =
        await Promise.all([
        pool.query("select * from articles where id = $1 order by id", [publicArticleId]),
        pool.query("select * from article_assets where article_id = $1 order by asset_id", [publicArticleId]),
        pool.query("select * from embedding_jobs where article_id = $1 order by id", [publicArticleId]),
        pool.query("select * from evidence_chunks where article_id = $1 order by id", [publicArticleId]),
        pool.query("select * from workspace_index_states where workspace_id = $1", [workspaceId]),
      ]);
      return {
        articles: articleRows.rows,
        articleAssets: articleAssets.rows,
        embeddingJobs: embeddingJobs.rows,
        evidenceChunks: evidenceChunks.rows,
        indexingState: indexingState.rows,
      };
    },
    async pauseAuthoring(paused) {
      await pool.query(
        `update workspace_authoring_controls
         set writes_paused = $1, generation = generation + 1, changed_at = $2
         where workspace_id = $3`,
        [paused, now, workspaceId],
      );
    },
    async renameCategoryThroughRepository(name) {
      const current = (await categoryRepository.listCategories(workspaceId)).find(
        (category) => category.id === categoryId,
      );
      if (!current) throw new Error("The category race fixture is missing.");
      const result = await categoryRepository.updateCategory({
        actor: { ...actors.editor, workspaceId },
        category: {
          id: current.id,
          workspaceId: current.workspaceId,
          slug: current.slug,
          name,
          description: current.description,
          position: current.position,
        },
        expectedCategoryVersion: current.version,
      });
      if (result.status !== "updated") {
        throw new Error(`The category race update returned ${result.status}.`);
      }
    },
    async renameCategorySlug(slug) {
      const current = (await categoryRepository.listCategories(workspaceId)).find(
        (category) => category.id === categoryId,
      );
      if (!current) throw new Error("The category slug fixture is missing.");
      return categoryRepository.updateCategory({
        actor: { ...actors.editor, workspaceId },
        category: {
          id: current.id,
          workspaceId: current.workspaceId,
          slug,
          name: current.name,
          description: current.description,
          position: current.position,
        },
        expectedCategoryVersion: current.version,
      });
    },
    async revokeActorSession() {
      await pool.query(
        "update admin_sessions set revoked_at = $1 where id = $2 and revoked_at is null",
        [now, sessionId],
      );
    },
    async setActorRole(role) {
      await pool.query(
        "update workspace_members set role = $1, updated_at = $2 where id = $3",
        [role, now, memberId],
      );
    },
    async setMemberStatus(id, status) {
      await pool.query(
        "update workspace_members set status = $1, updated_at = $2 where workspace_id = $3 and id = $4",
        [status, now, workspaceId, id],
      );
    },
    async query<T extends object>(
      postgres: string,
      _sqlite: string,
      values: readonly unknown[] = [],
    ) {
      return (await pool.query(postgres, [...values])).rows as T[];
    },
    async removeAssetForCorruption(id) {
      const client = await pool.connect();
      try {
        await client.query("set session_replication_role = replica");
        await client.query("delete from assets where workspace_id = $1 and id = $2", [
          workspaceId,
          id,
        ]);
      } finally {
        await client.query("set session_replication_role = origin");
        client.release();
      }
    },
    async revisionCount(articleId) {
      const result = await pool.query<{ count: string }>(
        "select count(*) as count from article_revisions where workspace_id = $1 and article_id = $2",
        [workspaceId, articleId],
      );
      return Number(result.rows[0].count);
    },
    async lockAndDisableActor() {
      const client: PoolClient = await pool.connect();
      await client.query("begin");
      await client.query("select id from workspace_members where id = $1 for update", [memberId]);
      await client.query(
        "update workspace_members set status = 'disabled', updated_at = $1 where id = $2",
        [now, memberId],
      );
      return async () => {
        await client.query("commit");
        client.release();
      };
    },
    async lockAndDisableMember(id) {
      const client: PoolClient = await pool.connect();
      await client.query("begin");
      await client.query("select id from workspace_members where id = $1 for update", [id]);
      await client.query(
        "update workspace_members set status = 'disabled', updated_at = $1 where id = $2",
        [now, id],
      );
      return async () => {
        await client.query("commit");
        client.release();
      };
    },
    async close() {
      await pool.end();
      await container.stop();
    },
  };
}

async function createSqliteHarness(): Promise<Harness> {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");
  const database = createSqliteDatabase(client, { schema: sqliteSchema });
  try {
    migrateSqlite(database, { migrationsFolder: migrations.sqlite });
    const revisionHash = await publicBaselineRevisionHash();
    client
      .prepare(
        `insert into workspaces (id, slug, name, created_at, updated_at)
         values (?, 'drafts', 'Drafts', ?, ?)`,
      )
      .run(workspaceId, now.getTime(), now.getTime());
    client
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations, created_at, updated_at
         ) values (?, ?, 'owner@example.test', 'Owner', 'administrator', 'active', ?, ?, 600000, ?, ?)`,
      )
      .run(ownerMemberId, workspaceId, "A".repeat(43), "B".repeat(43), now.getTime(), now.getTime());
    client
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations,
           created_by_member_id, created_at, updated_at
         ) values (?, ?, 'editor@example.test', 'Editor', 'editor', 'active',
                   ?, ?, 600000, ?, ?, ?)`,
      )
      .run(
        memberId,
        workspaceId,
        "C".repeat(43),
        "D".repeat(43),
        ownerMemberId,
        now.getTime(),
        now.getTime(),
      );
    client
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations,
           created_by_member_id, created_at, updated_at
         ) values (?, ?, 'reviewer@example.test', 'Reviewer', 'reviewer', 'active',
                   ?, ?, 600000, ?, ?, ?)`,
      )
      .run(
        reviewerMemberId,
        workspaceId,
        "E".repeat(43),
        "F".repeat(43),
        ownerMemberId,
        now.getTime(),
        now.getTime(),
      );
    client
      .prepare(
        `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
         values (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        workspaceId,
        memberId,
        now.getTime(),
        later.getTime(),
        ownerSessionId,
        workspaceId,
        ownerMemberId,
        now.getTime(),
        later.getTime(),
        reviewerSessionId,
        workspaceId,
        reviewerMemberId,
        now.getTime(),
        later.getTime(),
      );
    client
      .prepare(
        `insert into categories (id, workspace_id, slug, name, position, created_at, updated_at)
         values (?, ?, 'guides', 'Guides', 0, ?, ?)`,
      )
      .run(categoryId, workspaceId, now.getTime(), now.getTime());
    client
      .prepare(
        `insert into assets (id, workspace_id, hash, media_type, byte_size, content, created_at)
         values ('asset_public', ?, ?, 'image/png', 1, ?, ?),
                ('asset_draft', ?, ?, 'image/png', 1, ?, ?)`,
      )
      .run(
        workspaceId,
        publicAssetHash,
        Buffer.from([1]),
        now.getTime(),
        workspaceId,
        draftAssetHash,
        Buffer.from([2]),
        now.getTime(),
      );
    client
      .prepare(
        `insert into articles (
           id, workspace_id, category_id, slug, title, mdx, content_hash, status,
           is_faq, author_name, position, published_at, created_at, updated_at
         ) values (?, ?, ?, 'public-guide', 'Public guide', ?, ?,
                   'published', 1, 'OPAS', 0, ?, ?, ?)`,
      )
      .run(
        publicArticleId,
        workspaceId,
        categoryId,
        "# Public guide\n\nPublic body.",
        "e".repeat(64),
        now.getTime(),
        now.getTime(),
        now.getTime(),
      );
    client
      .prepare(
        `insert into article_assets (article_id, asset_id, workspace_id, created_at)
         values (?, 'asset_public', ?, ?)`,
      )
      .run(publicArticleId, workspaceId, now.getTime());
    client
      .prepare(
        `insert into article_slug_claims
           (workspace_id, normalized_slug, article_id, working_claim, article_row_claim)
         values (?, 'public-guide', ?, 1, 1)`,
      )
      .run(workspaceId, publicArticleId);
    client
      .prepare(
        `insert into article_revisions (
           id, workspace_id, article_id, revision_number, category_id, category_slug,
           category_name, slug, title, mdx, is_faq, author_name, position, revision_hash,
           change_kind, created_by_member_id, created_at
         ) values (
           'revision_public_1', ?, ?, 1, ?, 'guides', 'Guides', 'public-guide',
           'Public guide', ?, 1, 'OPAS', 0, ?, 'manual', ?, ?
         )`,
      )
      .run(
        workspaceId,
        publicArticleId,
        categoryId,
        "# Public guide\n\nPublic body.",
        revisionHash,
        memberId,
        now.getTime(),
      );
    client
      .prepare(
        `insert into article_revision_assets
           (workspace_id, article_id, revision_id, revision_number, asset_id)
         values (?, ?, 'revision_public_1', 1, 'asset_public')`,
      )
      .run(workspaceId, publicArticleId);
    client
      .prepare(
        `insert into article_heads (
           article_id, workspace_id, working_revision_id, working_revision_number,
           working_slug, published_revision_id, published_revision_number, review_state
         ) values (?, ?, 'revision_public_1', 1, 'public-guide', 'revision_public_1', 1, 'published')`,
      )
      .run(publicArticleId, workspaceId);
    for (const statement of sqliteTeamAuthoringGuardStatements) client.exec(statement);
  } catch (error) {
    client.close();
    throw error;
  }

  let reviewEventSequence = 0;
  let evidenceSequence = 0;
  const categoryRepository = createSqliteCategoryAuthoringRepository(database, {
    clock: () => now,
  });
  return {
    name: "SQLite",
    repository: createSqliteArticleDraftRepository(database, {
      clock: () => now,
      configuredSiteUrl: "https://help.example.test",
      createEvidenceId: () => `evidence_${++evidenceSequence}`,
      createReviewEventId: () => `review_event_${String(++reviewEventSequence).padStart(4, "0")}`,
    }),
    repositoryForRevisionId(id) {
      return createSqliteArticleDraftRepository(database, {
        clock: () => now,
        createRevisionId: () => id,
      });
    },
    repositoryForReviewEventIds(ids, changedAt = now) {
      let index = 0;
      return createSqliteArticleDraftRepository(database, {
        clock: () => changedAt,
        configuredSiteUrl: "https://help.example.test",
        createReviewEventId: () => ids[index++] ?? ids.at(-1)!,
      });
    },
    async addAsset(id, hash) {
      client
        .prepare(
          `insert into assets (
             id, workspace_id, hash, media_type, byte_size, content, created_at
           ) values (?, ?, ?, 'image/png', 1, ?, ?)`,
        )
        .run(id, workspaceId, hash, Buffer.from([3]), now.getTime());
    },
    async addManifest(id, hashes) {
      client
        .prepare(
          "insert into asset_manifests (id, workspace_id, expires_at, created_at) values (?, ?, ?, ?)",
        )
        .run(id, workspaceId, later.getTime(), now.getTime());
      const insert = client.prepare(
        `insert into asset_manifest_items (manifest_id, asset_id, workspace_id, created_at)
         select ?, id, workspace_id, ? from assets where workspace_id = ? and hash = ?`,
      );
      for (const hash of hashes) insert.run(id, now.getTime(), workspaceId, hash);
    },
    async addPreviewGrant(id, revisionId) {
      client
        .prepare(
          `insert into article_preview_grants (
             id, workspace_id, revision_id, created_by_member_id, expires_at, created_at
           ) values (?, ?, ?, ?, ? + 604800000, ?)`,
        )
        .run(
          id,
          workspaceId,
          revisionId,
          reviewerMemberId,
          now.getTime(),
          now.getTime(),
        );
    },
    async corruptRevisionMdx(id, mdx, revisionHash) {
      client.exec("drop trigger article_revisions_immutable_update_trigger");
      try {
        client
          .prepare("update article_revisions set mdx = ?, revision_hash = ? where id = ?")
          .run(mdx, revisionHash, id);
      } finally {
        client.exec(`create trigger article_revisions_immutable_update_trigger
          before update on article_revisions
          for each row
          begin
            select raise(abort, 'ARTICLE_REVISION_IMMUTABLE');
          end`);
      }
    },
    async deleteCategory() {
      const current = (await categoryRepository.listCategories(workspaceId)).find(
        (category) => category.id === categoryId,
      );
      if (!current) throw new Error("The category delete fixture is missing.");
      return categoryRepository.deleteCategory({
        actor: { ...actors.editor, workspaceId },
        category: { id: current.id, workspaceId: current.workspaceId },
        expectedCategoryVersion: current.version,
      });
    },
    async disableActor() {
      client
        .prepare("update workspace_members set status = 'disabled', updated_at = ? where id = ?")
        .run(now.getTime(), memberId);
    },
    async enableActor() {
      client
        .prepare("update workspace_members set status = 'active', updated_at = ? where id = ?")
        .run(now.getTime(), memberId);
    },
    async execute(_postgres, sqlite, values = []) {
      client.prepare(sqlite).run(...values);
    },
    async inventory() {
      return {
        articles: client
          .prepare("select * from articles where id = ? order by id")
          .all(publicArticleId),
        articleAssets: client
          .prepare("select * from article_assets where article_id = ? order by asset_id")
          .all(publicArticleId),
        embeddingJobs: client
          .prepare("select * from embedding_jobs where article_id = ? order by id")
          .all(publicArticleId),
        evidenceChunks: client
          .prepare("select * from evidence_chunks where article_id = ? order by id")
          .all(publicArticleId),
        indexingState: client
          .prepare("select * from workspace_index_states where workspace_id = ?")
          .all(workspaceId),
      };
    },
    async pauseAuthoring(paused) {
      client
        .prepare(
          `update workspace_authoring_controls
           set writes_paused = ?, generation = generation + 1, changed_at = ?
           where workspace_id = ?`,
        )
        .run(paused ? 1 : 0, now.getTime(), workspaceId);
    },
    async renameCategoryThroughRepository(name) {
      const current = (await categoryRepository.listCategories(workspaceId)).find(
        (category) => category.id === categoryId,
      );
      if (!current) throw new Error("The category race fixture is missing.");
      const result = await categoryRepository.updateCategory({
        actor: { ...actors.editor, workspaceId },
        category: {
          id: current.id,
          workspaceId: current.workspaceId,
          slug: current.slug,
          name,
          description: current.description,
          position: current.position,
        },
        expectedCategoryVersion: current.version,
      });
      if (result.status !== "updated") {
        throw new Error(`The category race update returned ${result.status}.`);
      }
    },
    async renameCategorySlug(slug) {
      const current = (await categoryRepository.listCategories(workspaceId)).find(
        (category) => category.id === categoryId,
      );
      if (!current) throw new Error("The category slug fixture is missing.");
      return categoryRepository.updateCategory({
        actor: { ...actors.editor, workspaceId },
        category: {
          id: current.id,
          workspaceId: current.workspaceId,
          slug,
          name: current.name,
          description: current.description,
          position: current.position,
        },
        expectedCategoryVersion: current.version,
      });
    },
    async revokeActorSession() {
      client
        .prepare("update admin_sessions set revoked_at = ? where id = ? and revoked_at is null")
        .run(now.getTime(), sessionId);
    },
    async setActorRole(role) {
      client
        .prepare("update workspace_members set role = ?, updated_at = ? where id = ?")
        .run(role, now.getTime(), memberId);
    },
    async setMemberStatus(id, status) {
      client
        .prepare(
          "update workspace_members set status = ?, updated_at = ? where workspace_id = ? and id = ?",
        )
        .run(status, now.getTime(), workspaceId, id);
    },
    async query<T extends object>(
      _postgres: string,
      sqlite: string,
      values: readonly unknown[] = [],
    ) {
      return client.prepare(sqlite).all(...values) as T[];
    },
    async removeAssetForCorruption(id) {
      client.exec("drop trigger assets_revision_history_delete_trigger");
      client.pragma("foreign_keys = OFF");
      try {
        client
          .prepare("delete from assets where workspace_id = ? and id = ?")
          .run(workspaceId, id);
      } finally {
        client.pragma("foreign_keys = ON");
        client.exec(`create trigger assets_revision_history_delete_trigger
          before delete on assets
          for each row
          when exists (select 1 from workspaces where id = old.workspace_id)
            and exists (
              select 1 from article_revision_assets
              where workspace_id = old.workspace_id and asset_id = old.id
            )
          begin
            select raise(abort, 'ASSET_IN_REVISION');
          end`);
      }
    },
    async revisionCount(articleId) {
      return (
        client
          .prepare(
            "select count(*) as count from article_revisions where workspace_id = ? and article_id = ?",
          )
          .get(workspaceId, articleId) as { count: number }
      ).count;
    },
    async close() {
      client.close();
    },
  };
}

test("SQLite draft saves are atomic, revision-safe, and private", async () => {
  const harness = await createSqliteHarness();
  try {
    await exerciseRepository(harness);
  } finally {
    await harness.close();
  }
});

test(
  "Postgres draft saves are atomic, revision-safe, and private",
  { timeout: 120_000 },
  async () => {
    const harness = await createPostgresHarness();
    try {
      await exerciseRepository(harness);
    } finally {
      await harness.close();
    }
  },
);

test("SQLite review and publication are exact, atomic, and isolated", async () => {
  const harness = await createSqliteHarness();
  try {
    await exerciseWorkflow(harness);
  } finally {
    await harness.close();
  }
});

test(
  "Postgres review and publication are exact, atomic, and isolated",
  { timeout: 120_000 },
  async () => {
    const harness = await createPostgresHarness();
    try {
      await exerciseWorkflow(harness);
    } finally {
      await harness.close();
    }
  },
);

test("SQLite history, rollback, archive, and recovery are bounded and atomic", async () => {
  const harness = await createSqliteHarness();
  try {
    await exerciseHistoryAndRecovery(harness);
  } finally {
    await harness.close();
  }
});

test(
  "Postgres history, rollback, archive, and recovery are bounded and atomic",
  { timeout: 120_000 },
  async () => {
    const harness = await createPostgresHarness();
    try {
      await exerciseHistoryAndRecovery(harness);
    } finally {
      await harness.close();
    }
  },
);
