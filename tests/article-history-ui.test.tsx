// ABOUTME: Verifies task filters, safe diffs, and confirmed article recovery controls.
// ABOUTME: Covers typed action dispatch, evidence scheduling, exact fields, and escaped source.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import {
  articleLibraryCounts,
  articleMatchesLibraryFilter,
  articleNextAction,
  resolveArticleLibraryFilter,
} from "@/app/admin/content/article-library";
import type {
  ArticleRecoveryAction,
  ArticleRecoverySnapshot,
} from "@/app/admin/content/article-recovery-contracts";
import {
  ArticleLifecycleControls,
  RestoreRevisionControl,
} from "@/app/admin/content/article-recovery-controls";
import {
  runArticleRecoveryAction,
  type ArticleRecoveryDependencies,
} from "@/app/admin/content/article-recovery-runtime";
import {
  ArticleSourceDiff,
  compareArticleSource,
} from "@/app/admin/content/article-revision-diff";
import type {
  ArticleLibraryItem,
  ArticleWorkflowResult,
} from "@/db/article-drafts";

const actor = Object.freeze({ memberId: "member_editor", sessionId: "session_editor" });

function libraryItem(overrides: Partial<ArticleLibraryItem> = {}): ArticleLibraryItem {
  return {
    archivedAt: null,
    articleId: "article_one",
    categoryId: "category_guides",
    categoryName: "Guides",
    categorySlug: "guides",
    createdByMemberId: actor.memberId,
    publicStatus: "draft",
    publishedRevisionId: null,
    publishedRevisionNumber: null,
    reviewState: "editing",
    slug: "first-answer",
    submittedByMemberId: null,
    title: "First answer",
    updatedAt: new Date("2026-09-03T12:00:00.000Z"),
    workingRevisionId: "revision_one_2",
    workingRevisionNumber: 2,
    ...overrides,
  };
}

function recoveryForm(overrides: Record<string, string> = {}) {
  const formData = new FormData();
  const values = {
    id: "article_one",
    revisionId: "revision_one_4",
    expectedWorkingRevisionNumber: "4",
    expectedReviewState: "editing",
    expectedPublicStatus: "published",
    confirmation: "on",
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) formData.set(name, value);
  return formData;
}

function transitioned(
  overrides: Partial<Extract<ArticleWorkflowResult, { status: "transitioned" }>> = {},
): Extract<ArticleWorkflowResult, { status: "transitioned" }> {
  return {
    status: "transitioned",
    action: "archived",
    articleId: "article_one",
    eventId: "event_one",
    publicStatus: "draft",
    reviewState: "editing",
    revisionId: "revision_one_4",
    revisionNumber: 4,
    ...overrides,
  };
}

function recoveryHarness() {
  const calls: Array<{ method: string; request: unknown }> = [];
  let result: ArticleWorkflowResult = transitioned();
  const repository: ArticleRecoveryDependencies["repository"] = {
    async archiveArticle(request) {
      calls.push({ method: "archiveArticle", request });
      return result;
    },
    async restoreArchivedArticle(request) {
      calls.push({ method: "restoreArchivedArticle", request });
      return result;
    },
    async restoreRevisionAsDraft(request) {
      calls.push({ method: "restoreRevisionAsDraft", request });
      return result;
    },
  };
  return {
    calls,
    repository,
    setResult(next: ArticleWorkflowResult) {
      result = next;
    },
  };
}

function dependencies(
  repository: ArticleRecoveryDependencies["repository"],
  overrides: Partial<ArticleRecoveryDependencies> = {},
): ArticleRecoveryDependencies {
  return {
    actor,
    repository,
    workspaceId: "workspace_one",
    ...overrides,
  };
}

test("article library filters keep working, live, review, and archive state independent", () => {
  const publishedWithDraft = libraryItem({
    articleId: "article_published",
    publicStatus: "published",
    publishedRevisionId: "revision_published_3",
    publishedRevisionNumber: 3,
    workingRevisionId: "revision_published_5",
    workingRevisionNumber: 5,
  });
  const needsReview = libraryItem({
    articleId: "article_review",
    reviewState: "in_review",
    submittedByMemberId: "member_submitter",
    createdByMemberId: "member_author",
  });
  const archived = libraryItem({
    articleId: "article_archived",
    archivedAt: new Date("2026-09-03T13:00:00.000Z"),
  });
  const items = [publishedWithDraft, needsReview, archived];

  assert.deepEqual(articleLibraryCounts(items), {
    "needs-review": 1,
    drafts: 2,
    published: 1,
    archived: 1,
  });
  assert.equal(articleMatchesLibraryFilter(publishedWithDraft, "published"), true);
  assert.equal(articleMatchesLibraryFilter(publishedWithDraft, "drafts"), true);
  assert.equal(resolveArticleLibraryFilter(undefined, "reviewer"), "needs-review");
  assert.equal(resolveArticleLibraryFilter("forged", "editor"), "drafts");
  assert.equal(
    articleNextAction(needsReview, { memberId: "member_reviewer", role: "reviewer" }),
    "Review revision 2",
  );
  assert.equal(
    articleNextAction(needsReview, { memberId: "member_submitter", role: "administrator" }),
    "Waiting for another reviewer",
  );
  assert.equal(
    articleNextAction(archived, { memberId: actor.memberId, role: "editor" }),
    "Restore private draft",
  );
});

test("recovery actions require confirmation and schedule evidence only for a committed public change", async () => {
  const harness = recoveryHarness();
  let revalidations = 0;
  let schedules = 0;
  harness.setResult(transitioned({ evidenceJobId: "job_archive" }));
  const archived = await runArticleRecoveryAction(
    "archive",
    recoveryForm({ note: "  Superseded answer.  " }),
    dependencies(harness.repository, {
      revalidateContent: () => revalidations += 1,
      scheduleEvidenceRecovery: () => schedules += 1,
    }),
  );
  assert.equal(archived.status, "success");
  assert.deepEqual(harness.calls[0], {
    method: "archiveArticle",
    request: {
      actor,
      articleId: "article_one",
      expectedPublicStatus: "published",
      expectedReviewState: "editing",
      expectedWorkingRevisionNumber: 4,
      revisionId: "revision_one_4",
      note: "Superseded answer.",
      workspaceId: "workspace_one",
    },
  });
  assert.equal(schedules, 1);
  assert.equal(revalidations, 1);

  harness.setResult(transitioned({ action: "restored", revisionNumber: 5 }));
  const restored = await runArticleRecoveryAction(
    "restoreRevision",
    recoveryForm({
      sourceRevisionId: "revision_one_2",
      sourceRevisionNumber: "2",
      note: "Bring back the verified steps.",
    }),
    dependencies(harness.repository, {
      revalidateContent: () => revalidations += 1,
      scheduleEvidenceRecovery: () => schedules += 1,
    }),
  );
  assert.equal(restored.status, "error");
  assert.equal(harness.calls.length, 1);

  const revisionForm = new FormData();
  for (const [name, value] of Object.entries({
    id: "article_one",
    revisionId: "revision_one_4",
    expectedWorkingRevisionNumber: "4",
    expectedReviewState: "editing",
    sourceRevisionId: "revision_one_2",
    sourceRevisionNumber: "2",
    confirmation: "on",
    note: "Bring back the verified steps.",
  })) revisionForm.set(name, value);
  const restoredRevision = await runArticleRecoveryAction(
    "restoreRevision",
    revisionForm,
    dependencies(harness.repository, {
      revalidateContent: () => revalidations += 1,
      scheduleEvidenceRecovery: () => schedules += 1,
    }),
  );
  assert.equal(restoredRevision.status, "success");
  assert.equal(harness.calls[1]?.method, "restoreRevisionAsDraft");
  assert.equal(schedules, 1);
  assert.equal(revalidations, 2);

  const unconfirmed = recoveryForm();
  unconfirmed.delete("confirmation");
  assert.equal(
    (await runArticleRecoveryAction(
      "archive",
      unconfirmed,
      dependencies(harness.repository),
    )).status,
    "error",
  );
  assert.equal(harness.calls.length, 2);
});

test("recovery conflicts keep typed current revision details and do not revalidate", async () => {
  const harness = recoveryHarness();
  let revalidations = 0;
  harness.setResult({
    status: "conflict",
    code: "STALE_REVISION",
    currentReviewState: "in_review",
    currentRevisionNumber: 7,
  });
  const result = await runArticleRecoveryAction(
    "archive",
    recoveryForm(),
    dependencies(harness.repository, { revalidateContent: () => revalidations += 1 }),
  );
  assert.deepEqual(result, {
    status: "error",
    message: "The working revision changed before this action completed. Revision 7 is now current.",
    code: "STALE_REVISION",
    currentReviewState: "in_review",
    currentRevisionNumber: 7,
  });
  assert.equal(revalidations, 0);
});

test("source comparison aligns edits and React escapes author-controlled lines", () => {
  assert.deepEqual(compareArticleSource("one\ntwo\nthree", "one\nTWO\nplus\nthree"), [
    { kind: "unchanged", beforeLineNumber: 1, afterLineNumber: 1, text: "one" },
    {
      kind: "changed",
      beforeLineNumber: 2,
      afterLineNumber: 2,
      beforeText: "two",
      afterText: "TWO",
    },
    { kind: "added", afterLineNumber: 3, text: "plus" },
    { kind: "unchanged", beforeLineNumber: 3, afterLineNumber: 4, text: "three" },
  ]);
  const markup = renderToStaticMarkup(
    <ArticleSourceDiff before="safe" after={'<img src=x onerror="alert(1)">'} />,
  );
  assert.match(markup, /± Changed/u);
  assert.match(markup, /Before:/u);
  assert.match(markup, /After:/u);
  assert.match(markup, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/u);
  assert.doesNotMatch(markup, /<img src=x/u);
});

test("archive and restore controls disclose effects and carry exact revision fields", () => {
  const action: ArticleRecoveryAction = async () => ({ status: "success", message: "done" });
  const snapshot: ArticleRecoverySnapshot = {
    articleId: "article_one",
    publicStatus: "published",
    reviewState: "editing",
    revisionId: "revision_one_4",
    revisionNumber: 4,
  };
  const archiveMarkup = renderToStaticMarkup(
    <ArticleLifecycleControls
      archiveAction={action}
      canArchive
      canRestoreArchived={false}
      isArchived={false}
      restoreArchivedAction={action}
      snapshot={snapshot}
    />,
  );
  assert.match(archiveMarkup, /Archive article/u);
  assert.match(archiveMarkup, /removes every public surface/u);
  assert.match(archiveMarkup, /name="revisionId" value="revision_one_4"/u);
  assert.match(archiveMarkup, /name="expectedWorkingRevisionNumber" value="4"/u);
  assert.match(archiveMarkup, /name="expectedPublicStatus" value="published"/u);

  const restoreMarkup = renderToStaticMarkup(
    <RestoreRevisionControl
      action={action}
      canRestore
      current={snapshot}
      isArchived={false}
      sourceRevisionId="revision_one_2"
      sourceRevisionNumber={2}
    />,
  );
  assert.match(restoreMarkup, /creates private revision 5 and does not change the live answer/u);
  assert.match(restoreMarkup, /name="sourceRevisionId" value="revision_one_2"/u);
  assert.match(restoreMarkup, /aria-live="polite"/u);
});

test("content and history routes use authorized revisions and conflict-safe navigation", async () => {
  const [contentPage, editor, articlePage, historyPage, detailPage] = await Promise.all([
    readFile(new URL("../src/app/admin/content/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/admin/content/article-editor.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../src/app/admin/content/articles/[id]/page.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/app/admin/content/articles/[id]/history/page.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../src/app/admin/content/articles/[id]/history/[revisionNumber]/[revisionId]/page.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  assert.match(contentPage, /listArticleLibrary/u);
  assert.doesNotMatch(contentPage, /repository\.listArticles/u);
  for (const filter of ["needs-review", "drafts", "published", "archived"]) {
    assert.match(contentPage, new RegExp(filter, "u"));
  }
  assert.match(articlePage, /ArticleLifecycleControls/u);
  assert.match(historyPage, /listArticleRevisionHistory/u);
  assert.match(detailPage, /getArticleRevisionDetail/u);
  assert.match(detailPage, /ArticleSourceDiff/u);
  assert.match(editor, /Compare with revision/u);
  assert.match(editor, /target="_blank"/u);
});
