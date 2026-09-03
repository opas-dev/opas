// ABOUTME: Verifies deploy-time database operations remain explicit and independently invokable.
// ABOUTME: Prevents builds, deploys, migrations, and infrastructure bootstrap from seeding or initializing evidence.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

import { ingressRequestHeaders } from "../scripts/docker-ingress.mjs";

function assertOrdered(source: string, values: readonly string[]) {
  let cursor = -1;
  for (const value of values) {
    const index = source.indexOf(value, cursor + 1);
    assert.notEqual(index, -1, `Expected ${JSON.stringify(value)} after offset ${cursor}.`);
    cursor = index;
  }
}

test("Postgres and Neon expose separate migration, backfill, seed, and evidence commands", async () => {
  const [manifest, dockerfile, postgres, neon] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../scripts/prepare-postgres.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/prepare-neon.ts", import.meta.url), "utf8"),
  ]);
  const scripts = (JSON.parse(manifest) as { scripts: Record<string, string> }).scripts;

  assert.match(scripts["db:backfill:postgres"], / backfill$/u);
  assert.match(scripts["db:backfill:postgres:deploy"], / backfill$/u);
  assert.match(scripts["db:migrate:postgres:deploy"], / migrate$/u);
  assert.match(scripts["db:seed:postgres:deploy"], / seed$/u);
  assert.match(scripts["db:evidence:postgres:deploy"], / initialize-evidence$/u);
  assert.match(scripts["neon:backfill"], / backfill$/u);
  assert.match(scripts["neon:migrate"], / migrate$/u);
  assert.match(scripts["neon:seed"], / seed$/u);
  assert.match(scripts["neon:evidence"], / initialize-evidence$/u);
  assert.match(dockerfile, /prepare-postgres\.cjs migrate && node server\.js/u);
  assert.doesNotMatch(
    dockerfile.match(/^CMD .*$/gmu)?.at(-2) ?? "",
    /backfill|seed|evidence/u,
  );
  for (const source of [postgres, neon]) {
    assert.match(source, /command === "backfill"/u);
    assert.match(source, /command === "migrate"/u);
    assert.match(source, /command === "seed"/u);
    assert.match(source, /createPostgresTeamAuthoringBackfillStore/u);
    assert.match(source, /runTeamAuthoringBackfill/u);
  }
});

test("Cloudflare exposes isolated local and remote backfill commands", async () => {
  const [manifest, runner, backfill, data] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/run-cloudflare.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/backfill-cloudflare.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/cloudflare-data.ts", import.meta.url), "utf8"),
  ]);
  const scripts = (JSON.parse(manifest) as { scripts: Record<string, string> }).scripts;

  assert.equal(scripts["cf:backfill"], "tsx scripts/run-cloudflare.ts backfill");
  assert.equal(
    scripts["cf:backfill:crofusion"],
    "tsx scripts/run-cloudflare.ts backfill --config wrangler.crofusion.jsonc",
  );
  assert.equal(
    scripts["db:backfill:d1:local"],
    "tsx scripts/run-cloudflare.ts backfill --local",
  );
  assert.match(runner, /verifyCloudflareDatabaseTarget\(target\)/u);
  assert.match(runner, /prepareCloudflareTargetSnapshot\(target\)/u);
  assert.match(runner, /environment: cloudflareCommandEnvironment\(target\.accountId\)/u);
  assert.match(backfill, /createD1TeamAuthoringBackfillStore/u);
  assert.match(backfill, /runTeamAuthoringBackfill/u);
  assert.match(data, /remoteBindings: remote/u);
  assert.doesNotMatch(
    `${runner}\n${backfill}\n${data}`,
    /wrangler["']?,\s*["'](?:dev|deploy)/iu,
  );
});

test("Cloudflare infrastructure bootstrap does not build, migrate, backfill, seed, or deploy", async () => {
  const [source, runner] = await Promise.all([
    readFile(new URL("../scripts/bootstrap-cloudflare.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/run-cloudflare.ts", import.meta.url), "utf8"),
  ]);
  const main = source.match(/async function main\(\) \{([\s\S]*?)\n\}/u)?.[1] ?? "";
  assert.match(main, /resolveD1Database\(target\)/u);
  assert.doesNotMatch(
    main,
    /prepareCloudflareBuild|migrations|backfill|seed|deploy|smoke/u,
  );
  assert.match(runner, /validateCloudflareSecrets/u);
  assert.match(runner, /writeFileSync\(path, JSON\.stringify\(secrets\), \{ mode: 0o600 \}\)/u);
  assert.match(runner, /expectedSecrets: secrets/u);
  assert.match(runner, /rmSync\(directory, \{ force: true, recursive: true \}\)/u);
});

test("clean-install runbooks keep the paused backfill before resume and seed", async () => {
  const [readme, cloudflare, vercel] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/deploy-cloudflare.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/deploy-vercel.md", import.meta.url), "utf8"),
  ]);
  const development = readme.split("## Development and verification")[1] ?? "";
  const firstCloudflareDeployment =
    cloudflare.split("## First deployment")[1]?.split("## Answer generation")[0] ?? "";
  const neonPreparation =
    vercel.split("## Build, migrate, bootstrap, backfill, and seed")[1]?.split(
      "## Deploy and smoke-test",
    )[0] ?? "";

  assertOrdered(development, [
    "prepare-postgres.ts migrate",
    "operator:identity -- bootstrap --target postgres",
    "db:backfill:postgres",
    "authoring:control -- inspect --target postgres",
    "authoring:control -- resume --target postgres",
    "db:seed:postgres",
  ]);
  assertOrdered(firstCloudflareDeployment, [
    "pnpm cf:migrate",
    "operator:identity -- bootstrap --target cloudflare",
    "pnpm cf:backfill",
    "authoring:control -- inspect --target cloudflare",
    "authoring:control -- resume --target cloudflare",
    "pnpm cf:seed",
  ]);
  assertOrdered(neonPreparation, [
    "pnpm neon:migrate",
    "operator:identity -- bootstrap --target neon",
    "pnpm neon:backfill",
    "authoring:control -- inspect --target neon",
    "authoring:control -- resume --target neon",
    "pnpm neon:seed",
  ]);
});

test("runtime deployment surfaces exclude bootstrap credentials and include preview signing", async () => {
  const [compose, vercel, generic, cro] = await Promise.all([
    readFile(new URL("../docker-compose.yml", import.meta.url), "utf8"),
    readFile(new URL("../scripts/build-vercel.ts", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.crofusion.jsonc", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(compose, /^\s+ADMIN_(?:EMAIL|PASSWORD):/mu);
  assert.doesNotMatch(vercel, /sanitized\.ADMIN_(?:EMAIL|PASSWORD)/u);
  for (const config of [generic, cro]) {
    const required = (JSON.parse(config.split("\n").slice(2).join("\n")) as {
      secrets: { required: string[] };
    }).secrets.required;
    assert.equal(required.includes("ADMIN_EMAIL"), false);
    assert.equal(required.includes("ADMIN_PASSWORD"), false);
    assert.equal(required.includes("ADMIN_SESSION_SECRET"), true);
    assert.equal(required.includes("OPAS_PREVIEW_SIGNING_SECRET"), true);
  }
});

test("Docker exposes OPAS only through its client-address rebuilding ingress", async () => {
  const [composeSource, dockerfile] = await Promise.all([
    readFile(new URL("../docker-compose.yml", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
  ]);
  const compose = parse(composeSource) as {
    services: Record<string, Record<string, unknown>>;
  };
  const app = compose.services.app;
  const ingress = compose.services.ingress;

  assert.deepEqual(app.build, { context: ".", target: "runner" });
  assert.deepEqual(compose.services["embedding-recovery"].build, {
    context: ".",
    target: "runner",
  });
  assert.deepEqual(compose.services["analytics-cleanup"].build, {
    context: ".",
    target: "runner",
  });
  assert.equal(app.ports, undefined);
  assert.deepEqual(app.expose, ["3000"]);
  assert.deepEqual(ingress.build, { context: ".", target: "ingress" });
  assert.deepEqual(ingress.ports, ["${APP_PORT:-3000}:8080"]);
  assert.match(dockerfile, /FROM node:22\.23\.2-alpine AS ingress/u);
  assert.match(dockerfile, /CMD \["node", "scripts\/docker-ingress\.mjs"\]/u);
  assert.match(dockerfile, /FROM runner AS application\s*$/u);

  assert.deepEqual(
    ingressRequestHeaders(
      {
        "cf-connecting-ip": "192.0.2.4",
        connection: "keep-alive, x-remove-me",
        forwarded: "for=192.0.2.5",
        host: "help.example.test",
        "x-remove-me": "connection-scoped",
        "x-forwarded-for": "192.0.2.6",
        "x-opas-client-address": "192.0.2.7",
        "x-real-ip": "192.0.2.8",
        "x-vercel-forwarded-for": "192.0.2.9",
      },
      "198.51.100.24",
    ),
    {
      host: "help.example.test",
      "x-opas-client-address": "198.51.100.24",
    },
  );
  assert.throws(() => ingressRequestHeaders({}, undefined));
});
