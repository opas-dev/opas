// ABOUTME: Verifies immutable draft and publication batches in Wrangler's native local D1 runtime.
// ABOUTME: Proves D1 serializes stale heads, reviews, slugs, and evidence to one winner.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const wranglerEntry = path.join(repositoryRoot, "node_modules/wrangler/bin/wrangler.js");
const fixtureConfig = path.join(
  repositoryRoot,
  "tests/fixtures/article-drafts-d1/wrangler.jsonc",
);
const databaseName = "opas-article-drafts-test";

type DraftOutcome = Readonly<{
  status: "saved" | "unchanged" | "conflict" | "rejected";
  code?: string;
  revisionNumber?: number;
}>;

type WorkflowOutcome = Readonly<{
  status: "transitioned" | "conflict" | "rejected";
  action?: string;
  code?: string;
}>;

type ExerciseResult = Readonly<{
  initial: DraftOutcome;
  race: readonly DraftOutcome[];
  second: DraftOutcome;
  unchanged: DraftOutcome;
  invalidRevision: DraftOutcome;
  pausedCode: string | null;
  slugRace: readonly DraftOutcome[];
  revisionCount: number;
  head: { working_revision_number: number; working_slug: string };
  workflow: {
    pausedWorkflowCode: string | null;
    categoryDelete: WorkflowOutcome;
    categorySubmit: WorkflowOutcome;
    submitted: WorkflowOutcome;
    editAfterSubmit: DraftOutcome;
    doubleSubmit: WorkflowOutcome;
    withdrawn: WorkflowOutcome;
    reviewRace: readonly WorkflowOutcome[];
    editedAfterApproval: DraftOutcome;
    stalePublish: WorkflowOutcome;
    selfApproval: WorkflowOutcome;
    categoryPublish: WorkflowOutcome;
    categorySlug: WorkflowOutcome;
    disabledPublish: WorkflowOutcome;
    disabledHead: unknown;
    publishRace: readonly WorkflowOutcome[];
    publishedState: {
      status: string;
      slug: string;
      title: string;
      content_hash: string | null;
      review_state: string;
      working_revision_id: string;
      published_revision_id: string;
      generation: number;
    };
    publishedEvidenceCount: number;
    publishedJobs: readonly { status: string; index_generation: number }[];
    publishedEventCount: number;
    unpublished: WorkflowOutcome;
    beforeFailedPublication: unknown;
    failedPublicationError: string | null;
    afterFailedPublication: unknown;
    emergencyPublished: WorkflowOutcome;
    finalState: {
      status: string;
      review_state: string;
      generation: number;
      evidence_count: number;
      job_count: number;
      pending_job_count: number;
    };
    markedImport: DraftOutcome;
    markedImportState: {
      status: string;
      content_hash: string | null;
      review_state: string;
      published_revision_id: string | null;
      evidence_count: number;
    };
    combinedCreate: DraftOutcome;
    combinedSubmission: WorkflowOutcome;
    combinedBeforeRollback: unknown;
    combinedRollbackError: string | null;
    combinedAfterRollback: unknown;
    combinedPublished: WorkflowOutcome & { approvalEventId?: string };
    combinedEvents: readonly { action: string }[];
  };
}>;

type RecoveryResult = Readonly<{
  archiveRace: readonly WorkflowOutcome[];
  archiveRestoreRace: readonly WorkflowOutcome[];
  archivedLibrary: readonly {
    archivedAt: string | null;
    articleId: string;
    publicStatus: string;
    publishedRevisionNumber: number | null;
    workingRevisionNumber: number;
  }[];
  archivedState: {
    archived_at: number | null;
    content_hash: string | null;
    evidence_count: number;
    revision_count: number;
    revoked_grants: number;
    status: string;
  };
  cappedDetail: {
    events: readonly { action: string }[];
    eventsTruncated: boolean;
  } | null;
  detail: {
    article: { title: string };
    changeKind: string;
    events: readonly { action: string }[];
    restoredFromRevisionId: string | null;
    revisionNumber: number;
  } | null;
  disabledDetail: unknown;
  disabledHistory: unknown;
  disabledLibrary: readonly unknown[];
  doubleRestore: readonly WorkflowOutcome[];
  firstHistory: {
    items: readonly { revisionNumber: number }[];
    nextBeforeRevisionNumber: number | null;
  } | null;
  inReviewRestore: WorkflowOutcome;
  initialLibrary: readonly {
    archivedAt: string | null;
    articleId: string;
    categoryName: string;
    categorySlug: string;
    createdByMemberId: string | null;
    publicStatus: string;
    publishedRevisionNumber: number | null;
    reviewState: string;
    slug: string;
    title: string;
    workingRevisionNumber: number;
  }[];
  missingAssetRestore: WorkflowOutcome;
  missingCategoryRestore: WorkflowOutcome;
  negativeRevisionCounts: readonly {
    article_id: string;
    revision_count: number;
  }[];
  published: WorkflowOutcome;
  priorRevisionsUnchanged: boolean;
  recoveredHead: {
    archivedAt: string | null;
    publicStatus: string;
    reviewState: string;
    revisionNumber: number;
  } | null;
  revokedDetail: unknown;
  revokedHistory: unknown;
  revokedLibrary: readonly unknown[];
  restoreWhileArchived: WorkflowOutcome;
  restoreSlugRace: readonly WorkflowOutcome[];
  restored: WorkflowOutcome;
  roleChangedDetail: unknown;
  roleChangedHistory: unknown;
  roleChangedLibrary: readonly unknown[];
  secondHistory: {
    items: readonly { revisionNumber: number }[];
    nextBeforeRevisionNumber: number | null;
  } | null;
  slugClaimsAfterArchive: readonly {
    article_row_claim: number;
    normalized_slug: string;
    working_claim: number;
  }[];
  slugClaimsBeforeArchive: readonly {
    article_row_claim: number;
    normalized_slug: string;
    working_claim: number;
  }[];
  slugConflictRestore: WorkflowOutcome;
  corruptRestore: WorkflowOutcome;
  unsafeRestore: WorkflowOutcome;
}>;

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function migrate(persistDirectory: string) {
  const result = spawnSync(
    process.execPath,
    [
      wranglerEntry,
      "d1",
      "migrations",
      "apply",
      databaseName,
      "--local",
      "--config",
      fixtureConfig,
      "--persist-to",
      persistDirectory,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    },
  );
  assert.equal(
    result.status,
    0,
    `D1 migration failed.\n${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
}

async function startWorker(persistDirectory: string) {
  const port = await availablePort();
  const child = spawn(
    process.execPath,
    [
      wranglerEntry,
      "dev",
      "--local",
      "--port",
      String(port),
      "--config",
      fixtureConfig,
      "--persist-to",
      persistDirectory,
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      stdio: "pipe",
    },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) assert.fail(`Wrangler exited early.\n${output}`);
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return { child, origin, output: () => output };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGTERM");
  assert.fail(`Wrangler did not become ready.\n${output}`);
}

async function stopWorker(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("native D1 draft and publication batches admit one exact winner", { timeout: 120_000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "opas-article-drafts-d1-"));
  const persistDirectory = path.join(directory, "state");
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    migrate(persistDirectory);
    worker = await startWorker(persistDirectory);
    const setup = await fetch(`${worker.origin}/setup`, { method: "POST" });
    assert.equal(setup.status, 200, `${await setup.text()}\n${worker.output()}`);
    const response = await fetch(`${worker.origin}/exercise`, { method: "POST" });
    const body = (await response.json()) as ExerciseResult & { error?: string };
    assert.equal(response.status, 200, `${body.error ?? "D1 exercise failed"}\n${worker.output()}`);
    assert.equal(body.initial.status, "saved");
    assert.equal(body.race.filter((result) => result.status === "saved").length, 1);
    assert.equal(body.race.filter((result) => result.code === "STALE_REVISION").length, 11);
    assert.equal(body.second.status, "saved");
    assert.equal(body.second.revisionNumber, 3);
    assert.equal(body.unchanged.status, "unchanged");
    assert.deepEqual(body.invalidRevision, {
      status: "rejected",
      code: "INVALID_REVISION_NUMBER",
    });
    assert.equal(body.pausedCode, "AUTHORING_PAUSED");
    assert.equal(body.revisionCount, 3);
    assert.deepEqual(body.head, {
      working_revision_number: 3,
      working_slug: "d1-second",
    });
    assert.equal(body.slugRace.filter((result) => result.status === "saved").length, 1);
    assert.equal(body.slugRace.filter((result) => result.code === "SLUG_CONFLICT").length, 1);

    const { workflow } = body;
    assert.equal(workflow.pausedWorkflowCode, "AUTHORING_PAUSED");
    assert.deepEqual(workflow.categorySubmit, {
      status: "rejected",
      code: "CATEGORY_CHANGED",
    });
    assert.deepEqual(workflow.categoryDelete, {
      status: "rejected",
      code: "CATEGORY_REFERENCED",
    });
    assert.equal(workflow.submitted.status, "transitioned");
    assert.equal(workflow.submitted.action, "submitted");
    assert.deepEqual(workflow.editAfterSubmit, {
      status: "rejected",
      code: "INVALID_REVIEW_STATE",
    });
    assert.equal(workflow.doubleSubmit.status, "conflict");
    assert.equal(workflow.doubleSubmit.code, "INVALID_REVIEW_STATE");
    assert.equal(workflow.withdrawn.status, "transitioned");
    assert.equal(workflow.withdrawn.action, "withdrawn");
    assert.equal(
      workflow.reviewRace.filter((result) => result.status === "transitioned").length,
      1,
    );
    assert.equal(
      workflow.reviewRace.filter((result) => result.status === "conflict").length,
      1,
    );
    assert.equal(workflow.editedAfterApproval.status, "saved");
    assert.equal(workflow.stalePublish.status, "conflict");
    assert.equal(workflow.stalePublish.code, "STALE_REVISION");
    assert.deepEqual(workflow.selfApproval, {
      status: "rejected",
      code: "SELF_APPROVAL_FORBIDDEN",
    });
    assert.deepEqual(workflow.categoryPublish, {
      status: "conflict",
      code: "INVALID_REVIEW_STATE",
      currentRevisionNumber: 5,
      currentReviewState: "changes_requested",
    });
    assert.deepEqual(workflow.categorySlug, {
      status: "rejected",
      code: "LIVE_CATEGORY_SLUG",
    });
    assert.deepEqual(workflow.disabledPublish, {
      status: "rejected",
      code: "ACTOR_FORBIDDEN",
    });
    assert.equal(workflow.disabledHead, null);
    assert.equal(
      workflow.publishRace.filter((result) => result.status === "transitioned").length,
      1,
    );
    assert.equal(
      workflow.publishRace.filter((result) => result.status === "conflict").length,
      1,
    );
    assert.equal(
      workflow.publishRace.find((result) => result.status === "conflict")?.code,
      "INVALID_REVIEW_STATE",
    );
    assert.equal(workflow.publishedState.status, "published");
    assert.equal(workflow.publishedState.slug, "d1-final");
    assert.equal(workflow.publishedState.title, "D1 publish candidate");
    assert.ok(workflow.publishedState.content_hash);
    assert.equal(workflow.publishedState.review_state, "published");
    assert.equal(
      workflow.publishedState.working_revision_id,
      workflow.publishedState.published_revision_id,
    );
    assert.equal(workflow.publishedState.generation, 1);
    assert.ok(workflow.publishedEvidenceCount >= 1);
    assert.deepEqual(workflow.publishedJobs, [
      { status: "pending", index_generation: 1 },
    ]);
    assert.equal(workflow.publishedEventCount, 1);
    assert.equal(workflow.unpublished.status, "transitioned");
    assert.equal(workflow.unpublished.action, "unpublished");
    assert.ok(workflow.failedPublicationError);
    assert.deepEqual(
      workflow.afterFailedPublication,
      workflow.beforeFailedPublication,
    );
    assert.equal(workflow.emergencyPublished.status, "transitioned");
    assert.equal(workflow.emergencyPublished.action, "emergency_published");
    assert.equal(workflow.finalState.status, "published");
    assert.equal(workflow.finalState.review_state, "published");
    assert.equal(workflow.finalState.generation, 3);
    assert.ok(workflow.finalState.evidence_count >= 1);
    assert.equal(workflow.finalState.job_count, 2);
    assert.equal(workflow.finalState.pending_job_count, 1);
    assert.equal(workflow.markedImport.status, "saved");
    assert.deepEqual(workflow.markedImportState, {
      status: "draft",
      content_hash: null,
      review_state: "editing",
      published_revision_id: null,
      evidence_count: 0,
    });
    assert.equal(workflow.combinedCreate.status, "saved");
    assert.equal(workflow.combinedSubmission.status, "transitioned");
    assert.ok(workflow.combinedRollbackError);
    assert.deepEqual(
      workflow.combinedAfterRollback,
      workflow.combinedBeforeRollback,
    );
    assert.equal(workflow.combinedPublished.status, "transitioned");
    assert.ok(workflow.combinedPublished.approvalEventId);
    assert.deepEqual(workflow.combinedEvents.slice(-2), [
      { action: "approved" },
      { action: "published" },
    ]);

    const recoveryResponse = await fetch(`${worker.origin}/recovery`, {
      method: "POST",
    });
    const recovery = (await recoveryResponse.json()) as RecoveryResult & {
      error?: string;
    };
    assert.equal(
      recoveryResponse.status,
      200,
      `${recovery.error ?? "D1 recovery exercise failed"}\n${worker.output()}`,
    );
    assert.equal(recovery.published.status, "transitioned");
    assert.equal(recovery.restored.status, "transitioned");
    assert.equal(recovery.restored.action, "restored");
    assert.equal(recovery.priorRevisionsUnchanged, true);
    const recoveryLibraryItem = recovery.initialLibrary.find(
      (item) => item.articleId === "article_d1_recovery",
    );
    assert.equal(recoveryLibraryItem?.archivedAt, null);
    assert.equal(recoveryLibraryItem?.categoryName, "Guides");
    assert.equal(recoveryLibraryItem?.categorySlug, "guides");
    assert.equal(recoveryLibraryItem?.createdByMemberId, "member_d1_editor");
    assert.equal(recoveryLibraryItem?.publicStatus, "published");
    assert.equal(recoveryLibraryItem?.publishedRevisionNumber, 1);
    assert.equal(recoveryLibraryItem?.reviewState, "editing");
    assert.equal(recoveryLibraryItem?.slug, "d1-recovery-private");
    assert.equal(recoveryLibraryItem?.title, "D1 private recovery");
    assert.equal(recoveryLibraryItem?.workingRevisionNumber, 2);
    assert.deepEqual(
      recovery.firstHistory?.items.map((item) => item.revisionNumber),
      [3, 2],
    );
    assert.equal(recovery.firstHistory?.nextBeforeRevisionNumber, 2);
    assert.deepEqual(
      recovery.secondHistory?.items.map((item) => item.revisionNumber),
      [1],
    );
    assert.equal(recovery.detail?.revisionNumber, 3);
    assert.equal(recovery.detail?.article.title, "D1 recovery source");
    assert.equal(recovery.detail?.changeKind, "rollback");
    assert.ok(recovery.detail?.restoredFromRevisionId);
    assert.deepEqual(recovery.detail?.events.map((event) => event.action), [
      "restored",
    ]);
    assert.equal(recovery.disabledHistory, null);
    assert.equal(recovery.disabledDetail, null);
    assert.deepEqual(recovery.disabledLibrary, []);
    assert.ok(recovery.roleChangedHistory);
    assert.ok(recovery.roleChangedDetail);
    assert.ok(recovery.roleChangedLibrary.length > 0);
    assert.equal(recovery.cappedDetail?.events.length, 50);
    assert.equal(recovery.cappedDetail?.eventsTruncated, true);
    assert.equal(
      recovery.doubleRestore.filter((result) => result.status === "transitioned").length,
      1,
    );
    assert.equal(
      recovery.doubleRestore.filter((result) => result.code === "STALE_REVISION").length,
      1,
    );
    assert.deepEqual(recovery.slugConflictRestore, {
      status: "conflict",
      code: "SLUG_CONFLICT",
    });
    assert.equal(
      recovery.restoreSlugRace.filter((result) => result.status === "transitioned")
        .length,
      1,
    );
    assert.equal(
      recovery.restoreSlugRace.filter(
        (result) => result.status === "conflict" && result.code === "SLUG_CONFLICT",
      ).length,
      1,
    );
    assert.deepEqual(recovery.missingCategoryRestore, {
      status: "rejected",
      code: "CATEGORY_UNAVAILABLE",
    });
    assert.deepEqual(recovery.unsafeRestore, {
      status: "rejected",
      code: "UNSAFE_REVISION",
    });
    assert.deepEqual(recovery.corruptRestore, {
      status: "rejected",
      code: "REVISION_INTEGRITY_FAILED",
    });
    assert.deepEqual(recovery.missingAssetRestore, {
      status: "rejected",
      code: "ASSET_UNAVAILABLE",
    });
    assert.deepEqual(recovery.inReviewRestore, {
      status: "conflict",
      code: "INVALID_REVIEW_STATE",
      currentRevisionNumber: 1,
      currentReviewState: "in_review",
    });
    assert.deepEqual(
      recovery.negativeRevisionCounts.map((row) => Number(row.revision_count)),
      [2, 2, 2, 2, 2],
    );
    assert.equal(
      recovery.archiveRace.filter((result) => result.status === "transitioned").length,
      1,
    );
    assert.deepEqual(
      {
        archived: Boolean(recovery.archivedState.archived_at),
        contentHash: recovery.archivedState.content_hash,
        evidenceCount: recovery.archivedState.evidence_count,
        revisionCount: recovery.archivedState.revision_count,
        revokedGrants: recovery.archivedState.revoked_grants,
        status: recovery.archivedState.status,
      },
      {
        archived: true,
        contentHash: null,
        evidenceCount: 0,
        revisionCount: 4,
        revokedGrants: 1,
        status: "draft",
      },
    );
    assert.deepEqual(recovery.restoreWhileArchived, {
      status: "rejected",
      code: "ARTICLE_ARCHIVED",
    });
    const archivedLibraryItem = recovery.archivedLibrary.find(
      (item) => item.articleId === "article_d1_recovery",
    );
    assert.equal(archivedLibraryItem?.publicStatus, "draft");
    assert.ok(archivedLibraryItem?.archivedAt);
    assert.deepEqual(
      recovery.slugClaimsAfterArchive,
      recovery.slugClaimsBeforeArchive,
    );
    assert.equal(
      recovery.archiveRestoreRace.filter((result) => result.status === "transitioned")
        .length,
      1,
    );
    assert.equal(
      recovery.archiveRestoreRace.filter(
        (result) => result.status === "rejected" && result.code === "ARTICLE_NOT_ARCHIVED",
      ).length,
      1,
    );
    assert.deepEqual(
      recovery.recoveredHead && {
        archivedAt: recovery.recoveredHead.archivedAt,
        publicStatus: recovery.recoveredHead.publicStatus,
        reviewState: recovery.recoveredHead.reviewState,
        revisionNumber: recovery.recoveredHead.revisionNumber,
      },
      {
        archivedAt: null,
        publicStatus: "draft",
        reviewState: "editing",
        revisionNumber: 4,
      },
    );
    assert.equal(recovery.revokedHistory, null);
    assert.equal(recovery.revokedDetail, null);
    assert.deepEqual(recovery.revokedLibrary, []);
  } finally {
    if (worker) await stopWorker(worker.child);
    rmSync(directory, { force: true, recursive: true });
  }
});
