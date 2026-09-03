// ABOUTME: Verifies strict parsing for category and article administration requests.
// ABOUTME: Keeps invalid slugs, oversized content, and forged fields outside repository writes.
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseArticleRequest,
  parseArticleWorkflowRequest,
  parseCategoryDeleteRequest,
  parseCategoryRequest,
  parseRecordRequest,
} from "@/app/admin/content/validation";

function formData(values: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    data.set(name, value);
  }
  return data;
}

test("category requests normalize trusted values", () => {
  const result = parseCategoryRequest(
    formData({
      mode: "create",
      name: "  Account setup  ",
      slug: "account-setup",
      description: "  Start here.  ",
      position: "2",
    }),
  );

  assert.deepEqual(result, {
    success: true,
    data: {
      mode: "create",
      name: "Account setup",
      slug: "account-setup",
      description: "Start here.",
      position: 2,
    },
  });
});

test("category updates require an opaque record id", () => {
  const result = parseCategoryRequest(
    formData({
      mode: "update",
      expectedCategoryVersion: "1",
      name: "Account setup",
      slug: "account-setup",
      description: "",
      position: "0",
    }),
  );

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.fieldErrors.id, "Invalid input: expected string, received undefined");
  }
});

test("categories cannot claim static application routes", () => {
  for (const slug of ["admin", "api", "spike"]) {
    const result = parseCategoryRequest(
      formData({
        mode: "create",
        name: "Reserved category",
        slug,
        description: "",
        position: "0",
      }),
    );

    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.fieldErrors.slug, "This URL slug is reserved by the application");
    }
  }
});

test("category updates and deletes require a positive concurrency version", () => {
  const update = parseCategoryRequest(
    formData({
      mode: "update",
      id: "category_1",
      expectedCategoryVersion: "0",
      name: "Account setup",
      slug: "account-setup",
      description: "",
      position: "0",
    }),
  );
  assert.equal(update.success, false);
  if (!update.success) {
    assert.equal(update.fieldErrors.expectedCategoryVersion, "The category version is invalid");
  }

  assert.deepEqual(
    parseCategoryDeleteRequest(
      formData({ id: "category_1", expectedCategoryVersion: "7" }),
    ),
    {
      success: true,
      data: { id: "category_1", expectedCategoryVersion: 7 },
    },
  );
});

test("article requests normalize checkbox fields and require a saved revision on updates", () => {
  const result = parseArticleRequest(
    formData({
      mode: "update",
      id: "article_1",
      expectedWorkingRevisionNumber: "7",
      categoryId: "category_1",
      title: "  Reset a password  ",
      slug: "reset-a-password",
      mdx: "# Reset a password\n\nFollow these steps.",
      isFaq: "on",
      authorName: "  OPAS  ",
      assetManifestId: "asset_manifest_123e4567-e89b-42d3-a456-426614174000",
    }),
  );

  assert.deepEqual(result, {
    success: true,
    data: {
      mode: "update",
      id: "article_1",
      expectedWorkingRevisionNumber: 7,
      categoryId: "category_1",
      title: "Reset a password",
      slug: "reset-a-password",
      mdx: "# Reset a password\n\nFollow these steps.",
      isFaq: true,
      authorName: "OPAS",
      assetManifestId: "asset_manifest_123e4567-e89b-42d3-a456-426614174000",
    },
  });

  const missingRevision = parseArticleRequest(
    formData({
      mode: "update",
      id: "article_1",
      categoryId: "category_1",
      title: "Reset a password",
      slug: "reset-a-password",
      mdx: "# Reset a password",
      authorName: "OPAS",
    }),
  );
  assert.equal(missingRevision.success, false);
  if (!missingRevision.success) {
    assert.ok(missingRevision.fieldErrors.expectedWorkingRevisionNumber);
  }
});

test("article requests accept only server-issued asset manifest ids", () => {
  const result = parseArticleRequest(
    formData({
      mode: "create",
      categoryId: "category_1",
      title: "Reset a password",
      slug: "reset-a-password",
      mdx: "# Reset a password",
      authorName: "OPAS",
      assetManifestId: "asset_manifest_other-workspace",
    }),
  );

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.fieldErrors.assetManifestId, "The asset manifest is invalid");
  }
});

test("article requests reject unsafe slugs and forged fields", () => {
  const unsafeSlug = parseArticleRequest(
    formData({
      mode: "create",
      categoryId: "category_1",
      title: "Reset a password",
      slug: "Reset Password",
      mdx: "# Reset a password",
      authorName: "OPAS",
    }),
  );
  assert.equal(unsafeSlug.success, false);
  if (!unsafeSlug.success) {
    assert.equal(
      unsafeSlug.fieldErrors.slug,
      "Use lowercase letters, numbers, and single hyphens only",
    );
  }

  const forged = formData({
    mode: "create",
    categoryId: "category_1",
    title: "Reset a password",
    slug: "reset-a-password",
    mdx: "# Reset a password",
    authorName: "OPAS",
    workspaceId: "workspace_other",
  });
  const forgedResult = parseArticleRequest(forged);
  assert.equal(forgedResult.success, false);
  if (!forgedResult.success) {
    assert.equal(forgedResult.fieldErrors.form, "The request contained unexpected fields.");
  }
});

test("article MDX begins with the canonical database title", () => {
  const result = parseArticleRequest(
    formData({
      mode: "create",
      categoryId: "category_1",
      title: "Reset a password",
      slug: "reset-a-password",
      mdx: "# Recover an account\n\nFollow these steps.",
      authorName: "OPAS",
    }),
  );

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(
      result.fieldErrors.mdx,
      "The level-one heading must exactly match the article title",
    );
  }
});

test("article requests reject a second level-one heading before reaching persistence", () => {
  const result = parseArticleRequest(
    formData({
      mode: "create",
      categoryId: "category_1",
      title: "Reset a password",
      slug: "reset-a-password",
      mdx: "# Reset a password\n\nFollow these steps.\n\n# Contact support",
      authorName: "OPAS",
    }),
  );

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(
      result.fieldErrors.mdx,
      "Article MDX must contain exactly one level-one heading",
    );
  }
});

test("workflow requests strictly parse exact revision identity, state, and bounded notes", () => {
  assert.deepEqual(
    parseArticleWorkflowRequest(
      "requestChanges",
      formData({
        id: "article_1",
        revisionId: "revision_7",
        expectedWorkingRevisionNumber: "7",
        expectedReviewState: "in_review",
        note: "  Clarify the recovery step.  ",
      }),
    ),
    {
      success: true,
      data: {
        id: "article_1",
        revisionId: "revision_7",
        expectedWorkingRevisionNumber: 7,
        expectedReviewState: "in_review",
        note: "Clarify the recovery step.",
      },
    },
  );

  for (const invalid of [
    formData({
      id: "article_1",
      revisionId: "../revision_7",
      expectedWorkingRevisionNumber: "7",
      expectedReviewState: "in_review",
      note: "Clarify the recovery step.",
    }),
    formData({
      id: "article_1",
      revisionId: "revision_7",
      expectedWorkingRevisionNumber: "0",
      expectedReviewState: "in_review",
      note: "Clarify the recovery step.",
    }),
    formData({
      id: "article_1",
      revisionId: "revision_7",
      expectedWorkingRevisionNumber: "7",
      expectedReviewState: "approved",
      note: "Clarify the recovery step.",
    }),
  ]) {
    assert.equal(parseArticleWorkflowRequest("requestChanges", invalid).success, false);
  }
});

test("emergency publication requires a reason and rejects forged form fields", () => {
  const missingReason = parseArticleWorkflowRequest(
    "emergencyPublish",
    formData({
      id: "article_1",
      revisionId: "revision_7",
      expectedWorkingRevisionNumber: "7",
      expectedReviewState: "editing",
      reason: "   ",
    }),
  );
  assert.equal(missingReason.success, false);
  if (!missingReason.success) {
    assert.equal(missingReason.fieldErrors.reason, "Enter a reason before continuing");
  }

  const forged = formData({
    id: "article_1",
    revisionId: "revision_7",
    expectedWorkingRevisionNumber: "7",
    expectedReviewState: "editing",
    reason: "Urgent correction",
    workspaceId: "workspace_other",
  });
  const result = parseArticleWorkflowRequest("emergencyPublish", forged);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.fieldErrors.form, "The request contained unexpected fields.");
  }
});

test("framework action fields are ignored while delete requests stay strict", () => {
  const allowed = formData({ id: "article_1", "$ACTION_ID_hash": "opaque" });
  assert.deepEqual(parseRecordRequest(allowed), {
    success: true,
    data: { id: "article_1" },
  });

  const forged = formData({ id: "article_1", workspaceId: "workspace_other" });
  const result = parseRecordRequest(forged);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.fieldErrors.form, "The request contained unexpected fields.");
  }
});
