// ABOUTME: Verifies the bounded HTTP contracts for staging and discarding article image assets.
// ABOUTME: Covers exact request shapes, byte limits, manifest ownership tokens, and hash paths.
import assert from "node:assert/strict";
import test from "node:test";

import { isAssetHash } from "../src/assets/identity";
import {
  AssetRequestError,
  maximumAssetRequestBytes,
  readAssetDiscardRequest,
  readAssetStageRequest,
} from "../src/assets/requests";
import { publishedAssetResponse } from "../src/assets/responses";

const manifestId = "asset_manifest_123e4567-e89b-42d3-a456-426614174000";
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("prevents revocable published assets from entering browser or CDN caches", () => {
  const response = publishedAssetResponse(
    new Request(`https://opas.dev/api/assets/${"a".repeat(64)}`),
    {
      byteSize: png.byteLength,
      content: png,
      createdAt: new Date("2026-09-03T00:00:00.000Z"),
      hash: "a".repeat(64),
      mediaType: "image/png",
      workspaceId: "workspace_demo",
    },
  );

  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("vercel-cdn-cache-control"), "no-store");
});

function stageRequest(formData: FormData, contentLength?: number) {
  const request = new Request("https://opas.dev/admin/content/assets", {
    method: "POST",
    body: formData,
  });
  if (contentLength === undefined) {
    return request;
  }

  return new Request(request, {
    headers: { "content-length": String(contentLength) },
  });
}

function imageForm() {
  const formData = new FormData();
  formData.set("file", new File([png], "diagram.png", { type: "image/png" }));
  return formData;
}

async function rejectsRequest(
  operation: Promise<unknown>,
  status: number,
  message: RegExp,
) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof AssetRequestError);
    assert.equal(error.status, status);
    assert.match(error.message, message);
    return true;
  });
}

test("reads one image with an optional reusable manifest", async () => {
  const first = await readAssetStageRequest(stageRequest(imageForm()));
  assert.equal(first.manifestId, undefined);
  assert.equal(first.upload.mediaType, "image/png");
  assert.deepEqual(first.upload.content, png);

  const continuedForm = imageForm();
  continuedForm.set("manifestId", manifestId);
  const continued = await readAssetStageRequest(stageRequest(continuedForm));
  assert.equal(continued.manifestId, manifestId);
});

test("rejects unexpected, duplicate, and non-file upload fields", async () => {
  const extra = imageForm();
  extra.set("workspaceId", "workspace_other");
  await rejectsRequest(readAssetStageRequest(stageRequest(extra)), 400, /exactly one image/);

  const duplicate = imageForm();
  duplicate.append("file", new File([png], "second.png", { type: "image/png" }));
  await rejectsRequest(readAssetStageRequest(stageRequest(duplicate)), 400, /exactly one image/);

  const text = new FormData();
  text.set("file", "not a file");
  await rejectsRequest(readAssetStageRequest(stageRequest(text)), 400, /Choose an image/);
});

test("rejects invalid manifests and request or file sizes above the fixed limit", async () => {
  const invalidManifest = imageForm();
  invalidManifest.set("manifestId", "asset_manifest_other-workspace");
  await rejectsRequest(
    readAssetStageRequest(stageRequest(invalidManifest)),
    400,
    /manifest is invalid/,
  );

  await rejectsRequest(
    readAssetStageRequest(stageRequest(imageForm(), maximumAssetRequestBytes + 1)),
    413,
    /1 MiB/,
  );

  const oversized = new FormData();
  oversized.set(
    "file",
    new File([new Uint8Array(1024 * 1024 + 1)], "large.png", { type: "image/png" }),
  );
  await rejectsRequest(readAssetStageRequest(stageRequest(oversized)), 413, /1 MiB/);
});

test("reads only the exact discard document", async () => {
  assert.equal(
    await readAssetDiscardRequest(
      new Request("https://opas.dev/admin/content/assets", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manifestId }),
      }),
    ),
    manifestId,
  );

  await rejectsRequest(
    readAssetDiscardRequest(
      new Request("https://opas.dev/admin/content/assets", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manifestId, workspaceId: "workspace_other" }),
      }),
    ),
    400,
    /discard request is invalid/,
  );
});

test("accepts only lowercase SHA-256 asset path segments", () => {
  assert.equal(isAssetHash("a".repeat(64)), true);
  assert.equal(isAssetHash("A".repeat(64)), false);
  assert.equal(isAssetHash("a".repeat(63)), false);
  assert.equal(isAssetHash(`${"a".repeat(64)}.png`), false);
});
