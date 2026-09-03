// ABOUTME: Verifies private article saves and revision-pinned workflow action integration.
// ABOUTME: Covers exact forms, conflict preservation, evidence scheduling, and role-facing controls.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import type { ArticleWorkflowAction } from "@/app/admin/content/article-action-contracts";
import {
  runArticleWorkflowAction,
  runSaveArticleAction,
  type ArticleActionDependencies,
} from "@/app/admin/content/article-action-runtime";
import { ArticleWorkflowControls } from "@/app/admin/content/article-workflow-controls";
import type {
  ArticleWorkingHead,
  ArticleWorkflowResult,
} from "@/db/article-drafts";

const actor = Object.freeze({
  memberId: "member_editor",
  sessionId: "session_editor",
});
const initialState = Object.freeze({
  status: "idle" as const,
  message: "",
  revision: 0,
});

function formData(values: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}

function articleForm(
  values: Partial<Record<string, string>> = {},
) {
  return formData({
    mode: "create",
    categoryId: "category_guides",
    title: "Reset a password",
    slug: "reset-a-password",
    mdx: "# Reset a password\n\nFollow these steps.",
    authorName: "OPAS",
    ...values,
  });
}

function workflowForm(
  expectedReviewState: string,
  values: Partial<Record<string, string>> = {},
) {
  return formData({
    id: "article_reset",
    revisionId: "revision_reset_4",
    expectedWorkingRevisionNumber: "4",
    expectedReviewState,
    ...values,
  });
}

function workingHead(): ArticleWorkingHead {
  return {
    article: {
      id: "article_reset",
      workspaceId: "workspace_one",
      categoryId: "category_guides",
      slug: "reset-a-password",
      title: "Reset a password",
      mdx: "# Reset a password\n\nCurrent answer.",
      isFaq: false,
      authorName: "OPAS",
      position: 7,
    },
    archivedAt: null,
    assetHashes: [],
    changeKind: "manual",
    changeSummary: null,
    createdAt: new Date("2026-09-03T10:00:00.000Z"),
    createdByMemberId: actor.memberId,
    createdBySystemLabel: null,
    publicStatus: "published",
    publishedRevisionId: "revision_reset_2",
    publishedRevisionNumber: 2,
    reviewState: "editing",
    revisionHash: "a".repeat(64),
    revisionId: "revision_reset_4",
    revisionNumber: 4,
    submittedByMemberId: null,
  };
}

function transitioned(
  overrides: Partial<Extract<ArticleWorkflowResult, { status: "transitioned" }>> = {},
): Extract<ArticleWorkflowResult, { status: "transitioned" }> {
  return {
    status: "transitioned",
    action: "approved",
    articleId: "article_reset",
    eventId: "review_event_one",
    publicStatus: "draft",
    reviewState: "approved",
    revisionId: "revision_reset_4",
    revisionNumber: 4,
    ...overrides,
  };
}

function repositoryHarness() {
  const calls: Array<{ method: string; request: unknown }> = [];
  let head: ArticleWorkingHead | null = workingHead();
  let saveResult: Awaited<
    ReturnType<ArticleActionDependencies["repository"]["saveDraftArticle"]>
  > = {
    status: "saved",
    articleId: "article_reset",
    revisionId: "revision_reset_5",
    revisionNumber: 5,
  };
  let workflowResult: ArticleWorkflowResult = transitioned();
  const record = async (method: string, request: unknown) => {
    calls.push({ method, request });
    return workflowResult;
  };
  const repository: ArticleActionDependencies["repository"] = {
    async approveAndPublishArticleRevision(request) {
      return record("approveAndPublishArticleRevision", request);
    },
    async approveArticleRevision(request) {
      return record("approveArticleRevision", request);
    },
    async createDraftArticle(request) {
      calls.push({ method: "createDraftArticle", request });
      return {
        status: "saved",
        articleId: request.article.id,
        revisionId: "revision_reset_1",
        revisionNumber: 1,
      };
    },
    async emergencyPublishArticle(request) {
      return record("emergencyPublishArticle", request);
    },
    async getArticleWorkingHead(request) {
      calls.push({ method: "getArticleWorkingHead", request });
      return head;
    },
    async publishArticleRevision(request) {
      return record("publishArticleRevision", request);
    },
    async requestArticleChanges(request) {
      return record("requestArticleChanges", request);
    },
    async saveDraftArticle(request) {
      calls.push({ method: "saveDraftArticle", request });
      return saveResult;
    },
    async submitArticleForReview(request) {
      return record("submitArticleForReview", request);
    },
    async unpublishArticle(request) {
      return record("unpublishArticle", request);
    },
    async withdrawArticleReview(request) {
      return record("withdrawArticleReview", request);
    },
  };
  return {
    calls,
    repository,
    setHead(value: ArticleWorkingHead | null) {
      head = value;
    },
    setSaveResult(value: typeof saveResult) {
      saveResult = value;
    },
    setWorkflowResult(value: ArticleWorkflowResult) {
      workflowResult = value;
    },
  };
}

function dependencies(
  repository: ArticleActionDependencies["repository"],
  overrides: Partial<ArticleActionDependencies> = {},
): ArticleActionDependencies {
  return {
    actor,
    createArticleId: () => "article_reset",
    repository,
    workspaceId: "workspace_one",
    ...overrides,
  };
}

test("new article saves create one private revision without scheduling public evidence", async () => {
  const harness = repositoryHarness();
  let revalidations = 0;
  let schedules = 0;
  const result = await runSaveArticleAction(
    initialState,
    articleForm({ isFaq: "on" }),
    dependencies(harness.repository, {
      revalidateContent: () => revalidations += 1,
      scheduleEvidenceRecovery: () => schedules += 1,
    }),
  );

  assert.deepEqual(result, {
    status: "success",
    message: "Saved as revision 1.",
    revision: 1,
    articleId: "article_reset",
    created: true,
    persistedRevisionId: "revision_reset_1",
    persistedRevisionNumber: 1,
  });
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0]?.method, "createDraftArticle");
  assert.deepEqual(harness.calls[0]?.request, {
    actor,
    article: {
      id: "article_reset",
      workspaceId: "workspace_one",
      categoryId: "category_guides",
      slug: "reset-a-password",
      title: "Reset a password",
      mdx: "# Reset a password\n\nFollow these steps.",
      isFaq: true,
      authorName: "OPAS",
      position: 0,
    },
    assets: { manifestId: undefined, hashes: [] },
    changeKind: "manual",
  });
  assert.equal(revalidations, 1);
  assert.equal(schedules, 0);
});

test("stale saves use the exact expected revision and retain local staged state", async () => {
  const harness = repositoryHarness();
  harness.setSaveResult({
    status: "conflict",
    code: "STALE_REVISION",
    currentRevisionNumber: 6,
  });
  const manifestId = "asset_manifest_123e4567-e89b-42d3-a456-426614174000";
  const result = await runSaveArticleAction(
    initialState,
    articleForm({
      mode: "update",
      id: "article_reset",
      expectedWorkingRevisionNumber: "4",
      assetManifestId: manifestId,
      title: "My unsaved title",
      mdx: "# My unsaved title\n\nKeep this local answer.",
    }),
    dependencies(harness.repository),
  );

  assert.equal(result.status, "error");
  assert.equal(result.code, "STALE_REVISION");
  assert.equal(result.currentRevisionNumber, 6);
  assert.equal(result.assetManifestStatus, undefined);
  assert.match(result.message, /local changes and staged images are still here/iu);
  assert.equal(harness.calls[0]?.method, "getArticleWorkingHead");
  assert.equal(harness.calls[1]?.method, "saveDraftArticle");
  const request = harness.calls[1]?.request as {
    article: { position: number; title: string };
    assets: { manifestId?: string };
    expectedWorkingRevisionNumber: number;
  };
  assert.equal(request.expectedWorkingRevisionNumber, 4);
  assert.equal(request.article.position, 7);
  assert.equal(request.article.title, "My unsaved title");
  assert.equal(request.assets.manifestId, manifestId);
});

test("workflow actions reject forged targets and require an emergency reason before writes", async () => {
  const harness = repositoryHarness();
  const forged = workflowForm("approved", { workspaceId: "workspace_other" });
  assert.equal(
    (await runArticleWorkflowAction(
      "publish",
      forged,
      dependencies(harness.repository),
    )).status,
    "error",
  );

  const emergency = workflowForm("editing", { reason: "   " });
  assert.equal(
    (await runArticleWorkflowAction(
      "emergencyPublish",
      emergency,
      dependencies(harness.repository),
    )).status,
    "error",
  );
  assert.equal(harness.calls.length, 0);
});

test("private review transitions do not schedule evidence while exact publication does once", async () => {
  const harness = repositoryHarness();
  let schedules = 0;
  let revalidations = 0;
  harness.setWorkflowResult(transitioned());
  const approved = await runArticleWorkflowAction(
    "approve",
    workflowForm("in_review"),
    dependencies(harness.repository, {
      revalidateContent: () => revalidations += 1,
      scheduleEvidenceRecovery: () => schedules += 1,
    }),
  );
  assert.equal(approved.status, "success");
  assert.equal(harness.calls[0]?.method, "approveArticleRevision");
  assert.equal(schedules, 0);

  harness.setWorkflowResult(
    transitioned({
      action: "published",
      evidenceJobId: "embedding_job_one",
      publicStatus: "published",
      reviewState: "published",
    }),
  );
  const published = await runArticleWorkflowAction(
    "publish",
    workflowForm("approved"),
    dependencies(harness.repository, {
      revalidateContent: () => revalidations += 1,
      scheduleEvidenceRecovery: () => schedules += 1,
    }),
  );
  assert.equal(published.status, "success");
  assert.equal(harness.calls[1]?.method, "publishArticleRevision");
  assert.deepEqual(harness.calls[1]?.request, {
    actor,
    articleId: "article_reset",
    expectedReviewState: "approved",
    expectedWorkingRevisionNumber: 4,
    revisionId: "revision_reset_4",
    workspaceId: "workspace_one",
  });
  assert.equal(schedules, 1);
  assert.equal(revalidations, 2);
});

test("every workflow intent dispatches the exact revision target to its named method", async () => {
  const harness = repositoryHarness();
  const cases = [
    ["submit", "editing", {}, "submitArticleForReview"],
    ["withdraw", "in_review", {}, "withdrawArticleReview"],
    [
      "requestChanges",
      "in_review",
      { note: "  Clarify this step.  " },
      "requestArticleChanges",
    ],
    ["approve", "in_review", {}, "approveArticleRevision"],
    [
      "approveAndPublish",
      "in_review",
      {},
      "approveAndPublishArticleRevision",
    ],
    ["publish", "approved", {}, "publishArticleRevision"],
    [
      "emergencyPublish",
      "changes_requested",
      { reason: "  Urgent legal correction.  " },
      "emergencyPublishArticle",
    ],
    ["unpublish", "published", {}, "unpublishArticle"],
  ] as const;

  for (const [intent, reviewState, values, method] of cases) {
    const result = await runArticleWorkflowAction(
      intent,
      workflowForm(reviewState, values),
      dependencies(harness.repository),
    );
    assert.equal(result.status, "success");
    const call = harness.calls.at(-1);
    assert.equal(call?.method, method);
    assert.equal(
      (call?.request as { revisionId: string }).revisionId,
      "revision_reset_4",
    );
    assert.equal(
      (call?.request as { expectedWorkingRevisionNumber: number })
        .expectedWorkingRevisionNumber,
      4,
    );
  }

  assert.equal(
    (
      harness.calls.find(({ method }) => method === "requestArticleChanges")
        ?.request as { note: string }
    ).note,
    "Clarify this step.",
  );
  assert.equal(
    (
      harness.calls.find(({ method }) => method === "emergencyPublishArticle")
        ?.request as { reason: string }
    ).reason,
    "Urgent legal correction.",
  );
});

test("workflow controls distinguish working from live state and expose exact reviewer actions", () => {
  const action: ArticleWorkflowAction = async () => ({
    status: "success",
    message: "done",
  });
  const markup = renderToStaticMarkup(
    <ArticleWorkflowControls
      actions={{
        approve: action,
        approveAndPublish: action,
        emergencyPublish: action,
        publish: action,
        requestChanges: action,
        submit: action,
        unpublish: action,
        withdraw: action,
      }}
      hasUnsavedChanges={false}
      permissions={{
        canEmergencyPublish: false,
        canPublish: true,
        canReview: true,
        canSubmit: false,
        canUnpublish: true,
        canWithdraw: false,
      }}
      workflow={{
        articleId: "article_reset",
        publicStatus: "published",
        publishedRevisionNumber: 2,
        reviewState: "in_review",
        revisionId: "revision_reset_4",
        revisionNumber: 4,
      }}
    />,
  );

  assert.match(markup, /Persisted revision 4/u);
  assert.match(markup, />Working</u);
  assert.match(markup, />Live</u);
  assert.match(markup, /Revision 2 is live\. Working revision 4 remains private/u);
  assert.match(markup, /Request changes/u);
  assert.match(markup, /Approve privately/u);
  assert.match(markup, /Approve this exact revision and make it public/u);
  assert.match(markup, /Remove the current article from the public help center/u);
  assert.match(markup, /name="revisionId" value="revision_reset_4"/u);
  assert.match(markup, /aria-live="polite"/u);
});

test("authenticated integration uses draft/workflow methods and the authorized working head", async () => {
  const [actions, editor, editPage, newPage] = await Promise.all([
    readFile(new URL("../src/app/admin/content/actions.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/admin/content/article-editor.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../src/app/admin/content/articles/[id]/page.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/app/admin/content/articles/new/page.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.doesNotMatch(actions, /repository\.(?:createArticle|updateArticle|deleteArticle)\(/u);
  assert.doesNotMatch(actions, /prepareArticleEvidence/u);
  assert.match(actions, /runSaveArticleAction/u);
  for (const actionName of [
    "submitArticleForReviewAction",
    "withdrawArticleReviewAction",
    "requestArticleChangesAction",
    "approveArticleRevisionAction",
    "approveAndPublishArticleRevisionAction",
    "publishArticleRevisionAction",
    "emergencyPublishArticleAction",
    "unpublishArticleAction",
  ]) {
    assert.match(actions, new RegExp(`export async function ${actionName}\\b`, "u"));
  }
  assert.doesNotMatch(editor, /Publication state|name="status"/u);
  assert.match(editor, /name="expectedWorkingRevisionNumber"/u);
  assert.match(editor, /Your local changes and staged images are still here|Reload latest/u);
  assert.match(editPage, /getArticleWorkingHead/u);
  assert.match(editPage, /ArticlePreviewManagement/u);
  assert.match(editPage, /getCategoryAuthoringRepository/u);
  assert.match(newPage, /getCategoryAuthoringRepository/u);
  assert.doesNotMatch(`${editPage}\n${newPage}`, /repository\.listCategories/u);
});
