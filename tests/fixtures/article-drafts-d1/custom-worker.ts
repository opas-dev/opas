// ABOUTME: Runs immutable draft, review, publication, and recovery races on native local D1.
// ABOUTME: Exposes deterministic acceptance endpoints for D1 snapshots, evidence, and history.
import { drizzle } from "drizzle-orm/d1";

import { articleRevisionHash } from "../../../src/content/article-revision";
import { createSqliteArticleDraftRepository } from "../../../src/db/sqlite/article-draft-repository";
import { createSqliteCategoryAuthoringRepository } from "../../../src/db/sqlite/category-authoring-repository";
import { sqliteTeamAuthoringGuardStatements } from "../../../src/db/sqlite/team-authoring-backfill";
import * as schema from "../../../src/db/schema/sqlite";

type Environment = Readonly<{ DB: D1Database }>;

const timestamp = Date.parse("2026-09-03T12:00:00.000Z");
const workspaceId = "workspace_d1_drafts";
const ownerMemberId = "member_d1_owner";
const ownerSessionId = "O".repeat(43);
const memberId = "member_d1_editor";
const sessionId = "S".repeat(43);
const reviewerMemberId = "member_d1_reviewer";
const reviewerSessionId = "R".repeat(43);

function request(id: string, slug: string, title: string) {
  return {
    actor: { memberId, sessionId },
    article: {
      id,
      workspaceId,
      categoryId: "category_d1_guides",
      slug,
      title,
      mdx: `# ${title}\n\nPrivate D1 content.`,
      isFaq: false,
      authorName: "D1 Editor",
      position: 0,
    },
    assets: { hashes: [] },
    changeKind: "manual" as const,
  };
}

async function setup(environment: Environment) {
  await environment.DB.batch([
    environment.DB
      .prepare(
        `insert into workspaces (id, slug, name, created_at, updated_at)
         values (?, 'd1-drafts', 'D1 drafts', ?, ?)`,
      )
      .bind(workspaceId, timestamp, timestamp),
    environment.DB
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations, created_at, updated_at
         ) values (?, ?, 'owner@d1.test', 'Owner', 'administrator', 'active',
                   ?, ?, 600000, ?, ?)`,
      )
      .bind(
        ownerMemberId,
        workspaceId,
        "A".repeat(43),
        "B".repeat(43),
        timestamp,
        timestamp,
      ),
    environment.DB
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations,
           created_by_member_id, created_at, updated_at
         ) values (?, ?, 'editor@d1.test', 'Editor', 'editor', 'active',
                   ?, ?, 600000, ?, ?, ?)`,
      )
      .bind(
        memberId,
        workspaceId,
        "C".repeat(43),
        "D".repeat(43),
        ownerMemberId,
        timestamp,
        timestamp,
      ),
    environment.DB
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations,
           created_by_member_id, created_at, updated_at
         ) values (?, ?, 'reviewer@d1.test', 'Reviewer', 'reviewer', 'active',
                   ?, ?, 600000, ?, ?, ?)`,
      )
      .bind(
        reviewerMemberId,
        workspaceId,
        "E".repeat(43),
        "F".repeat(43),
        ownerMemberId,
        timestamp,
        timestamp,
      ),
    environment.DB
      .prepare(
        `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
         values (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      )
      .bind(
        sessionId,
        workspaceId,
        memberId,
        timestamp,
        timestamp + 3_600_000,
        ownerSessionId,
        workspaceId,
        ownerMemberId,
        timestamp,
        timestamp + 3_600_000,
        reviewerSessionId,
        workspaceId,
        reviewerMemberId,
        timestamp,
        timestamp + 3_600_000,
      ),
    environment.DB
      .prepare(
        `insert into categories (id, workspace_id, slug, name, position, created_at, updated_at)
         values ('category_d1_guides', ?, 'guides', 'Guides', 0, ?, ?)`,
      )
      .bind(workspaceId, timestamp, timestamp),
  ]);
  await environment.DB.batch(
    sqliteTeamAuthoringGuardStatements.map((source) => environment.DB.prepare(source)),
  );
}

async function publicationInventory(environment: Environment, articleId: string) {
  const [article, articleAssets, evidence, head, indexState, jobs, reviewEvents] =
    await Promise.all([
      environment.DB.prepare(
        "select * from articles where workspace_id = ? and id = ?",
      )
        .bind(workspaceId, articleId)
        .all(),
      environment.DB.prepare(
        "select * from article_assets where workspace_id = ? and article_id = ? order by asset_id",
      )
        .bind(workspaceId, articleId)
        .all(),
      environment.DB.prepare(
        "select * from evidence_chunks where workspace_id = ? and article_id = ? order by id",
      )
        .bind(workspaceId, articleId)
        .all(),
      environment.DB.prepare(
        "select * from article_heads where workspace_id = ? and article_id = ?",
      )
        .bind(workspaceId, articleId)
        .all(),
      environment.DB.prepare(
        "select * from workspace_index_states where workspace_id = ?",
      )
        .bind(workspaceId)
        .all(),
      environment.DB.prepare(
        "select * from embedding_jobs where workspace_id = ? and article_id = ? order by id",
      )
        .bind(workspaceId, articleId)
        .all(),
      environment.DB.prepare(
        "select * from article_review_events where workspace_id = ? and article_id = ? order by id",
      )
        .bind(workspaceId, articleId)
        .all(),
    ]);
  return {
    article: article.results,
    articleAssets: articleAssets.results,
    evidence: evidence.results,
    head: head.results,
    indexState: indexState.results,
    jobs: jobs.results,
    reviewEvents: reviewEvents.results,
  };
}

async function exercise(environment: Environment) {
  let evidenceSequence = 0;
  let reviewEventSequence = 0;
  const database = drizzle(environment.DB, { schema });
  const repository = createSqliteArticleDraftRepository(
    database,
    {
      clock: () => new Date(timestamp),
      configuredSiteUrl: "https://help.example.test",
      createEvidenceId: () => `d1_evidence_${++evidenceSequence}`,
      createReviewEventId: () =>
        `d1_review_event_${String(++reviewEventSequence).padStart(4, "0")}`,
    },
  );
  const categoryRepository = createSqliteCategoryAuthoringRepository(database, {
    clock: () => new Date(timestamp),
  });
  const renameCategory = async (name: string) => {
    const current = (await categoryRepository.listCategories(workspaceId)).find(
      (category) => category.id === "category_d1_guides",
    );
    if (!current) throw new Error("D1 category fixture is missing.");
    const result = await categoryRepository.updateCategory({
      actor: { memberId, sessionId, workspaceId },
      category: { ...current, name },
      expectedCategoryVersion: current.version,
    });
    if (result.status !== "updated") {
      throw new Error(`D1 category update returned ${result.status}.`);
    }
  };
  const initial = await repository.createDraftArticle(
    request("article_d1_primary", "d1-primary", "D1 initial"),
  );
  const race = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      repository.saveDraftArticle({
        ...request("article_d1_primary", "d1-primary", `D1 race ${index}`),
        expectedWorkingRevisionNumber: 1,
      }),
    ),
  );
  const secondRequest = {
    ...request("article_d1_primary", "d1-second", "D1 second"),
    expectedWorkingRevisionNumber: 2,
  };
  const second = await repository.saveDraftArticle(secondRequest);
  const unchanged = await repository.saveDraftArticle({
    ...secondRequest,
    expectedWorkingRevisionNumber: 3,
  });
  const invalidRevision = await repository.saveDraftArticle({
    ...secondRequest,
    expectedWorkingRevisionNumber: 0,
  });
  await environment.DB
    .prepare(
      `update workspace_authoring_controls
       set writes_paused = 1, generation = generation + 1, changed_at = ?
       where workspace_id = ?`,
    )
    .bind(timestamp, workspaceId)
    .run();
  let pausedCode: string | null = null;
  try {
    await repository.saveDraftArticle({
      ...request("article_d1_primary", "d1-paused", "D1 paused"),
      expectedWorkingRevisionNumber: 3,
    });
  } catch (error) {
    pausedCode =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : error instanceof Error
          ? error.message
          : String(error);
  }
  await environment.DB
    .prepare(
      `update workspace_authoring_controls
       set writes_paused = 0, generation = generation + 1, changed_at = ?
       where workspace_id = ?`,
    )
    .bind(timestamp, workspaceId)
    .run();

  await repository.createDraftArticle(request("article_d1_a", "d1-a", "D1 A"));
  await repository.createDraftArticle(request("article_d1_b", "d1-b", "D1 B"));
  const slugRace = await Promise.all([
    repository.saveDraftArticle({
      ...request("article_d1_a", "d1-shared", "D1 A saved"),
      expectedWorkingRevisionNumber: 1,
    }),
    repository.saveDraftArticle({
      ...request("article_d1_b", "d1-shared", "D1 B saved"),
      expectedWorkingRevisionNumber: 1,
    }),
  ]);
  const revisionCount = await environment.DB
    .prepare(
      `select count(*) as count from article_revisions
       where workspace_id = ? and article_id = 'article_d1_primary'`,
    )
    .bind(workspaceId)
    .first<number>("count");
  const head = await environment.DB
    .prepare(
      `select working_revision_number, working_slug from article_heads
       where workspace_id = ? and article_id = 'article_d1_primary'`,
    )
    .bind(workspaceId)
    .first();

  let workflowHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_primary",
    workspaceId,
  });
  if (!workflowHead) throw new Error("D1 working head was unavailable");

  await environment.DB
    .prepare(
      `update workspace_authoring_controls
       set writes_paused = 1, generation = generation + 1, changed_at = ?
       where workspace_id = ?`,
    )
    .bind(timestamp, workspaceId)
    .run();
  let pausedWorkflowCode: string | null = null;
  try {
    await repository.submitArticleForReview({
      actor: { memberId, sessionId },
      articleId: workflowHead.article.id,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: workflowHead.revisionNumber,
      revisionId: workflowHead.revisionId,
      workspaceId,
    });
  } catch (error) {
    pausedWorkflowCode =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : error instanceof Error
          ? error.message
          : String(error);
  }
  await environment.DB
    .prepare(
      `update workspace_authoring_controls
       set writes_paused = 0, generation = generation + 1, changed_at = ?
       where workspace_id = ?`,
    )
    .bind(timestamp, workspaceId)
    .run();

  await renameCategory("Guides changed");
  const categorySubmit = await repository.submitArticleForReview({
    actor: { memberId, sessionId },
    articleId: workflowHead.article.id,
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: workflowHead.revisionNumber,
    revisionId: workflowHead.revisionId,
    workspaceId,
  });
  await renameCategory("Guides");

  const submitted = await repository.submitArticleForReview({
    actor: { memberId, sessionId },
    articleId: workflowHead.article.id,
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: workflowHead.revisionNumber,
    revisionId: workflowHead.revisionId,
    workspaceId,
  });
  const editAfterSubmit = await repository.saveDraftArticle({
    ...request("article_d1_primary", "d1-submitted", "D1 submitted edit"),
    expectedWorkingRevisionNumber: workflowHead.revisionNumber,
  });
  const doubleSubmit = await repository.submitArticleForReview({
    actor: { memberId, sessionId },
    articleId: workflowHead.article.id,
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: workflowHead.revisionNumber,
    revisionId: workflowHead.revisionId,
    workspaceId,
  });
  const withdrawn = await repository.withdrawArticleReview({
    actor: { memberId, sessionId },
    articleId: workflowHead.article.id,
    expectedReviewState: "in_review",
    expectedWorkingRevisionNumber: workflowHead.revisionNumber,
    revisionId: workflowHead.revisionId,
    workspaceId,
  });
  workflowHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_primary",
    workspaceId,
  });
  if (!workflowHead) throw new Error("D1 withdrawn head was unavailable");
  await repository.submitArticleForReview({
    actor: { memberId, sessionId },
    articleId: workflowHead.article.id,
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: workflowHead.revisionNumber,
    revisionId: workflowHead.revisionId,
    workspaceId,
  });
  workflowHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_primary",
    workspaceId,
  });
  if (!workflowHead) throw new Error("D1 submitted head was unavailable");
  const reviewRace = await Promise.all([
    repository.requestArticleChanges({
      actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
      articleId: workflowHead.article.id,
      expectedReviewState: "in_review",
      expectedWorkingRevisionNumber: workflowHead.revisionNumber,
      revisionId: workflowHead.revisionId,
      workspaceId,
      note: "Clarify the D1 guide",
    }),
    repository.approveArticleRevision({
      actor: { memberId: ownerMemberId, sessionId: ownerSessionId },
      articleId: workflowHead.article.id,
      expectedReviewState: "in_review",
      expectedWorkingRevisionNumber: workflowHead.revisionNumber,
      revisionId: workflowHead.revisionId,
      workspaceId,
    }),
  ]);
  workflowHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_primary",
    workspaceId,
  });
  if (!workflowHead) throw new Error("D1 reviewed head was unavailable");
  if (workflowHead.reviewState === "changes_requested") {
    await repository.saveDraftArticle({
      ...request("article_d1_primary", "d1-final", "D1 corrected"),
      expectedWorkingRevisionNumber: workflowHead.revisionNumber,
    });
    workflowHead = await repository.getArticleWorkingHead({
      actor: { memberId, sessionId },
      articleId: "article_d1_primary",
      workspaceId,
    });
    if (!workflowHead) throw new Error("D1 corrected head was unavailable");
    await repository.submitArticleForReview({
      actor: { memberId, sessionId },
      articleId: workflowHead.article.id,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: workflowHead.revisionNumber,
      revisionId: workflowHead.revisionId,
      workspaceId,
    });
    workflowHead = await repository.getArticleWorkingHead({
      actor: { memberId, sessionId },
      articleId: "article_d1_primary",
      workspaceId,
    });
    if (!workflowHead) throw new Error("D1 corrected submission was unavailable");
    await repository.approveArticleRevision({
      actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
      articleId: workflowHead.article.id,
      expectedReviewState: "in_review",
      expectedWorkingRevisionNumber: workflowHead.revisionNumber,
      revisionId: workflowHead.revisionId,
      workspaceId,
    });
    workflowHead = await repository.getArticleWorkingHead({
      actor: { memberId, sessionId },
      articleId: "article_d1_primary",
      workspaceId,
    });
    if (!workflowHead) throw new Error("D1 corrected approval was unavailable");
  }
  const approvedHead = workflowHead;
  const editedAfterApproval = await repository.saveDraftArticle({
    ...request("article_d1_primary", "d1-final", "D1 publish candidate"),
    expectedWorkingRevisionNumber: approvedHead.revisionNumber,
  });
  workflowHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_primary",
    workspaceId,
  });
  if (!workflowHead) throw new Error("D1 publish candidate was unavailable");
  const stalePublish = await repository.publishArticleRevision({
    actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
    articleId: approvedHead.article.id,
    expectedReviewState: "approved",
    expectedWorkingRevisionNumber: approvedHead.revisionNumber,
    revisionId: approvedHead.revisionId,
    workspaceId,
  });
  await repository.submitArticleForReview({
    actor: { memberId: ownerMemberId, sessionId: ownerSessionId },
    articleId: workflowHead.article.id,
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: workflowHead.revisionNumber,
    revisionId: workflowHead.revisionId,
    workspaceId,
  });
  workflowHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_primary",
    workspaceId,
  });
  if (!workflowHead) throw new Error("D1 final submission was unavailable");
  const selfApproval = await repository.approveArticleRevision({
    actor: { memberId: ownerMemberId, sessionId: ownerSessionId },
    articleId: workflowHead.article.id,
    expectedReviewState: "in_review",
    expectedWorkingRevisionNumber: workflowHead.revisionNumber,
    revisionId: workflowHead.revisionId,
    workspaceId,
  });
  await repository.approveArticleRevision({
    actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
    articleId: workflowHead.article.id,
    expectedReviewState: "in_review",
    expectedWorkingRevisionNumber: workflowHead.revisionNumber,
    revisionId: workflowHead.revisionId,
    workspaceId,
  });
  workflowHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_primary",
    workspaceId,
  });
  if (!workflowHead) throw new Error("D1 final approval was unavailable");

  await renameCategory("Guides changed again");
  const categoryPublish = await repository.publishArticleRevision({
    actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
    articleId: workflowHead.article.id,
    expectedReviewState: "approved",
    expectedWorkingRevisionNumber: workflowHead.revisionNumber,
    revisionId: workflowHead.revisionId,
    workspaceId,
  });
  await renameCategory("Guides");
  workflowHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_primary",
    workspaceId,
  });
  if (!workflowHead || workflowHead.reviewState !== "changes_requested") {
    throw new Error("D1 category change did not invalidate the approved revision.");
  }
  const categoryRecapture = await repository.saveDraftArticle({
    ...request(
      "article_d1_primary",
      workflowHead.article.slug,
      workflowHead.article.title,
    ),
    article: {
      ...workflowHead.article,
      mdx: `# ${workflowHead.article.title}\n\nRecaptured category snapshot.`,
    },
    expectedWorkingRevisionNumber: workflowHead.revisionNumber,
  });
  if (categoryRecapture.status !== "saved") {
    throw new Error("D1 category recapture was not saved.");
  }
  workflowHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_primary",
    workspaceId,
  });
  if (!workflowHead) throw new Error("D1 recaptured category head was unavailable.");
  await repository.submitArticleForReview({
    actor: { memberId, sessionId },
    articleId: workflowHead.article.id,
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: workflowHead.revisionNumber,
    revisionId: workflowHead.revisionId,
    workspaceId,
  });
  workflowHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_primary",
    workspaceId,
  });
  if (!workflowHead) throw new Error("D1 recaptured category submission was unavailable.");
  await repository.approveArticleRevision({
    actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
    articleId: workflowHead.article.id,
    expectedReviewState: "in_review",
    expectedWorkingRevisionNumber: workflowHead.revisionNumber,
    revisionId: workflowHead.revisionId,
    workspaceId,
  });
  workflowHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_primary",
    workspaceId,
  });
  if (!workflowHead) throw new Error("D1 recaptured category approval was unavailable.");
  await environment.DB
    .prepare(
      `update workspace_members set status = 'disabled', updated_at = ?
       where workspace_id = ? and id = ?`,
    )
    .bind(timestamp, workspaceId, reviewerMemberId)
    .run();
  const disabledPublish = await repository.publishArticleRevision({
    actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
    articleId: workflowHead.article.id,
    expectedReviewState: "approved",
    expectedWorkingRevisionNumber: workflowHead.revisionNumber,
    revisionId: workflowHead.revisionId,
    workspaceId,
  });
  const disabledHead = await repository.getArticleWorkingHead({
    actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
    articleId: workflowHead.article.id,
    workspaceId,
  });
  await environment.DB
    .prepare(
      `update workspace_members set status = 'active', updated_at = ?
       where workspace_id = ? and id = ?`,
    )
    .bind(timestamp, workspaceId, reviewerMemberId)
    .run();
  const publishRace = await Promise.all([
    repository.publishArticleRevision({
      actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
      articleId: workflowHead.article.id,
      expectedReviewState: "approved",
      expectedWorkingRevisionNumber: workflowHead.revisionNumber,
      revisionId: workflowHead.revisionId,
      workspaceId,
    }),
    repository.publishArticleRevision({
      actor: { memberId: ownerMemberId, sessionId: ownerSessionId },
      articleId: workflowHead.article.id,
      expectedReviewState: "approved",
      expectedWorkingRevisionNumber: workflowHead.revisionNumber,
      revisionId: workflowHead.revisionId,
      workspaceId,
    }),
  ]);
  const publicationWinner = publishRace.find(
    (result) => result.status === "transitioned",
  );
  if (!publicationWinner || publicationWinner.status !== "transitioned") {
    throw new Error("D1 publication had no winner");
  }
  workflowHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_primary",
    workspaceId,
  });
  if (!workflowHead) throw new Error("D1 published head was unavailable");
  const publishedState = await environment.DB
    .prepare(
      `select article.status, article.slug, article.title, article.content_hash,
              head.review_state, head.working_revision_id, head.published_revision_id,
              state.generation
       from articles article
       inner join article_heads head on head.workspace_id = article.workspace_id and head.article_id = article.id
       inner join workspace_index_states state on state.workspace_id = article.workspace_id
       where article.workspace_id = ? and article.id = 'article_d1_primary'`,
    )
    .bind(workspaceId)
    .first();
  const publishedEvidenceCount = await environment.DB
    .prepare(
      `select count(*) as count from evidence_chunks
       where workspace_id = ? and article_id = 'article_d1_primary'`,
    )
    .bind(workspaceId)
    .first<number>("count");
  const publishedJobs = await environment.DB
    .prepare(
      `select status, index_generation from embedding_jobs
       where workspace_id = ? and article_id = 'article_d1_primary' order by id`,
    )
    .bind(workspaceId)
    .all();
  const publishedEventCount = await environment.DB
    .prepare(
      `select count(*) as count from article_review_events
       where workspace_id = ? and article_id = 'article_d1_primary' and action = 'published'`,
    )
    .bind(workspaceId)
    .first<number>("count");
  const publishedCategory = (await categoryRepository.listCategories(workspaceId)).find(
    (category) => category.id === "category_d1_guides",
  );
  if (!publishedCategory) throw new Error("D1 published category was unavailable.");
  const categoryDelete = await categoryRepository.deleteCategory({
    actor: { memberId, sessionId, workspaceId },
    category: { id: publishedCategory.id, workspaceId },
    expectedCategoryVersion: publishedCategory.version,
  });
  const categorySlug = await categoryRepository.updateCategory({
    actor: { memberId, sessionId, workspaceId },
    category: { ...publishedCategory, slug: "d1-guides-renamed" },
    expectedCategoryVersion: publishedCategory.version,
  });
  const unpublished = await repository.unpublishArticle({
    actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
    articleId: workflowHead.article.id,
    expectedReviewState: "published",
    expectedWorkingRevisionNumber: workflowHead.revisionNumber,
    revisionId: workflowHead.revisionId,
    workspaceId,
  });
  workflowHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_primary",
    workspaceId,
  });
  if (!workflowHead) throw new Error("D1 unpublished head was unavailable");
  const beforeFailedPublication = await publicationInventory(
    environment,
    workflowHead.article.id,
  );
  const failingRepository = createSqliteArticleDraftRepository(
    drizzle(environment.DB, { schema }),
    {
      clock: () => new Date(timestamp),
      configuredSiteUrl: "https://help.example.test",
      createEvidenceId: () => "d1_failed_publication",
      createReviewEventId: () => publicationWinner.eventId,
    },
  );
  let failedPublicationError: string | null = null;
  try {
    await failingRepository.emergencyPublishArticle({
      actor: { memberId: ownerMemberId, sessionId: ownerSessionId },
      articleId: workflowHead.article.id,
      expectedReviewState: "approved",
      expectedWorkingRevisionNumber: workflowHead.revisionNumber,
      revisionId: workflowHead.revisionId,
      workspaceId,
      reason: "This transaction must roll back",
    });
  } catch (error) {
    failedPublicationError = error instanceof Error ? error.message : String(error);
  }
  const afterFailedPublication = await publicationInventory(
    environment,
    workflowHead.article.id,
  );
  const emergencyPublished = await repository.emergencyPublishArticle({
    actor: { memberId: ownerMemberId, sessionId: ownerSessionId },
    articleId: workflowHead.article.id,
    expectedReviewState: "approved",
    expectedWorkingRevisionNumber: workflowHead.revisionNumber,
    revisionId: workflowHead.revisionId,
    workspaceId,
    reason: "Urgent D1 publication",
  });
  const finalState = await environment.DB
    .prepare(
      `select article.status, head.review_state, state.generation,
              (select count(*) from evidence_chunks where workspace_id = article.workspace_id and article_id = article.id) as evidence_count,
              (select count(*) from embedding_jobs where workspace_id = article.workspace_id and article_id = article.id) as job_count,
              (select count(*) from embedding_jobs where workspace_id = article.workspace_id and article_id = article.id and status = 'pending') as pending_job_count
       from articles article
       inner join article_heads head on head.workspace_id = article.workspace_id and head.article_id = article.id
       inner join workspace_index_states state on state.workspace_id = article.workspace_id
       where article.workspace_id = ? and article.id = 'article_d1_primary'`,
    )
    .bind(workspaceId)
    .first();
  const markedImportRequest = {
    ...request("article_d1_marked_import", "d1-marked-import", "D1 marked import"),
    article: {
      ...request("article_d1_marked_import", "d1-marked-import", "D1 marked import")
        .article,
      status: "published" as const,
    },
    changeKind: "import" as const,
  };
  const markedImport = await repository.createDraftArticle(markedImportRequest);
  const markedImportState = await environment.DB
    .prepare(
      `select article.status, article.content_hash, head.review_state,
              head.published_revision_id,
              (select count(*) from evidence_chunks where workspace_id = article.workspace_id and article_id = article.id) as evidence_count
       from articles article
       inner join article_heads head on head.workspace_id = article.workspace_id and head.article_id = article.id
       where article.workspace_id = ? and article.id = 'article_d1_marked_import'`,
    )
    .bind(workspaceId)
    .first();
  const combinedCreate = await repository.createDraftArticle(
    request("article_d1_combined", "d1-combined", "D1 combined"),
  );
  let combinedHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_combined",
    workspaceId,
  });
  if (!combinedHead) throw new Error("D1 combined head was unavailable");
  const combinedSubmission = await repository.submitArticleForReview({
    actor: { memberId, sessionId },
    articleId: combinedHead.article.id,
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: combinedHead.revisionNumber,
    revisionId: combinedHead.revisionId,
    workspaceId,
  });
  if (combinedSubmission.status !== "transitioned") {
    throw new Error("D1 combined submission did not transition");
  }
  combinedHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_combined",
    workspaceId,
  });
  if (!combinedHead) throw new Error("D1 submitted combined head was unavailable");
  const combinedBeforeRollback = await publicationInventory(
    environment,
    combinedHead.article.id,
  );
  let combinedEventIndex = 0;
  const combinedFailingRepository = createSqliteArticleDraftRepository(
    drizzle(environment.DB, { schema }),
    {
      clock: () => new Date(timestamp),
      configuredSiteUrl: "https://help.example.test",
      createEvidenceId: () => "d1_combined_failed_evidence",
      createReviewEventId: () =>
        ["d1_combined_approval_rollback", combinedSubmission.eventId][
          combinedEventIndex++
        ]!,
    },
  );
  let combinedRollbackError: string | null = null;
  try {
    await combinedFailingRepository.approveAndPublishArticleRevision({
      actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
      articleId: combinedHead.article.id,
      expectedReviewState: "in_review",
      expectedWorkingRevisionNumber: combinedHead.revisionNumber,
      revisionId: combinedHead.revisionId,
      workspaceId,
      note: "Rollback D1 combined publication",
    });
  } catch (error) {
    combinedRollbackError = error instanceof Error ? error.message : String(error);
  }
  const combinedAfterRollback = await publicationInventory(
    environment,
    combinedHead.article.id,
  );
  const combinedPublished = await repository.approveAndPublishArticleRevision({
    actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
    articleId: combinedHead.article.id,
    expectedReviewState: "in_review",
    expectedWorkingRevisionNumber: combinedHead.revisionNumber,
    revisionId: combinedHead.revisionId,
    workspaceId,
    note: "Approve and publish D1",
  });
  const combinedEvents = await environment.DB
    .prepare(
      `select action from article_review_events
       where workspace_id = ? and article_id = 'article_d1_combined'
       order by created_at, id`,
    )
    .bind(workspaceId)
    .all();
  return {
    initial,
    race,
    second,
    unchanged,
    invalidRevision,
    pausedCode,
    slugRace,
    revisionCount,
    head,
    workflow: {
      pausedWorkflowCode,
      categorySubmit,
      categoryDelete,
      submitted,
      editAfterSubmit,
      doubleSubmit,
      withdrawn,
      reviewRace,
      editedAfterApproval,
      stalePublish,
      selfApproval,
      categoryPublish,
      categorySlug,
      disabledPublish,
      disabledHead,
      publishRace,
      publishedState,
      publishedEvidenceCount,
      publishedJobs: publishedJobs.results,
      publishedEventCount,
      unpublished,
      beforeFailedPublication,
      failedPublicationError,
      afterFailedPublication,
      emergencyPublished,
      finalState,
      markedImport,
      markedImportState,
      combinedCreate,
      combinedSubmission,
      combinedBeforeRollback,
      combinedRollbackError,
      combinedAfterRollback,
      combinedPublished,
      combinedEvents: combinedEvents.results,
    },
  };
}

async function mutateHistoricalRevision(
  environment: Environment,
  revisionId: string,
  mdx: string,
  revisionHash: string,
) {
  await environment.DB.exec("drop trigger article_revisions_immutable_update_trigger");
  try {
    await environment.DB.prepare(
      "update article_revisions set mdx = ?, revision_hash = ? where id = ?",
    )
      .bind(mdx, revisionHash, revisionId)
      .run();
  } finally {
    await environment.DB.prepare(`create trigger article_revisions_immutable_update_trigger
      before update on article_revisions
      for each row
      begin
        select raise(abort, 'ARTICLE_REVISION_IMMUTABLE');
      end`).run();
  }
}

async function exerciseRecovery(environment: Environment) {
  let evidenceSequence = 0;
  let eventSequence = 0;
  const database = drizzle(environment.DB, { schema });
  const repository = createSqliteArticleDraftRepository(
    database,
    {
      clock: () => new Date(timestamp),
      configuredSiteUrl: "https://help.example.test",
      createEvidenceId: () => `d1_recovery_evidence_${++evidenceSequence}`,
      createReviewEventId: () =>
        `d1_recovery_event_${String(++eventSequence).padStart(4, "0")}`,
    },
  );
  const categoryRepository = createSqliteCategoryAuthoringRepository(database, {
    clock: () => new Date(timestamp),
  });
  const created = await repository.createDraftArticle(
    request("article_d1_recovery", "d1-recovery", "D1 recovery source"),
  );
  if (created.status !== "saved") throw new Error("D1 recovery article was not created");
  let head = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_recovery",
    workspaceId,
  });
  if (!head) throw new Error("D1 recovery head was unavailable");
  const published = await repository.emergencyPublishArticle({
    actor: { memberId: ownerMemberId, sessionId: ownerSessionId },
    articleId: head.article.id,
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: head.revisionNumber,
    revisionId: head.revisionId,
    workspaceId,
    reason: "D1 recovery fixture",
  });
  head = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_recovery",
    workspaceId,
  });
  if (!head) throw new Error("D1 published recovery head was unavailable");
  const saved = await repository.saveDraftArticle({
    ...request("article_d1_recovery", "d1-recovery-private", "D1 private recovery"),
    expectedWorkingRevisionNumber: head.revisionNumber,
  });
  if (saved.status !== "saved") throw new Error("D1 recovery draft was not saved");
  head = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_recovery",
    workspaceId,
  });
  if (!head) throw new Error("D1 private recovery head was unavailable");
  const priorRevisionsBeforeRestore = await environment.DB.prepare(
    `select * from article_revisions
     where workspace_id = ? and article_id = ? and revision_number <= 2
     order by revision_number`,
  )
    .bind(workspaceId, head.article.id)
    .all();
  const restored = await repository.restoreRevisionAsDraft({
    actor: { memberId, sessionId },
    articleId: head.article.id,
    changeSummary: "Restore the first D1 revision",
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: head.revisionNumber,
    sourceRevisionId: created.revisionId,
    sourceRevisionNumber: created.revisionNumber,
    workspaceId,
  });
  if (restored.status !== "transitioned") {
    throw new Error("D1 historical revision was not restored");
  }
  const priorRevisionsAfterRestore = await environment.DB.prepare(
    `select * from article_revisions
     where workspace_id = ? and article_id = ? and revision_number <= 2
     order by revision_number`,
  )
    .bind(workspaceId, head.article.id)
    .all();
  const firstHistory = await repository.listArticleRevisionHistory({
    actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
    articleId: head.article.id,
    limit: 2,
    workspaceId,
  });
  const secondHistory = firstHistory?.nextBeforeRevisionNumber
    ? await repository.listArticleRevisionHistory({
        actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
        articleId: head.article.id,
        beforeRevisionNumber: firstHistory.nextBeforeRevisionNumber,
        limit: 2,
        workspaceId,
      })
    : null;
  const detail = await repository.getArticleRevisionDetail({
    actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
    articleId: head.article.id,
    revisionId: restored.revisionId,
    revisionNumber: restored.revisionNumber,
    workspaceId,
  });
  await environment.DB.prepare(
    "update workspace_members set status = 'disabled', updated_at = ? where workspace_id = ? and id = ?",
  )
    .bind(timestamp, workspaceId, reviewerMemberId)
    .run();
  const disabledHistory = await repository.listArticleRevisionHistory({
    actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
    articleId: head.article.id,
    workspaceId,
  });
  const disabledDetail = await repository.getArticleRevisionDetail({
    actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
    articleId: head.article.id,
    revisionId: restored.revisionId,
    revisionNumber: restored.revisionNumber,
    workspaceId,
  });
  await environment.DB.prepare(
    "update workspace_members set status = 'active', role = 'editor', updated_at = ? where workspace_id = ? and id = ?",
  )
    .bind(timestamp, workspaceId, reviewerMemberId)
    .run();
  const roleChangedHistory = await repository.listArticleRevisionHistory({
    actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
    articleId: head.article.id,
    workspaceId,
  });
  const roleChangedDetail = await repository.getArticleRevisionDetail({
    actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
    articleId: head.article.id,
    revisionId: restored.revisionId,
    revisionNumber: restored.revisionNumber,
    workspaceId,
  });
  await environment.DB.prepare(
    "update workspace_members set role = 'reviewer', updated_at = ? where workspace_id = ? and id = ?",
  )
    .bind(timestamp, workspaceId, reviewerMemberId)
    .run();
  await environment.DB.batch(
    Array.from({ length: 51 }, (_, index) =>
      environment.DB.prepare(
        `insert into article_review_events (
           id, workspace_id, article_id, revision_id, revision_number,
           member_id, action, note, created_at
         ) values (?, ?, ?, ?, ?, ?, 'restored', null, ?)`,
      ).bind(
        `d1_recovery_cap_${String(index).padStart(2, "0")}`,
        workspaceId,
        "article_d1_recovery",
        restored.revisionId,
        restored.revisionNumber,
        reviewerMemberId,
        timestamp,
      ),
    ),
  );
  const cappedDetail = await repository.getArticleRevisionDetail({
    actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
    articleId: head.article.id,
    revisionId: restored.revisionId,
    revisionNumber: restored.revisionNumber,
    workspaceId,
  });
  head = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_recovery",
    workspaceId,
  });
  if (!head) throw new Error("D1 restored recovery head was unavailable");
  const doubleRestore = await Promise.all([
    repository.restoreRevisionAsDraft({
      actor: { memberId, sessionId },
      articleId: head.article.id,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: head.revisionNumber,
      sourceRevisionId: saved.revisionId,
      sourceRevisionNumber: saved.revisionNumber,
      workspaceId,
    }),
    repository.restoreRevisionAsDraft({
      actor: { memberId, sessionId },
      articleId: head.article.id,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: head.revisionNumber,
      sourceRevisionId: saved.revisionId,
      sourceRevisionNumber: saved.revisionNumber,
      workspaceId,
    }),
  ]);
  head = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_recovery",
    workspaceId,
  });
  if (!head) throw new Error("D1 double-restore head was unavailable");

  const slugConflictArticle = request(
    "article_d1_restore_slug",
    "d1-restore-old",
    "D1 restore slug source",
  );
  const slugConflictSource = await repository.createDraftArticle(slugConflictArticle);
  if (slugConflictSource.status !== "saved") {
    throw new Error("D1 restore slug source was not created.");
  }
  const slugConflictSaved = await repository.saveDraftArticle({
    ...request(
      "article_d1_restore_slug",
      "d1-restore-current",
      "D1 restore slug current",
    ),
    expectedWorkingRevisionNumber: 1,
  });
  if (slugConflictSaved.status !== "saved") {
    throw new Error("D1 restore slug current revision was not saved.");
  }
  const slugOwner = await repository.createDraftArticle(
    request("article_d1_restore_slug_owner", "d1-restore-old", "D1 restore slug owner"),
  );
  if (slugOwner.status !== "saved") throw new Error("D1 restore slug owner was not created.");
  const slugConflictHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_restore_slug",
    workspaceId,
  });
  if (!slugConflictHead) throw new Error("D1 restore slug head was unavailable.");
  const slugConflictRestore = await repository.restoreRevisionAsDraft({
    actor: { memberId, sessionId },
    articleId: slugConflictHead.article.id,
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: slugConflictHead.revisionNumber,
    sourceRevisionId: slugConflictSource.revisionId,
    sourceRevisionNumber: slugConflictSource.revisionNumber,
    workspaceId,
  });

  const restoreRaceFirstValues = request(
    "article_d1_restore_race_first",
    "d1-restore-race-shared",
    "D1 first restore race",
  );
  const restoreRaceFirstSource = await repository.createDraftArticle(
    restoreRaceFirstValues,
  );
  if (restoreRaceFirstSource.status !== "saved") {
    throw new Error("D1 first restore race source was not created.");
  }
  await repository.saveDraftArticle({
    ...request(
      "article_d1_restore_race_first",
      "d1-restore-race-first-current",
      "D1 first restore race current",
    ),
    expectedWorkingRevisionNumber: 1,
  });
  const restoreRaceSecondValues = request(
    "article_d1_restore_race_second",
    "d1-restore-race-shared",
    "D1 second restore race",
  );
  const restoreRaceSecondSource = await repository.createDraftArticle(
    restoreRaceSecondValues,
  );
  if (restoreRaceSecondSource.status !== "saved") {
    throw new Error("D1 second restore race source was not created.");
  }
  await repository.saveDraftArticle({
    ...request(
      "article_d1_restore_race_second",
      "d1-restore-race-second-current",
      "D1 second restore race current",
    ),
    expectedWorkingRevisionNumber: 1,
  });
  const [restoreRaceFirstHead, restoreRaceSecondHead] = await Promise.all([
    repository.getArticleWorkingHead({
      actor: { memberId, sessionId },
      articleId: restoreRaceFirstValues.article.id,
      workspaceId,
    }),
    repository.getArticleWorkingHead({
      actor: { memberId, sessionId },
      articleId: restoreRaceSecondValues.article.id,
      workspaceId,
    }),
  ]);
  if (!restoreRaceFirstHead || !restoreRaceSecondHead) {
    throw new Error("D1 restore race heads were unavailable.");
  }
  const restoreSlugRace = await Promise.all([
    repository.restoreRevisionAsDraft({
      actor: { memberId, sessionId },
      articleId: restoreRaceFirstValues.article.id,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: restoreRaceFirstHead.revisionNumber,
      sourceRevisionId: restoreRaceFirstSource.revisionId,
      sourceRevisionNumber: restoreRaceFirstSource.revisionNumber,
      workspaceId,
    }),
    repository.restoreRevisionAsDraft({
      actor: { memberId, sessionId },
      articleId: restoreRaceSecondValues.article.id,
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: restoreRaceSecondHead.revisionNumber,
      sourceRevisionId: restoreRaceSecondSource.revisionId,
      sourceRevisionNumber: restoreRaceSecondSource.revisionNumber,
      workspaceId,
    }),
  ]);

  const retiredCategory = await categoryRepository.createCategory({
    actor: { memberId, sessionId, workspaceId },
    category: {
      id: "category_d1_retired",
      workspaceId,
      slug: "d1-retired",
      name: "D1 retired",
      description: null,
      position: 1,
    },
    expectedCategoryVersion: 0,
  });
  if (retiredCategory.status !== "created") {
    throw new Error("D1 retired category was not created.");
  }
  const retiredArticle = {
    ...request(
      "article_d1_retired_category",
      "d1-retired-source",
      "D1 retired source",
    ),
    article: {
      ...request(
        "article_d1_retired_category",
        "d1-retired-source",
        "D1 retired source",
      ).article,
      categoryId: retiredCategory.category.id,
    },
  };
  const retiredSource = await repository.createDraftArticle(retiredArticle);
  if (retiredSource.status !== "saved") {
    throw new Error("D1 retired category source was not created.");
  }
  const retiredCurrent = await repository.saveDraftArticle({
    ...request(
      "article_d1_retired_category",
      "d1-retired-current",
      "D1 retired current",
    ),
    expectedWorkingRevisionNumber: 1,
  });
  if (retiredCurrent.status !== "saved") {
    throw new Error("D1 retired current revision was not saved.");
  }
  const deletedRetiredCategory = await categoryRepository.deleteCategory({
    actor: { memberId, sessionId, workspaceId },
    category: { id: retiredCategory.category.id, workspaceId },
    expectedCategoryVersion: retiredCategory.category.version,
  });
  if (deletedRetiredCategory.status !== "deleted") {
    throw new Error("D1 historical-only category was not deleted.");
  }
  const retiredHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_retired_category",
    workspaceId,
  });
  if (!retiredHead) throw new Error("D1 retired category head was unavailable.");
  const missingCategoryRestore = await repository.restoreRevisionAsDraft({
    actor: { memberId, sessionId },
    articleId: retiredHead.article.id,
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: retiredHead.revisionNumber,
    sourceRevisionId: retiredSource.revisionId,
    sourceRevisionNumber: retiredSource.revisionNumber,
    workspaceId,
  });

  const unsafeValues = request(
    "article_d1_unsafe_history",
    "d1-unsafe-history",
    "D1 unsafe source",
  );
  const unsafeSource = await repository.createDraftArticle(unsafeValues);
  if (unsafeSource.status !== "saved") throw new Error("D1 unsafe source was not created.");
  const unsafeCurrent = await repository.saveDraftArticle({
    ...request(
      "article_d1_unsafe_history",
      "d1-unsafe-history",
      "D1 safe current",
    ),
    expectedWorkingRevisionNumber: 1,
  });
  if (unsafeCurrent.status !== "saved") throw new Error("D1 safe current was not saved.");
  const unsafeMdx = "# D1 unsafe source\n\n{process.env.SECRET}";
  const unsafeHash = await articleRevisionHash({
    workspaceId,
    articleId: unsafeValues.article.id,
    categoryId: unsafeValues.article.categoryId,
    categorySlug: "guides",
    categoryName: "Guides",
    slug: unsafeValues.article.slug,
    title: unsafeValues.article.title,
    mdx: unsafeMdx,
    isFaq: unsafeValues.article.isFaq,
    authorName: unsafeValues.article.authorName,
    position: unsafeValues.article.position,
    assetHashes: [],
  });
  await mutateHistoricalRevision(
    environment,
    unsafeSource.revisionId,
    unsafeMdx,
    unsafeHash,
  );
  const unsafeHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: unsafeValues.article.id,
    workspaceId,
  });
  if (!unsafeHead) throw new Error("D1 unsafe head was unavailable.");
  const unsafeRestore = await repository.restoreRevisionAsDraft({
    actor: { memberId, sessionId },
    articleId: unsafeHead.article.id,
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: unsafeHead.revisionNumber,
    sourceRevisionId: unsafeSource.revisionId,
    sourceRevisionNumber: unsafeSource.revisionNumber,
    workspaceId,
  });

  const corruptValues = request(
    "article_d1_corrupt_history",
    "d1-corrupt-history",
    "D1 corrupt source",
  );
  const corruptSource = await repository.createDraftArticle(corruptValues);
  if (corruptSource.status !== "saved") throw new Error("D1 corrupt source was not created.");
  const corruptCurrent = await repository.saveDraftArticle({
    ...request(
      "article_d1_corrupt_history",
      "d1-corrupt-history",
      "D1 corrupt current",
    ),
    expectedWorkingRevisionNumber: 1,
  });
  if (corruptCurrent.status !== "saved") throw new Error("D1 corrupt current was not saved.");
  await mutateHistoricalRevision(
    environment,
    corruptSource.revisionId,
    corruptValues.article.mdx,
    "0".repeat(64),
  );
  const corruptHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: corruptValues.article.id,
    workspaceId,
  });
  if (!corruptHead) throw new Error("D1 corrupt head was unavailable.");
  const corruptRestore = await repository.restoreRevisionAsDraft({
    actor: { memberId, sessionId },
    articleId: corruptHead.article.id,
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: corruptHead.revisionNumber,
    sourceRevisionId: corruptSource.revisionId,
    sourceRevisionNumber: corruptSource.revisionNumber,
    workspaceId,
  });

  const missingAssetHash = "c".repeat(64);
  await environment.DB.batch([
    environment.DB.prepare(
      `insert into assets (id, workspace_id, hash, media_type, byte_size, content, created_at)
       values ('asset_d1_missing_history', ?, ?, 'image/png', 1, ?, ?)`,
    ).bind(workspaceId, missingAssetHash, new Uint8Array([3]), timestamp),
    environment.DB.prepare(
      `insert into asset_manifests (id, workspace_id, expires_at, created_at)
       values ('manifest_d1_missing_history', ?, ?, ?)`,
    ).bind(workspaceId, timestamp + 3_600_000, timestamp),
    environment.DB.prepare(
      `insert into asset_manifest_items (manifest_id, asset_id, workspace_id, created_at)
       values ('manifest_d1_missing_history', 'asset_d1_missing_history', ?, ?)`,
    ).bind(workspaceId, timestamp),
  ]);
  const assetValues = request(
    "article_d1_missing_asset",
    "d1-missing-asset",
    "D1 missing asset source",
  );
  const assetSource = await repository.createDraftArticle({
    ...assetValues,
    assets: { manifestId: "manifest_d1_missing_history", hashes: [missingAssetHash] },
  });
  if (assetSource.status !== "saved") throw new Error("D1 asset source was not created.");
  const assetCurrent = await repository.saveDraftArticle({
    ...request(
      "article_d1_missing_asset",
      "d1-missing-asset",
      "D1 missing asset current",
    ),
    expectedWorkingRevisionNumber: 1,
  });
  if (assetCurrent.status !== "saved") throw new Error("D1 asset current was not saved.");
  const assetHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: assetValues.article.id,
    workspaceId,
  });
  if (!assetHead) throw new Error("D1 missing asset head was unavailable.");
  let assetSabotaged = false;
  const assetRaceBinding = new Proxy(environment.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!assetSabotaged) {
            assetSabotaged = true;
            await target.prepare(
              "update assets set hash = ? where workspace_id = ? and id = 'asset_d1_missing_history'",
            )
              .bind("d".repeat(64), workspaceId)
              .run();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  const assetRaceRepository = createSqliteArticleDraftRepository(
    drizzle(assetRaceBinding, { schema }),
    { clock: () => new Date(timestamp) },
  );
  const missingAssetRestore = await assetRaceRepository.restoreRevisionAsDraft({
    actor: { memberId, sessionId },
    articleId: assetHead.article.id,
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: assetHead.revisionNumber,
    sourceRevisionId: assetSource.revisionId,
    sourceRevisionNumber: assetSource.revisionNumber,
    workspaceId,
  });
  await environment.DB.prepare(
    "update assets set hash = ? where workspace_id = ? and id = 'asset_d1_missing_history'",
  )
    .bind(missingAssetHash, workspaceId)
    .run();
  const negativeRevisionCounts = await environment.DB.prepare(
    `select article_id, count(*) as revision_count
     from article_revisions
     where workspace_id = ? and article_id in (
       'article_d1_restore_slug', 'article_d1_retired_category',
       'article_d1_unsafe_history', 'article_d1_corrupt_history',
       'article_d1_missing_asset'
     )
     group by article_id order by article_id`,
  )
    .bind(workspaceId)
    .all();
  const inReviewValues = request(
    "article_d1_in_review_restore",
    "d1-in-review-restore",
    "D1 in-review restore",
  );
  const inReviewSource = await repository.createDraftArticle(inReviewValues);
  if (inReviewSource.status !== "saved") {
    throw new Error("D1 in-review restore source was not created.");
  }
  const inReviewSubmission = await repository.submitArticleForReview({
    actor: { memberId, sessionId },
    articleId: inReviewValues.article.id,
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: inReviewSource.revisionNumber,
    revisionId: inReviewSource.revisionId,
    workspaceId,
  });
  if (inReviewSubmission.status !== "transitioned") {
    throw new Error("D1 in-review restore source was not submitted.");
  }
  const inReviewRestore = await repository.restoreRevisionAsDraft({
    actor: { memberId, sessionId },
    articleId: inReviewValues.article.id,
    expectedReviewState: "in_review" as never,
    expectedWorkingRevisionNumber: inReviewSource.revisionNumber,
    sourceRevisionId: "revision_missing_without_lookup",
    sourceRevisionNumber: 99,
    workspaceId,
  });
  const slugClaimsBeforeArchive = await environment.DB.prepare(
    `select normalized_slug, working_claim, article_row_claim
     from article_slug_claims
     where workspace_id = ? and article_id = ?
     order by normalized_slug`,
  )
    .bind(workspaceId, head.article.id)
    .all();
  const grantId = "Q".repeat(43);
  await environment.DB.prepare(
    `insert into article_preview_grants (
       id, workspace_id, revision_id, created_by_member_id, expires_at, created_at
     ) values (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      grantId,
      workspaceId,
      head.revisionId,
      reviewerMemberId,
      timestamp + 604_800_000,
      timestamp,
    )
    .run();
  const archiveRequest = {
    actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
    articleId: head.article.id,
    expectedPublicStatus: head.publicStatus,
    expectedReviewState: head.reviewState,
    expectedWorkingRevisionNumber: head.revisionNumber,
    revisionId: head.revisionId,
    workspaceId,
  } as const;
  const archiveRace = await Promise.all([
    repository.archiveArticle(archiveRequest),
    repository.archiveArticle(archiveRequest),
  ]);
  head = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_recovery",
    workspaceId,
  });
  if (!head) throw new Error("D1 archived recovery head was unavailable");
  const restoreWhileArchived = await repository.restoreRevisionAsDraft({
    actor: { memberId, sessionId },
    articleId: head.article.id,
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: head.revisionNumber,
    sourceRevisionId: created.revisionId,
    sourceRevisionNumber: created.revisionNumber,
    workspaceId,
  });
  const archivedState = await environment.DB.prepare(
    `select article.status, article.content_hash, head.archived_at,
       (select count(*) from evidence_chunks
        where workspace_id = article.workspace_id and article_id = article.id) as evidence_count,
       (select count(*) from article_revisions
        where workspace_id = article.workspace_id and article_id = article.id) as revision_count,
       (select count(*) from article_preview_grants
        where id = ? and revoked_at is not null and revoked_by_member_id = ?) as revoked_grants
     from articles article
     inner join article_heads head
       on head.workspace_id = article.workspace_id and head.article_id = article.id
     where article.workspace_id = ? and article.id = ?`,
  )
    .bind(grantId, reviewerMemberId, workspaceId, head.article.id)
    .first();
  const slugClaimsAfterArchive = await environment.DB.prepare(
    `select normalized_slug, working_claim, article_row_claim
     from article_slug_claims
     where workspace_id = ? and article_id = ?
     order by normalized_slug`,
  )
    .bind(workspaceId, head.article.id)
    .all();
  const restoreArchiveRequest = {
    actor: { memberId, sessionId },
    articleId: head.article.id,
    expectedPublicStatus: head.publicStatus,
    expectedReviewState: head.reviewState,
    expectedWorkingRevisionNumber: head.revisionNumber,
    revisionId: head.revisionId,
    workspaceId,
  } as const;
  const archiveRestoreRace = await Promise.all([
    repository.restoreArchivedArticle(restoreArchiveRequest),
    repository.restoreArchivedArticle(restoreArchiveRequest),
  ]);
  const recoveredHead = await repository.getArticleWorkingHead({
    actor: { memberId, sessionId },
    articleId: "article_d1_recovery",
    workspaceId,
  });
  await environment.DB.prepare(
    "update admin_sessions set revoked_at = ? where workspace_id = ? and id = ?",
  )
    .bind(timestamp, workspaceId, reviewerSessionId)
    .run();
  const revokedHistory = await repository.listArticleRevisionHistory({
    actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
    articleId: head.article.id,
    workspaceId,
  });
  const revokedDetail = await repository.getArticleRevisionDetail({
    actor: { memberId: reviewerMemberId, sessionId: reviewerSessionId },
    articleId: head.article.id,
    revisionId: restored.revisionId,
    revisionNumber: restored.revisionNumber,
    workspaceId,
  });
  return {
    archiveRace,
    archiveRestoreRace,
    archivedState,
    cappedDetail,
    detail,
    disabledDetail,
    disabledHistory,
    doubleRestore,
    firstHistory,
    inReviewRestore,
    missingAssetRestore,
    missingCategoryRestore,
    negativeRevisionCounts: negativeRevisionCounts.results,
    published,
    priorRevisionsUnchanged:
      JSON.stringify(priorRevisionsAfterRestore.results) ===
      JSON.stringify(priorRevisionsBeforeRestore.results),
    recoveredHead,
    revokedDetail,
    revokedHistory,
    restoreWhileArchived,
    restored,
    roleChangedDetail,
    roleChangedHistory,
    restoreSlugRace,
    secondHistory,
    slugClaimsAfterArchive: slugClaimsAfterArchive.results,
    slugClaimsBeforeArchive: slugClaimsBeforeArchive.results,
    slugConflictRestore,
    corruptRestore,
    unsafeRestore,
  };
}

export default {
  async fetch(request: Request, environment: Environment) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/health") return new Response("ready");
    try {
      if (pathname === "/setup") {
        await setup(environment);
        return Response.json({ setup: true });
      }
      if (pathname === "/exercise") return Response.json(await exercise(environment));
      if (pathname === "/recovery") {
        return Response.json(await exerciseRecovery(environment));
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<Environment>;
