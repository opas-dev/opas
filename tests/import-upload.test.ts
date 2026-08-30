// ABOUTME: Verifies portable request limits for Markdown and ZIP knowledge uploads.
// ABOUTME: Rejects missing, unsafe, unsupported, empty, and oversized browser files early.
import assert from "node:assert/strict";
import test from "node:test";

import { archiveLimits } from "@/import/archive";
import {
  ImportUploadError,
  readKnowledgeUpload,
} from "@/import/upload";

test("reads one bounded Markdown upload without changing its portable name", async () => {
  const files = await readKnowledgeUpload(
    new File(["# Install\n"], "cafe\u0301.markdown", { type: "text/markdown" }),
  );

  assert.equal(files.length, 1);
  assert.equal(files[0].path, "caf\u00e9.markdown");
  assert.equal(new TextDecoder().decode(files[0].content), "# Install\n");
});

test("rejects missing, empty, unsafe, and unsupported uploads before planning", async () => {
  const cases: Array<FormDataEntryValue | null> = [
    null,
    "not a file",
    new File([], "empty.md"),
    new File(["# Page"], "../page.md"),
    new File(["# Page"], "page.mdx"),
  ];

  for (const value of cases) {
    await assert.rejects(readKnowledgeUpload(value), ImportUploadError);
  }
});

test("rejects Markdown and ZIP uploads above their cross-target request limits", async () => {
  await assert.rejects(
    readKnowledgeUpload(
      new File([new Uint8Array(archiveLimits.fileBytes + 1)], "large.md"),
    ),
    ImportUploadError,
  );
  await assert.rejects(
    readKnowledgeUpload(
      new File([new Uint8Array(archiveLimits.compressedBytes + 1)], "large.zip"),
    ),
    ImportUploadError,
  );
});
