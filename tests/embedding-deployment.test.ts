// ABOUTME: Verifies every deployment target has independent answer and embedding contracts.
// ABOUTME: Guards provider, scheduler, secret, and Docker sidecar wiring without deploying.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function jsonFile(path: string) {
  const source = readFileSync(path, "utf8");
  const start = source.indexOf("{");
  assert.notEqual(start, -1);
  return JSON.parse(source.slice(start)) as Record<string, unknown>;
}

test("Cloudflare uses configured Workers AI answers and independent recovery schedules", () => {
  const config = jsonFile("wrangler.jsonc");

  assert.equal(config.main, "custom-worker.ts");
  assert.deepEqual(config.ai, { binding: "AI" });
  assert.deepEqual(config.triggers, {
    crons: ["* * * * *", "15 0 * * *"],
  });
  const vars = config.vars as Record<string, unknown>;
  assert.equal(vars.OPAS_GENERATION_GATEWAY_ID, "opas-answers");
  assert.equal(
    vars.OPAS_GENERATION_MODEL,
    "@cf/meta/llama-3.1-8b-instruct-fp8",
  );
  assert.match(
    String(vars.OPAS_GENERATION_RETENTION_DISCLOSURE),
    /retain configured redacted conversation records.*30 days.*support handoffs.*logging is disabled.*caching is bypassed/iu,
  );
  assert.equal("OPAS_ANSWER_TOPIC_GUARDRAILS" in vars, false);
  assert.equal(
    vars.OPAS_EMBED_PARENT_ORIGINS,
    "https://opas.dev,https://www.opas.dev",
  );

  const worker = readFileSync("custom-worker.ts", "utf8");
  assert.match(worker, /fetch:\s*handler\.fetch/u);
  assert.match(worker, /async scheduled\(/u);
  assert.match(worker, /workersAiBinding:\s*env\.AI/u);
  assert.match(worker, /drizzle\(env\.DB/u);
});

test("Vercel uses the authenticated route on its Hobby-compatible recovery schedule", () => {
  const config = jsonFile("vercel.json");

  assert.deepEqual(config.crons, [
    {
      path: "/api/internal/embeddings",
      schedule: "0 0 * * *",
    },
    {
      path: "/api/internal/analytics",
      schedule: "15 0 * * *",
    },
  ]);
  assert.equal("env" in config, false);
});

test("Docker runs the authenticated recovery client independently from the app", () => {
  const compose = readFileSync("docker-compose.yml", "utf8");
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const preparation = readFileSync("scripts/prepare-postgres.ts", "utf8");

  assert.match(compose, /embedding-recovery:/u);
  assert.match(compose, /"node", "scripts\/run-embedding-recovery\.mjs"/u);
  assert.match(
    compose,
    /OPAS_EMBEDDING_RECOVERY_URL:\s*http:\/\/app:3000\/api\/internal\/embeddings/u,
  );
  assert.match(compose, /CRON_SECRET:\s*\$\{CRON_SECRET:\?Set CRON_SECRET in \.env\}/u);
  assert.match(compose, /analytics-cleanup:/u);
  assert.match(compose, /"node", "scripts\/run-analytics-cleanup\.mjs"/u);
  assert.match(
    compose,
    /OPAS_ANALYTICS_CLEANUP_URL:\s*http:\/\/app:3000\/api\/internal\/analytics/u,
  );
  for (const name of [
    "OPAS_ANSWER_TOPIC_GUARDRAILS",
    "OPAS_ANSWER_FALLBACK_INPUT_MICRODOLLARS_PER_MILLION_TOKENS",
    "OPAS_ANSWER_FALLBACK_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS",
    "OPAS_GENERATION_API_KEY",
    "OPAS_GENERATION_ENDPOINT",
    "OPAS_GENERATION_FALLBACK_API_KEY",
    "OPAS_GENERATION_FALLBACK_ENDPOINT",
    "OPAS_GENERATION_FALLBACK_GATEWAY_ID",
    "OPAS_GENERATION_FALLBACK_MODEL",
    "OPAS_GENERATION_FALLBACK_PROVIDER",
    "OPAS_GENERATION_FALLBACK_RETENTION_DISCLOSURE",
    "OPAS_GENERATION_MODEL",
    "OPAS_GENERATION_RETENTION_DISCLOSURE",
    "OPAS_EMBED_PARENT_ORIGINS",
  ]) {
    assert.match(compose, new RegExp(`${name}:\\s*\\$\\{${name}:-\\}`, "u"));
  }
  assert.match(
    compose,
    /OPAS_GENERATION_FALLBACK_ENABLED:\s*\$\{OPAS_GENERATION_FALLBACK_ENABLED:-false\}/u,
  );
  assert.match(dockerfile, /scripts\/run-embedding-recovery\.mjs/u);
  assert.match(dockerfile, /node prepare-postgres\.cjs && node server\.js/u);
  assert.match(preparation, /initializeAllMissingArticleEvidence/u);
});

test("recovery initializes one evidence batch before provider selection", () => {
  const runner = readFileSync("src/ai/embedding-runner.ts", "utf8");
  const initialization = runner.indexOf("initializeMissingArticleEvidence({");
  const providerSelection = runner.indexOf(
    "configuredNonCloudflareProvider(dependencies.environment)",
  );

  assert.ok(initialization >= 0);
  assert.ok(providerSelection >= 0);
  assert.ok(initialization < providerSelection);
});

test("the environment template documents secret and provider settings without values", () => {
  const template = readFileSync(".env.example", "utf8");

  for (const name of [
    "CRON_SECRET",
    "OPAS_ANSWER_TOPIC_GUARDRAILS",
    "OPAS_EMBEDDING_API_KEY",
    "OPAS_EMBEDDING_DIMENSION",
    "OPAS_EMBEDDING_DIMENSIONS_PARAMETER",
    "OPAS_EMBEDDING_ENDPOINT",
    "OPAS_EMBEDDING_MODEL",
    "OPAS_GENERATION_API_KEY",
    "OPAS_GENERATION_ENDPOINT",
    "OPAS_GENERATION_FALLBACK_API_KEY",
    "OPAS_GENERATION_FALLBACK_ENABLED",
    "OPAS_GENERATION_FALLBACK_ENDPOINT",
    "OPAS_GENERATION_FALLBACK_GATEWAY_ID",
    "OPAS_GENERATION_FALLBACK_MODEL",
    "OPAS_GENERATION_FALLBACK_PROVIDER",
    "OPAS_GENERATION_FALLBACK_RETENTION_DISCLOSURE",
    "OPAS_GENERATION_MODEL",
    "OPAS_GENERATION_RETENTION_DISCLOSURE",
    "OPAS_EMBED_PARENT_ORIGINS",
  ]) {
    assert.match(template, new RegExp(`^${name}=`, "mu"));
  }

  assert.match(template, /^CRON_SECRET=$/mu);
  assert.match(template, /^OPAS_ANSWER_TOPIC_GUARDRAILS=$/mu);
  assert.match(template, /^OPAS_EMBEDDING_API_KEY=$/mu);
  assert.match(template, /^OPAS_GENERATION_API_KEY=$/mu);
});

test("article publication and imports schedule recovery only after durable writes", () => {
  const actions = readFileSync("src/app/admin/content/actions.ts", "utf8");
  const imports = readFileSync(
    "src/app/admin/content/import/run/route.ts",
    "utf8",
  );
  const saveStart = actions.indexOf("export async function saveArticleAction");
  const deleteStart = actions.indexOf("export async function deleteArticleAction");
  const saveBody = actions.slice(saveStart, deleteStart);
  const deleteBody = actions.slice(deleteStart);

  assert.ok(saveStart >= 0 && deleteStart > saveStart);
  assert.ok(
    saveBody.indexOf("scheduleEmbeddingRecovery();") >
      saveBody.indexOf("await repository.updateArticle"),
  );
  assert.ok(
    deleteBody.indexOf("scheduleEmbeddingRecovery();") >
      deleteBody.indexOf("await repository.deleteArticle"),
  );
  assert.ok(
    imports.indexOf("scheduleEmbeddingRecovery();") >
      imports.indexOf("await executeKnowledgeImport"),
  );
});
