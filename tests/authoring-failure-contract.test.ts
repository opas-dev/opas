// ABOUTME: Verifies stable paused-authoring failures across every v0.2 mutation boundary.
// ABOUTME: Covers HTTP response safety, Server Action wiring, and authenticated quality handlers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  authoringPausedMessage,
  authoringPausedResponse,
  getAuthoringPausedFailure,
} from "@/authoring/failures";
import { AuthoringPausedError } from "@/db/authoring-controls";
import {
  handleQualityReviewRequest,
  handleQualityRunRequest,
  handleQuestionSetImportRequest,
} from "@/quality/http";

const origin = "https://quality.example.test";
const expectedFailure = {
  code: "AUTHORING_PAUSED",
  message: authoringPausedMessage,
};

function post(path: string, body: unknown) {
  return new Request(`${origin}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      host: new URL(origin).host,
      origin,
    },
    method: "POST",
  });
}

function functionBody(source: string, name: string, nextName?: string) {
  const start = source.indexOf(`export async function ${name}`);
  const end = nextName
    ? source.indexOf(`export async function ${nextName}`, start)
    : source.length;
  assert.ok(start >= 0, `${name} must remain an exported Server Action or Route Handler`);
  assert.ok(end > start, `${name} must have a bounded source contract`);
  return source.slice(start, end);
}

async function assertPausedResponse(response: Response) {
  assert.equal(response.status, 503);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/u);
  assert.deepEqual(await response.json(), expectedFailure);
}

test("maps direct and nested database failures without accepting unrelated errors", async () => {
  assert.deepEqual(getAuthoringPausedFailure(new AuthoringPausedError()), expectedFailure);
  assert.deepEqual(
    getAuthoringPausedFailure(
      new AggregateError([new Error("write failed"), { code: "AUTHORING_PAUSED" }]),
    ),
    expectedFailure,
  );
  assert.equal(getAuthoringPausedFailure(new Error("connection closed")), null);

  await assertPausedResponse(authoringPausedResponse(new AuthoringPausedError())!);
  assert.equal(authoringPausedResponse(new Error("connection closed")), null);
});

test("persisted quality mutations return the stable paused response after authorization", async () => {
  let authorizationCalls = 0;
  const authorize = async () => {
    authorizationCalls += 1;
  };
  const paused = async () => {
    throw new AuthoringPausedError();
  };

  const responses = [
    await handleQualityRunRequest(
      post("/admin/quality/run", { questionSetId: "question_set_one" }),
      {
        authorize,
        run: paused,
      },
    ),
    await handleQuestionSetImportRequest(
      post("/admin/quality/import", { schema: "opas.saved-question-set.v1" }),
      {
        authorize,
        importQuestionSet: paused,
      },
    ),
    await handleQualityReviewRequest(
      post("/admin/quality/review", { schema: "opas.quality-review.v1" }),
      {
        authorize,
        importReview: paused,
      },
    ),
  ];

  assert.equal(authorizationCalls, responses.length);
  for (const response of responses) {
    await assertPausedResponse(response);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
});

test("every current content, asset, import, theme, and quality write boundary maps pauses", () => {
  const contentActions = readFileSync("src/app/admin/content/actions.ts", "utf8");
  const themeActions = readFileSync("src/app/admin/theme/actions.ts", "utf8");
  const assetRoute = readFileSync("src/app/admin/content/assets/route.ts", "utf8");
  const importRoute = readFileSync(
    "src/app/admin/content/import/run/route.ts",
    "utf8",
  );

  const contentActionNames = [
    "saveCategoryAction",
    "deleteCategoryAction",
    "saveArticleAction",
    "deleteArticleAction",
  ] as const;
  for (const [index, name] of contentActionNames.entries()) {
    const body = functionBody(contentActions, name, contentActionNames[index + 1]);
    assert.match(body, /pausedErrorState\(previousState, error\)/u, name);
  }
  assert.match(
    functionBody(themeActions, "updateThemeAction"),
    /getAuthoringPausedFailure\(error\)/u,
  );
  const assetPost = functionBody(assetRoute, "POST", "DELETE");
  assert.match(assetPost, /authoringPausedResponse\(error\)/u);
  assert.match(assetPost, /authoringPausedResponse\(cleanupError\)/u);
  assert.match(
    functionBody(assetRoute, "DELETE"),
    /authoringPausedResponse\(error\)/u,
  );
  assert.match(
    functionBody(importRoute, "POST"),
    /authoringPausedResponse\(error\)/u,
  );

  for (const [path, handler] of [
    ["src/app/admin/quality/import/route.ts", "handleQuestionSetImportRequest"],
    ["src/app/admin/quality/run/route.ts", "handleQualityRunRequest"],
    ["src/app/admin/quality/review/route.ts", "handleQualityReviewRequest"],
  ] as const) {
    assert.match(readFileSync(path, "utf8"), new RegExp(`return ${handler}\\(`), path);
  }
});
