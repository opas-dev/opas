// ABOUTME: Verifies editor manifest state across validation, persistence failure, cleanup uncertainty, and save.
// ABOUTME: Prevents a discarded staging token from being silently reused on the next article save.
import assert from "node:assert/strict";
import test from "node:test";

import {
  articleAssetManifestNeedsReset,
  failedArticleAssetManifestStatus,
} from "../src/app/admin/content/article-asset-state";

const manifestId = "asset_manifest_123e4567-e89b-42d3-a456-426614174000";

test("keeps staged images available after failures that happen before persistence", () => {
  assert.equal(failedArticleAssetManifestStatus(undefined, new Error("validation")), undefined);
  assert.equal(
    articleAssetManifestNeedsReset({ status: "error", revision: 1 }),
    false,
  );
});

test("clears a manifest after repository cleanup or uncertain cleanup", () => {
  assert.equal(
    failedArticleAssetManifestStatus(manifestId, new Error("constraint")),
    "discarded",
  );
  assert.equal(
    failedArticleAssetManifestStatus(
      manifestId,
      new AggregateError([new Error("constraint"), new Error("cleanup")]),
    ),
    "uncertain",
  );

  for (const assetManifestStatus of ["discarded", "uncertain"] as const) {
    assert.equal(
      articleAssetManifestNeedsReset({
        status: "error",
        revision: 1,
        assetManifestStatus,
      }),
      true,
    );
  }
});

test("clears a consumed manifest after save but not in the initial idle state", () => {
  assert.equal(articleAssetManifestNeedsReset({ status: "idle", revision: 0 }), false);
  assert.equal(articleAssetManifestNeedsReset({ status: "success", revision: 1 }), true);
});
