// ABOUTME: Verifies the frozen revision, workflow, preview, and team-authoring fixtures.
// ABOUTME: Prevents persistence work from weakening exact revision and public-isolation rules.

import assert from "node:assert/strict";
import test from "node:test";

import { articlePreviewTokenContract } from "@/auth/preview-claims";
import {
  articleRevisionHash,
  articleChangeKinds,
  migrationArticleRevisionId,
  serializeArticleRevision,
  type ArticleRevisionSnapshot,
} from "@/content/article-revision";
import {
  advanceWorkingRevision,
  approveRevision,
  archiveArticle,
  articlePreviewSubject,
  articleReviewActions,
  articleReviewStates,
  articleWorkflowTransitions,
  ArticleWorkflowConflict,
  emergencyPublishRevision,
  invalidateReviewForCategoryChange,
  publishApprovedRevision,
  requestRevisionChanges,
  restoreArchivedArticle,
  restoreRevisionAsDraft,
  submitRevisionForReview,
  unpublishArticle,
  withdrawRevisionFromReview,
  type ArticleHeadContract,
} from "@/content/article-workflow";
import {
  teamAuthoringStandard,
  teamAuthoringStandardHashInputV1,
} from "@/evaluation/fixtures/team-authoring-standard";

const publishedHead: ArticleHeadContract = Object.freeze({
  workingRevisionId: "revision_6",
  workingRevisionNumber: 6,
  publishedRevisionId: "revision_6",
  publishedRevisionNumber: 6,
  publicStatus: "published",
  reviewState: "published",
  archived: false,
});

test("workflow states, events, change kinds, and preview claims stay closed", () => {
  assert.deepEqual(articleReviewStates, [
    "editing",
    "in_review",
    "changes_requested",
    "approved",
    "published",
  ]);
  assert.deepEqual(articleReviewActions, [
    "submitted",
    "withdrawn",
    "changes_requested",
    "category_changed",
    "approved",
    "published",
    "unpublished",
    "archived",
    "restored",
    "emergency_published",
  ]);
  assert.deepEqual(articleChangeKinds, [
    "manual",
    "import",
    "rollback",
    "migration",
    "seed",
  ]);
  assert.deepEqual(articleWorkflowTransitions, {
    save: {
      from: ["editing", "changes_requested", "approved", "published"],
      to: "editing",
    },
    submit: { from: ["editing", "changes_requested"], to: "in_review" },
    withdraw: { from: ["in_review"], to: "editing" },
    requestChanges: { from: ["in_review"], to: "changes_requested" },
    approve: { from: ["in_review"], to: "approved" },
    publish: { from: ["approved"], to: "published" },
    emergencyPublish: { from: articleReviewStates, to: "published" },
    unpublish: { from: articleReviewStates, to: "state-dependent" },
    archive: { from: articleReviewStates, to: "state-dependent" },
    restoreArchive: { from: articleReviewStates, to: "editing" },
    categoryChange: {
      from: ["in_review", "approved"],
      to: "changes_requested",
    },
  });
  assert.deepEqual(articlePreviewTokenContract, {
    algorithm: "HS256",
    audience: "opas-article-preview",
    issuer: "opas",
    lifetimeSeconds: 604_800,
    cookiePath: "/preview",
    claims: {
      deploymentId: "did",
      grantId: "jti",
      revisionId: "rid",
      workspaceId: "wid",
    },
  });
});

test("private saves advance only the immutable working head", () => {
  const saved = advanceWorkingRevision(publishedHead, {
    expectedWorkingRevisionNumber: 6,
    revisionId: "revision_7",
  });

  assert.deepEqual(saved, {
    ...publishedHead,
    workingRevisionId: "revision_7",
    workingRevisionNumber: 7,
    reviewState: "editing",
  });
  assert.equal(saved.publishedRevisionId, "revision_6");
  assert.equal(saved.publishedRevisionNumber, 6);
});

test("stale saves and moving-head publication are rejected", () => {
  assert.throws(
    () =>
      advanceWorkingRevision(publishedHead, {
        expectedWorkingRevisionNumber: 5,
        revisionId: "revision_7",
      }),
    (error) =>
      error instanceof ArticleWorkflowConflict && error.code === "STALE_REVISION",
  );

  const approved: ArticleHeadContract = {
    ...publishedHead,
    workingRevisionId: "revision_7",
    workingRevisionNumber: 7,
    reviewState: "approved",
  };
  assert.throws(
    () =>
      publishApprovedRevision(approved, {
        expectedWorkingRevisionNumber: 7,
        revisionId: "revision_6",
      }),
    (error) =>
      error instanceof ArticleWorkflowConflict && error.code === "REVISION_MISMATCH",
  );
});

test("publishing selects the exact approved revision", () => {
  const approved: ArticleHeadContract = {
    ...publishedHead,
    workingRevisionId: "revision_7",
    workingRevisionNumber: 7,
    reviewState: "approved",
  };
  const result = publishApprovedRevision(approved, {
    expectedWorkingRevisionNumber: 7,
    revisionId: "revision_7",
  });
  assert.equal(result.publishedRevisionId, "revision_7");
  assert.equal(result.publishedRevisionNumber, 7);
  assert.equal(result.reviewState, "published");
});

test("review transitions remain pinned to one exact revision", () => {
  const editing = advanceWorkingRevision(publishedHead, {
    expectedWorkingRevisionNumber: 6,
    revisionId: "revision_7",
  });
  const submitted = submitRevisionForReview(editing, {
    expectedWorkingRevisionNumber: 7,
    revisionId: "revision_7",
  });
  assert.equal(submitted.reviewState, "in_review");
  assert.equal(
    withdrawRevisionFromReview(submitted, {
      expectedWorkingRevisionNumber: 7,
      revisionId: "revision_7",
    }).reviewState,
    "editing",
  );
  assert.equal(
    requestRevisionChanges(submitted, {
      expectedWorkingRevisionNumber: 7,
      revisionId: "revision_7",
    }).reviewState,
    "changes_requested",
  );
  const approved = approveRevision(submitted, {
    expectedWorkingRevisionNumber: 7,
    revisionId: "revision_7",
  });
  assert.equal(approved.reviewState, "approved");
  assert.equal(invalidateReviewForCategoryChange(approved).reviewState, "changes_requested");

  assert.throws(
    () =>
      approveRevision(submitted, {
        expectedWorkingRevisionNumber: 7,
        revisionId: "revision_6",
      }),
    (error) =>
      error instanceof ArticleWorkflowConflict && error.code === "REVISION_MISMATCH",
  );
});

test("emergency publication, unpublish, archive, and archive restore keep pointer rules", () => {
  const editing = advanceWorkingRevision(publishedHead, {
    expectedWorkingRevisionNumber: 6,
    revisionId: "revision_7",
  });
  const emergencyPublished = emergencyPublishRevision(editing, {
    expectedWorkingRevisionNumber: 7,
    revisionId: "revision_7",
  });
  assert.equal(emergencyPublished.publicStatus, "published");
  assert.equal(emergencyPublished.publishedRevisionId, "revision_7");

  const unpublished = unpublishArticle(emergencyPublished, {
    expectedWorkingRevisionNumber: 7,
    revisionId: "revision_7",
    expectedReviewState: "published",
    expectedPublicStatus: "published",
  });
  assert.equal(unpublished.publicStatus, "draft");
  assert.equal(unpublished.reviewState, "approved");
  assert.equal(unpublished.publishedRevisionId, "revision_7");

  const changed = { ...editing, reviewState: "changes_requested" as const };
  const archived = archiveArticle(changed, {
    expectedWorkingRevisionNumber: 7,
    revisionId: "revision_7",
    expectedReviewState: "changes_requested",
    expectedPublicStatus: "published",
  });
  assert.equal(archived.archived, true);
  assert.equal(archived.publicStatus, "draft");
  assert.equal(archived.reviewState, "changes_requested");
  const restored = restoreArchivedArticle(archived, {
    expectedWorkingRevisionNumber: 7,
    revisionId: "revision_7",
    expectedReviewState: "changes_requested",
    expectedPublicStatus: "draft",
  });
  assert.equal(restored.archived, false);
  assert.equal(restored.publicStatus, "draft");
  assert.equal(restored.reviewState, "editing");

  for (const operation of [
    () =>
      unpublishArticle(emergencyPublished, {
        expectedWorkingRevisionNumber: 6,
        revisionId: "revision_7",
        expectedReviewState: "published",
        expectedPublicStatus: "published",
      }),
    () =>
      archiveArticle(changed, {
        expectedWorkingRevisionNumber: 7,
        revisionId: "revision_6",
        expectedReviewState: "changes_requested",
        expectedPublicStatus: "published",
      }),
    () =>
      restoreArchivedArticle(archived, {
        expectedWorkingRevisionNumber: 7,
        revisionId: "revision_7",
        expectedReviewState: "approved",
        expectedPublicStatus: "draft",
      }),
  ]) {
    assert.throws(
      operation,
      (error) => error instanceof ArticleWorkflowConflict,
    );
  }
});

test("rollback appends and never rewrites the selected historical revision", () => {
  const result = restoreRevisionAsDraft(publishedHead, {
    expectedWorkingRevisionNumber: 6,
    revisionId: "revision_7",
    restoredFromRevisionId: "revision_2",
  });
  assert.equal(result.head.workingRevisionNumber, 7);
  assert.equal(result.head.workingRevisionId, "revision_7");
  assert.equal(result.restoredFromRevisionId, "revision_2");
  assert.equal(result.head.publishedRevisionId, "revision_6");
});

test("preview identity is pinned to a saved revision instead of a moving head", () => {
  const subject = articlePreviewSubject("revision_3");
  const movedHead = { ...publishedHead, workingRevisionId: "revision_7" };
  assert.deepEqual(subject, { revisionId: "revision_3" });
  assert.equal(subject.revisionId === movedHead.workingRevisionId, false);
  assert.deepEqual(articlePreviewTokenContract.claims, {
    deploymentId: "did",
    grantId: "jti",
    revisionId: "rid",
    workspaceId: "wid",
  });
  assert.equal(articlePreviewTokenContract.cookiePath, "/preview");
});

test("revision serialization is canonical and covers every editable field", async () => {
  const snapshot = teamAuthoringStandard.publishedArticle;
  const reorderedAssets: ArticleRevisionSnapshot = {
    ...snapshot,
    assetHashes: [...snapshot.assetHashes].reverse(),
  };
  assert.equal(serializeArticleRevision(snapshot), serializeArticleRevision(reorderedAssets));
  assert.equal(await articleRevisionHash(snapshot), await articleRevisionHash(reorderedAssets));

  for (const [field, value] of [
    ["categoryId", "category_changed"],
    ["categorySlug", "changed"],
    ["categoryName", "Changed"],
    ["slug", "changed"],
    ["title", "Changed"],
    ["mdx", "# Changed"],
    ["isFaq", true],
    ["authorName", "Changed"],
    ["position", 12],
  ] as const) {
    assert.notEqual(
      await articleRevisionHash(snapshot),
      await articleRevisionHash({ ...snapshot, [field]: value }),
      field,
    );
  }
  assert.notEqual(
    await articleRevisionHash(snapshot),
    await articleRevisionHash({ ...snapshot, assetHashes: ["3".repeat(64)] }),
  );
});

test("revision format has stable golden bytes, hash, and migration identity", async () => {
  const snapshot: ArticleRevisionSnapshot = {
    workspaceId: "workspace_fixture",
    articleId: "article_fixture",
    categoryId: "category_fixture",
    categorySlug: "guides",
    categoryName: "Guides",
    slug: "safe-editing",
    title: "Safe editing",
    mdx: "# Safe editing\n\nDraft safely.",
    isFaq: true,
    authorName: "OPAS",
    position: 4,
    assetHashes: ["b".repeat(64), "a".repeat(64)],
  };
  assert.equal(
    serializeArticleRevision(snapshot),
    '["opas.article-revision.v1","workspace_fixture","article_fixture","category_fixture","guides","Guides","safe-editing","Safe editing","# Safe editing\\n\\nDraft safely.",true,"OPAS",4,["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]]',
  );
  assert.equal(
    await articleRevisionHash(snapshot),
    "584efdf4493d76bf1f358d0fdb68ae2c6bab8dbba8be0af4d693ebf2f84005cd",
  );
  assert.equal(
    await migrationArticleRevisionId(snapshot.workspaceId, snapshot.articleId),
    "revision_6b0d1081106b8eabb0dab6f4d165818d4c48a29b4754ab3f5b84d8fe0e704b87",
  );
});

test("migration revision IDs are deterministic and scoped to workspace and article", async () => {
  const first = await migrationArticleRevisionId("workspace_one", "article_one");
  assert.equal(first, await migrationArticleRevisionId("workspace_one", "article_one"));
  assert.notEqual(first, await migrationArticleRevisionId("workspace_two", "article_one"));
  assert.notEqual(first, await migrationArticleRevisionId("workspace_one", "article_two"));
  assert.match(first, /^revision_[a-f\d]{64}$/u);
});

test("team-authoring-standard freezes the complete release fixture", () => {
  assert.equal(teamAuthoringStandard.id, "team-authoring-standard");
  assert.equal(teamAuthoringStandard.version, 1);
  assert.equal(teamAuthoringStandard.workspaceId, "workspace_demo");
  assert.deepEqual(
    teamAuthoringStandard.members.map(({ role }) => role),
    ["administrator", "editor", "reviewer"],
  );
  assert.equal(teamAuthoringStandard.categories.length, 2);
  assert.equal(teamAuthoringStandard.assets.length, 2);
  assert.match(teamAuthoringStandard.publishedArticle.mdx, /\| Step \| Owner \|/u);
  assert.match(teamAuthoringStandard.publishedArticle.mdx, /\/api\/assets\//u);
  assert.match(teamAuthoringStandard.publishedArticle.mdx, /https:\/\/media\.example\.invalid/u);
  assert.ok(new TextEncoder().encode(teamAuthoringStandard.largeDraft.mdx).byteLength >= 98_000);
  assert.ok(new TextEncoder().encode(teamAuthoringStandard.largeDraft.mdx).byteLength < 100_000);
  assert.equal(teamAuthoringStandard.importedArticles.length, 100);
  assert.ok(teamAuthoringStandard.importedArticles.some(({ status }) => status === "published"));
  assert.deepEqual(
    teamAuthoringStandard.migrationCases.map(({ expectedHead, status }) => ({
      expectedHead,
      status,
    })),
    [
      {
        status: "published",
        expectedHead: {
          workingRevisionNumber: 1,
          publishedRevisionNumber: 1,
          reviewState: "published",
        },
      },
      {
        status: "draft",
        expectedHead: {
          workingRevisionNumber: 1,
          publishedRevisionNumber: null,
          reviewState: "editing",
        },
      },
    ],
  );
});

test("migration cases freeze both published and draft baseline identities", async () => {
  for (const migrationCase of teamAuthoringStandard.migrationCases) {
    assert.equal(
      serializeArticleRevision(migrationCase.article),
      migrationCase.expectedSerialization,
      `${migrationCase.status} serialization`,
    );
    assert.equal(
      await articleRevisionHash(migrationCase.article),
      migrationCase.expectedHash,
      `${migrationCase.status} hash`,
    );
    assert.equal(
      await migrationArticleRevisionId(
        teamAuthoringStandard.workspaceId,
        migrationCase.article.articleId,
      ),
      migrationCase.expectedRevisionId,
      `${migrationCase.status} revision ID`,
    );
  }
});

test("team-authoring-standard content remains bound to its frozen digest", async () => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(teamAuthoringStandardHashInputV1),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  assert.equal(hash, teamAuthoringStandard.contentHash);
});
