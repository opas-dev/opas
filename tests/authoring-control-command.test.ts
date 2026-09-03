// ABOUTME: Verifies the operator-only workspace authoring fence command contract.
// ABOUTME: Covers strict targeting, compare-and-swap behavior, and safe D1 result parsing.
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAuthoringControlCommand,
  parseD1Rows,
  runAuthoringControlCommand,
  type AuthoringControl,
  type AuthoringControlStore,
} from "../scripts/authoring-control";

const activeControl: AuthoringControl = {
  changedAt: "2026-09-03T12:00:00.000Z",
  changedByMemberId: null,
  generation: 4,
  workspaceId: "workspace_opas",
  workspaceName: "OPAS Help",
  workspaceSlug: "opas",
  writesPaused: false,
};

function recordingStore(
  controls: readonly AuthoringControl[] = [activeControl],
  backfillState: "complete" | "incomplete" | "not-installed" = "not-installed",
): AuthoringControlStore & { changes: unknown[][] } {
  const changes: unknown[][] = [];
  return {
    async backfillState() {
      return backfillState;
    },
    changes,
    async change(workspaceId, generation, writesPaused, changedAt) {
      changes.push([workspaceId, generation, writesPaused, changedAt]);
      return {
        ...activeControl,
        changedAt: changedAt.toISOString(),
        generation: generation + 1,
        writesPaused,
      };
    },
    async close() {},
    async find() {
      return controls;
    },
  };
}

test("parses explicit target and mutation generation", () => {
  assert.deepEqual(
    parseAuthoringControlCommand([
      "pause",
      "--target",
      "cloudflare",
      "--workspace",
      "opas",
      "--expected-generation",
      "4",
      "--config",
      "wrangler.crofusion.jsonc",
      "--remote",
    ]),
    {
      action: "pause",
      configPath: "wrangler.crofusion.jsonc",
      expectedGeneration: 4,
      location: "remote",
      persistTo: undefined,
      target: "cloudflare",
      workspace: "opas",
    },
  );
});

test("requires fresh CAS input and an explicit D1 location", () => {
  assert.throws(
    () =>
      parseAuthoringControlCommand([
        "pause",
        "--target",
        "postgres",
        "--workspace",
        "opas",
      ]),
    /requires --expected-generation from a fresh inspect/u,
  );
  assert.throws(
    () =>
      parseAuthoringControlCommand([
        "inspect",
        "--target",
        "cloudflare",
        "--workspace",
        "opas",
      ]),
    /require exactly one of --local or --remote/u,
  );
  assert.throws(
    () =>
      parseAuthoringControlCommand([
        "resume",
        "--target",
        "neon",
        "--workspace",
        "opas",
        "--expected-generation",
        "4",
        "--remote",
      ]),
    /Cloudflare-only/u,
  );
});

test("pauses the exact inspected generation and reports its successor", async () => {
  const store = recordingStore();
  const changedAt = new Date("2026-09-03T13:00:00.000Z");
  const result = await runAuthoringControlCommand(
    {
      action: "pause",
      expectedGeneration: 4,
      target: "postgres",
      workspace: "opas",
    },
    store,
    () => changedAt,
  );
  assert.equal(result.changed, true);
  assert.equal(result.control.writesPaused, true);
  assert.equal(result.control.generation, 5);
  assert.deepEqual(store.changes, [
    ["workspace_opas", 4, true, changedAt],
  ]);
});

test("rejects stale, missing, and ambiguous workspaces without changing state", async () => {
  const stale = recordingStore();
  await assert.rejects(
    runAuthoringControlCommand(
      {
        action: "pause",
        expectedGeneration: 3,
        target: "postgres",
        workspace: "opas",
      },
      stale,
    ),
    /Expected fence generation 3, found 4/u,
  );
  assert.deepEqual(stale.changes, []);

  await assert.rejects(
    runAuthoringControlCommand(
      { action: "inspect", target: "postgres", workspace: "missing" },
      recordingStore([]),
    ),
    /No workspace matches/u,
  );
  await assert.rejects(
    runAuthoringControlCommand(
      { action: "inspect", target: "postgres", workspace: "ambiguous" },
      recordingStore([activeControl, { ...activeControl, workspaceId: "other" }]),
    ),
    /is ambiguous/u,
  );
});

test("does not advance a fence already in the requested state", async () => {
  const store = recordingStore([{ ...activeControl, writesPaused: true }]);
  const result = await runAuthoringControlCommand(
    {
      action: "pause",
      expectedGeneration: 4,
      target: "postgres",
      workspace: "opas",
    },
    store,
  );
  assert.equal(result.changed, false);
  assert.deepEqual(store.changes, []);
});

test("refuses to resume while the team-authoring backfill is incomplete", async () => {
  const store = recordingStore(
    [{ ...activeControl, writesPaused: true }],
    "incomplete",
  );
  await assert.rejects(
    runAuthoringControlCommand(
      {
        action: "resume",
        expectedGeneration: 4,
        target: "postgres",
        workspace: "opas",
      },
      store,
    ),
    /AUTHORING_BACKFILL_INCOMPLETE/u,
  );
  assert.deepEqual(store.changes, []);
});

test("resumes before the table exists or after the workspace ledger is complete", async () => {
  for (const backfillState of ["not-installed", "complete"] as const) {
    const store = recordingStore(
      [{ ...activeControl, writesPaused: true }],
      backfillState,
    );
    const result = await runAuthoringControlCommand(
      {
        action: "resume",
        expectedGeneration: 4,
        target: "postgres",
        workspace: "opas",
      },
      store,
    );
    assert.equal(result.control.writesPaused, false);
  }
});

test("parses Wrangler D1 rows without retaining command metadata", () => {
  assert.deepEqual(
    parseD1Rows(
      JSON.stringify([
        {
          meta: { duration: 0.2 },
          results: [{ workspace_id: "workspace_opas", writes_paused: 0 }],
          success: true,
        },
      ]),
    ),
    [{ workspace_id: "workspace_opas", writes_paused: 0 }],
  );
  assert.throws(() => parseD1Rows("not json"), /invalid JSON/u);
});
