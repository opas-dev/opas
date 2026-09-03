// ABOUTME: Verifies deploy-time database operations remain explicit and independently invokable.
// ABOUTME: Prevents builds, deploys, migrations, and infrastructure bootstrap from seeding or initializing evidence.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

import { ingressRequestHeaders } from "../scripts/docker-ingress.mjs";

test("Postgres and Neon expose separate migration, seed, and evidence commands", async () => {
  const [manifest, dockerfile, postgres, neon] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../scripts/prepare-postgres.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/prepare-neon.ts", import.meta.url), "utf8"),
  ]);
  const scripts = (JSON.parse(manifest) as { scripts: Record<string, string> }).scripts;

  assert.match(scripts["db:migrate:postgres:deploy"], / migrate$/u);
  assert.match(scripts["db:seed:postgres:deploy"], / seed$/u);
  assert.match(scripts["db:evidence:postgres:deploy"], / initialize-evidence$/u);
  assert.match(scripts["neon:migrate"], / migrate$/u);
  assert.match(scripts["neon:seed"], / seed$/u);
  assert.match(scripts["neon:evidence"], / initialize-evidence$/u);
  assert.match(dockerfile, /prepare-postgres\.cjs migrate && node server\.js/u);
  assert.doesNotMatch(dockerfile.match(/^CMD .*$/gmu)?.at(-2) ?? "", /seed|evidence/u);
  for (const source of [postgres, neon]) {
    assert.match(source, /command === "migrate"/u);
    assert.match(source, /command === "seed"/u);
    assert.match(source, /else \{/u);
  }
});

test("Cloudflare infrastructure bootstrap does not build, migrate, seed, or deploy", async () => {
  const [source, runner] = await Promise.all([
    readFile(new URL("../scripts/bootstrap-cloudflare.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/run-cloudflare.ts", import.meta.url), "utf8"),
  ]);
  const main = source.match(/async function main\(\) \{([\s\S]*?)\n\}/u)?.[1] ?? "";
  assert.match(main, /resolveD1Database\(target\)/u);
  assert.doesNotMatch(main, /prepareCloudflareBuild|migrations|seed|deploy|smoke/u);
  assert.match(runner, /validateCloudflareSecrets/u);
  assert.match(runner, /writeFileSync\(path, JSON\.stringify\(secrets\), \{ mode: 0o600 \}\)/u);
  assert.match(runner, /expectedSecrets: secrets/u);
  assert.match(runner, /rmSync\(directory, \{ force: true, recursive: true \}\)/u);
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

  assert.equal(app.ports, undefined);
  assert.deepEqual(app.expose, ["3000"]);
  assert.deepEqual(ingress.build, { context: ".", target: "ingress" });
  assert.deepEqual(ingress.ports, ["${APP_PORT:-3000}:8080"]);
  assert.match(dockerfile, /FROM node:22\.23\.2-alpine AS ingress/u);
  assert.match(dockerfile, /CMD \["node", "scripts\/docker-ingress\.mjs"\]/u);

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
