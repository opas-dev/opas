// ABOUTME: Verifies strict parsing for category and article administration requests.
// ABOUTME: Keeps invalid slugs, oversized content, and forged fields outside repository writes.
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseArticleRequest,
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

test("article requests normalize checkbox and publication fields", () => {
  const result = parseArticleRequest(
    formData({
      mode: "update",
      id: "article_1",
      categoryId: "category_1",
      title: "  Reset a password  ",
      slug: "reset-a-password",
      mdx: "# Reset a password\n\nFollow these steps.",
      status: "published",
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
      categoryId: "category_1",
      title: "Reset a password",
      slug: "reset-a-password",
      mdx: "# Reset a password\n\nFollow these steps.",
      status: "published",
      isFaq: true,
      authorName: "OPAS",
      assetManifestId: "asset_manifest_123e4567-e89b-42d3-a456-426614174000",
    },
  });
});

test("article requests accept only server-issued asset manifest ids", () => {
  const result = parseArticleRequest(
    formData({
      mode: "create",
      categoryId: "category_1",
      title: "Reset a password",
      slug: "reset-a-password",
      mdx: "# Reset a password",
      status: "draft",
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
      status: "draft",
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
    status: "draft",
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
      status: "draft",
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
      status: "draft",
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
