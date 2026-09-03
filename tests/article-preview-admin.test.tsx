// ABOUTME: Verifies capability-facing preview actions and the one-time sharing control.
// ABOUTME: Covers exact forms, paused creation, paused revocation, fragment URLs, and disclosure.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import {
  runCreateArticlePreviewAction,
  runRevokeArticlePreviewAction,
  type ArticlePreviewActionDependencies,
} from "@/app/admin/content/article-preview-action-runtime";
import {
  ArticlePreviewControls,
  ArticlePreviewLink,
} from "@/app/admin/content/article-preview-controls";
import type {
  ActiveArticlePreviewGrant,
  ArticlePreviewAsset,
  ArticlePreviewRepository,
  ArticlePreviewRevision,
} from "@/auth/article-preview";
import { createArticlePreviewGrantId } from "@/auth/preview-claims";
import { AuthoringPausedError } from "@/db/authoring-controls";

const now = new Date("2026-09-03T12:00:00.000Z");
const configuration = Object.freeze({
  deploymentId: "docs.example.test",
  signingSecret: "preview-admin-signing-secret-with-at-least-32-bytes",
});
const actor = Object.freeze({
  memberId: "member_preview_editor",
  sessionId: "session_preview_editor",
  workspaceId: "workspace_preview",
});

function fixedBytes(offset = 0) {
  return (length: number) =>
    Uint8Array.from({ length }, (_unused, index) => (index + offset) & 0xff);
}

function grant(
  overrides: Partial<ActiveArticlePreviewGrant> = {},
): ActiveArticlePreviewGrant {
  return Object.freeze({
    articleId: "article_preview",
    createdAt: now,
    createdByMemberId: actor.memberId,
    expiresAt: new Date("2026-09-10T12:00:00.000Z"),
    grantId: createArticlePreviewGrantId(fixedBytes()),
    revisionId: "revision_preview_4",
    workspaceId: actor.workspaceId,
    ...overrides,
  });
}

function revision(record: ActiveArticlePreviewGrant): ArticlePreviewRevision {
  return Object.freeze({
    ...record,
    assetHashes: [],
    authorName: "Editor",
    categoryName: "Guides",
    categorySlug: "guides",
    isFaq: false,
    mdx: "# Preview\n\n![Remote](https://images.example.test/guide.png)",
    position: 4,
    revisionNumber: 4,
    revisionSavedAt: now,
    slug: "preview",
    title: "Preview",
  });
}

function repositoryHarness() {
  let active: ActiveArticlePreviewGrant | null = null;
  let paused = false;
  let revisionReadable = true;
  const rotations: unknown[] = [];
  const repository: ArticlePreviewRepository = {
    async findActiveGrant(request) {
      return active?.grantId === request.grantId &&
        active.workspaceId === request.workspaceId &&
        active.revisionId === request.revisionId
        ? active
        : null;
    },
    async readActiveAsset() {
      return null as ArticlePreviewAsset | null;
    },
    async readActiveRevision(request) {
      const record = await repository.findActiveGrant(request);
      return record && revisionReadable ? revision(record) : null;
    },
    async revokeGrant(request) {
      if (!active || active.grantId !== request.grantId) {
        return { code: "GRANT_NOT_FOUND", outcome: "rejected" };
      }
      active = null;
      return { outcome: "revoked" };
    },
    async rotateGrant(request) {
      if (paused) throw new AuthoringPausedError();
      rotations.push(request);
      active = grant({
        createdAt: request.createdAt,
        createdByMemberId: request.actor.memberId,
        expiresAt: request.expiresAt,
        grantId: request.grantId,
        revisionId: request.revisionId,
        workspaceId: request.actor.workspaceId,
      });
      return { outcome: "issued" };
    },
  };
  return {
    hasActiveGrant() {
      return active !== null;
    },
    pause() {
      paused = true;
    },
    rejectRevisionRead() {
      revisionReadable = false;
    },
    repository,
    rotations,
  };
}

function dependencies(
  repository: ArticlePreviewRepository,
): ArticlePreviewActionDependencies {
  return {
    actor,
    clock: () => now,
    configuration,
    randomBytes: fixedBytes(),
    repository,
    siteOrigin: "https://docs.example.test",
  };
}

test("preview creation returns one exact fragment link with external-host disclosure", async () => {
  const harness = repositoryHarness();
  const form = new FormData();
  form.set("revisionId", "revision_preview_4");
  const result = await runCreateArticlePreviewAction(
    form,
    dependencies(harness.repository),
  );

  assert.equal(result.status, "success");
  assert.ok(result.link);
  const url = new URL(result.link.url);
  assert.equal(url.origin, "https://docs.example.test");
  assert.equal(url.pathname, "/preview");
  assert.equal(url.search, "");
  assert.ok(url.hash.length > 1);
  assert.equal(result.link.revisionId, "revision_preview_4");
  assert.deepEqual(result.link.externalImageHosts, ["images.example.test"]);
  assert.equal(JSON.stringify(harness.rotations).includes(url.hash.slice(1)), false);
});

test("invalid forms and a paused authoring fence return no preview link", async () => {
  const harness = repositoryHarness();
  const invalid = new FormData();
  invalid.set("revisionId", "../revision");
  assert.equal(
    (await runCreateArticlePreviewAction(invalid, dependencies(harness.repository)))
      .status,
    "error",
  );
  assert.equal(harness.rotations.length, 0);

  const extra = new FormData();
  extra.set("revisionId", "revision_preview_4");
  extra.set("unexpected", "value");
  assert.equal(
    (await runCreateArticlePreviewAction(extra, dependencies(harness.repository)))
      .status,
    "error",
  );
  assert.equal(harness.rotations.length, 0);

  const invalidOrigin = new FormData();
  invalidOrigin.set("revisionId", "revision_preview_4");
  assert.equal(
    (
      await runCreateArticlePreviewAction(invalidOrigin, {
        ...dependencies(harness.repository),
        siteOrigin: "https://docs.example.test/path",
      })
    ).status,
    "error",
  );
  assert.equal(harness.rotations.length, 0);

  harness.pause();
  const valid = new FormData();
  valid.set("revisionId", "revision_preview_4");
  const paused = await runCreateArticlePreviewAction(
    valid,
    dependencies(harness.repository),
  );
  assert.deepEqual(paused, {
    message: "Authoring is temporarily paused for maintenance. Try again after it resumes.",
    status: "error",
  });
  assert.equal("link" in paused, false);
});

test("revocation remains available while preview creation is paused", async () => {
  const harness = repositoryHarness();
  const create = new FormData();
  create.set("revisionId", "revision_preview_4");
  const issued = await runCreateArticlePreviewAction(
    create,
    dependencies(harness.repository),
  );
  assert.ok(issued.link);
  harness.pause();

  const revoke = new FormData();
  revoke.set("grantId", issued.link.grantId);
  assert.deepEqual(
    await runRevokeArticlePreviewAction(revoke, dependencies(harness.repository)),
    { message: "Preview link revoked.", status: "success" },
  );
  assert.deepEqual(
    await runRevokeArticlePreviewAction(revoke, dependencies(harness.repository)),
    { message: "That preview is already unavailable.", status: "error" },
  );
});

test("a post-issue failure revokes the unshared grant and returns no bearer", async () => {
  const harness = repositoryHarness();
  harness.rejectRevisionRead();
  const create = new FormData();
  create.set("revisionId", "revision_preview_4");
  const result = await runCreateArticlePreviewAction(
    create,
    dependencies(harness.repository),
  );
  assert.deepEqual(result, {
    message: "Another preview replaced this link. Create a fresh link to share.",
    status: "error",
  });
  assert.equal(harness.hasActiveGrant(), false);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /eyJhbGciOi/u);
});

test("the sharing UI explains rotation, expiry, and remote image privacy", () => {
  const createPreview = async () => ({ message: "created", status: "success" as const });
  const revokePreview = async () => ({ message: "revoked", status: "success" as const });
  const controls = renderToStaticMarkup(
    <ArticlePreviewControls
      createPreview={createPreview}
      revisionId="revision_preview_4"
      revisionNumber={4}
      revokePreview={revokePreview}
    />,
  );
  assert.match(controls, /Share revision 4/u);
  assert.match(controls, /expires after seven days/u);
  assert.match(controls, /immediately replaces the previous one/u);

  const link = renderToStaticMarkup(
    <ArticlePreviewLink
      link={{
        expiresAt: "2026-09-10T12:00:00.000Z",
        externalImageHosts: ["images.example.test"],
        grantId: "grant_preview",
        revisionId: "revision_preview_4",
        url: "https://docs.example.test/preview#signed-canary",
      }}
    />,
  );
  assert.match(link, /Visible once/u);
  assert.match(link, /images\.example\.test/u);
  assert.match(link, /viewer’s IP address and request timing/u);
  assert.match(link, /Copy link/u);
});

test("management entry points require preview capability and keep links transient", () => {
  const actions = readFileSync(
    path.join(
      process.cwd(),
      "src/app/admin/content/article-preview-actions.ts",
    ),
    "utf8",
  );
  assert.match(actions, /requireMemberCapability\("preview:manage"/u);

  const controls = readFileSync(
    path.join(
      process.cwd(),
      "src/app/admin/content/article-preview-controls.tsx",
    ),
    "utf8",
  );
  assert.doesNotMatch(
    controls,
    /localStorage|sessionStorage|indexedDB|console\.|document\.cookie/u,
  );
});
