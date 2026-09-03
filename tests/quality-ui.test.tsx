// ABOUTME: Verifies the administrator quality surface is explicit, accessible, and safely labeled.
// ABOUTME: Covers active navigation, retained replay wording, and preflight-versus-citation clarity.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import {
  QualityPlayground,
  RetainedEvidenceReplay,
} from "@/app/admin/quality/quality-controls";

test("renders an accessible bounded ephemeral playground", () => {
  const markup = renderToStaticMarkup(<QualityPlayground />);
  assert.match(markup, /<label[^>]+for="quality-playground-question"/u);
  assert.match(markup, /maxLength="200"/u);
  assert.match(markup, /required=""/u);
  assert.match(markup, /aria-live="polite"/u);
  assert.match(markup, /Ephemeral\./u);
  assert.match(markup, /not saved by the playground/u);
  assert.doesNotMatch(markup, /dangerouslySetInnerHTML|<dialog/u);
});

test("labels retained evidence reproduction as diagnostic and ephemeral", () => {
  const markup = renderToStaticMarkup(
    <RetainedEvidenceReplay conversationId="123e4567-e89b-42d3-a456-426614174000" />,
  );
  assert.match(markup, /Reproduce from retained evidence/u);
  assert.match(markup, /configured provider/u);
  assert.match(markup, /only the retained redacted excerpts/u);
  assert.match(markup, /never queries the current knowledge index/u);
  assert.match(markup, /not a byte-identical replay/u);
  assert.match(markup, /does not save the reproduction/u);
  assert.match(markup, /aria-live="polite"/u);
  assert.doesNotMatch(markup, /dangerouslySetInnerHTML|<dialog/u);
});

test("labels retained replay and lexical preflight without overstating generated evidence", async () => {
  const [
    page,
    controls,
    header,
    importRoute,
    replayRoute,
    reviewRoute,
    consoleSource,
  ] = await Promise.all([
    readFile(new URL("../src/app/admin/quality/page.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../src/app/admin/quality/quality-controls.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/app/admin/header.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../src/app/admin/quality/import/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/app/admin/quality/replay/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/app/admin/quality/review/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/quality/console.ts", import.meta.url), "utf8"),
  ]);

  assert.match(
    page,
    /await requireMemberCapability\("content:read", demoIds\.workspace\)/u,
  );
  assert.match(page, /Retained replay never[\s\S]*current knowledge index/u);
  assert.match(page, /<RetainedEvidenceReplay/u);
  assert.match(page, /Retained redacted excerpt/u);
  assert.match(page, /First content token/u);
  assert.match(page, /p95 first content token/u);
  assert.match(page, /Retained outcome reconciliation/u);
  assert.match(page, /Pilot release gate/u);
  assert.match(page, /Missing reviews,[\s\S]*never count as passes/u);
  assert.match(page, /Production first-content-token p95/u);
  assert.match(page, /total request/u);
  assert.match(page, /source\.contentHash/u);
  assert.match(page, /source\.articleContentHash/u);
  assert.match(page, /source\.sourceLineRange\.start/u);
  assert.match(page, /configured production answer runtime/u);
  assert.match(page, /current citation provenance/u);
  assert.match(page, /<SavedQuestionImport/u);
  assert.match(page, /manual grounded and materially correct/u);
  assert.match(page, /manually entailed and[\s\S]*citation-covered claims/u);
  assert.match(page, /Evaluation scores by question class/u);
  assert.match(page, /<EvaluationReview/u);
  assert.match(
    page,
    /key=\{`\$\{selectedRun\.id\}:\$\{question\.id\}`\}/u,
  );
  assert.match(page, /<ContentGaps/u);
  assert.match(controls, /id="quality-question-set-file"/u);
  assert.match(controls, /accept="application\/json,.json"/u);
  assert.match(controls, /\/admin\/quality\/import/u);
  assert.match(controls, /256 KiB and 100 questions/u);
  assert.match(controls, /active\s+workspace is assigned by the server/u);
  assert.match(
    importRoute,
    /authorize: \(\) => requireMemberCapability\("quality:manage", demoIds\.workspace\)/u,
  );
  assert.match(importRoute, /importQuestionSet: importActiveSavedQuestionSet/u);
  assert.doesNotMatch(importRoute, /workspaceId/u);
  assert.match(
    replayRoute,
    /authorize: \(\) => requireMemberCapability\("quality:manage", demoIds\.workspace\)/u,
  );
  assert.match(replayRoute, /run: runActiveRetainedConversationReplay/u);
  assert.doesNotMatch(replayRoute, /workspaceId/u);
  assert.match(controls, /qualityReviewImportSchema/u);
  assert.match(consoleSource, /opas\.quality-review\.v1/u);
  assert.match(controls, /\/admin\/quality\/review/u);
  assert.match(controls, /Human scoring/u);
  assert.match(controls, /Materially correct/u);
  assert.match(controls, /Claim \{claim\.ordinal \+ 1\} entailed/u);
  assert.match(controls, /Claim \{claim\.ordinal \+ 1\} citation-covered/u);
  assert.match(controls, /required/u);
  assert.match(
    reviewRoute,
    /authorize: \(\) => requireMemberCapability\("quality:manage", demoIds\.workspace\)/u,
  );
  assert.match(reviewRoute, /importReview: importActiveQualityReview/u);
  assert.doesNotMatch(reviewRoute, /workspaceId/u);
  assert.match(controls, /Lexical preflight retrieval/u);
  assert.match(controls, /separate lexical preview/u);
  assert.match(controls, /generated answer cited/u);
  assert.match(header, /href: "\/admin\/quality", label: "Quality"/u);
  assert.doesNotMatch(`${page}\n${controls}`, /providerError|raw provider/u);
  assert.doesNotMatch(`${page}\n${controls}`, /dangerouslySetInnerHTML|<dialog/u);
});
