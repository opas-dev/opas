// ABOUTME: Verifies that Cloudflare bootstrap configuration cannot escape OPAS resources.
// ABOUTME: Guards the maintained custom domain, workers.dev fallback, and matching Worker/D1 targets.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cloudflareCommandEnvironment,
  cloudflareSeedProfile,
  prepareCloudflareTargetSnapshot,
  readCloudflareTarget,
  requiredCloudflareSecretNames,
  validateCloudflareConfig,
  validateCloudflareSecrets,
} from "../scripts/bootstrap-cloudflare";
import {
  assertCloudflareDataEnvironment,
  cloudflareDataConfig,
  parseCloudflareDataCommand,
} from "../scripts/cloudflare-data";

test("preserves command discovery while pinning the validated Cloudflare account", () => {
  const accountId = "f8801c7e8853a113a25f8b52fd9ceec1";
  assert.deepEqual(
    cloudflareCommandEnvironment(accountId, {
      GITHUB_TOKEN: "must-not-reach-subprocesses",
      CF_ACCOUNT_ID: accountId,
      HOME: "/tmp/operator-home",
      PATH: "/usr/bin:/bin",
    }),
    {
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      HOME: "/tmp/operator-home",
      PATH: "/usr/bin:/bin",
    },
  );
  assert.throws(() =>
    cloudflareCommandEnvironment(accountId, {
      CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
      PATH: "/usr/bin:/bin",
    }),
  );
  assert.throws(() =>
    cloudflareCommandEnvironment(accountId, {
      CF_ACCOUNT_ID: "b".repeat(32),
      PATH: "/usr/bin:/bin",
    }),
  );
});

test("rejects ambient app secrets before constructing a D1 binding proxy", () => {
  const accountId = "f8801c7e8853a113a25f8b52fd9ceec1";
  const safeEnvironment = {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: "cloudflare-credential",
    HOME: "/tmp/operator-home",
    PATH: "/usr/bin:/bin",
  };
  assert.doesNotThrow(() =>
    assertCloudflareDataEnvironment(accountId, safeEnvironment),
  );
  assert.throws(
    () =>
      assertCloudflareDataEnvironment(accountId, {
        ...safeEnvironment,
        ADMIN_SESSION_SECRET: "must-not-reach-the-proxy",
        DATABASE_URL: "must-not-reach-the-proxy",
      }),
    /ADMIN_SESSION_SECRET, DATABASE_URL/u,
  );
  assert.throws(() =>
    assertCloudflareDataEnvironment(accountId, {
      ...safeEnvironment,
      CF_ACCOUNT_ID: "b".repeat(32),
    }),
  );
});

test("requires one exact location and config for native D1 data commands", () => {
  assert.deepEqual(
    parseCloudflareDataCommand([
      "--local",
      "--config",
      "wrangler.jsonc",
    ]),
    { configPath: "wrangler.jsonc", remote: false },
  );
  assert.deepEqual(
    parseCloudflareDataCommand([
      "--remote",
      "--config",
      "wrangler.crofusion.jsonc",
    ]),
    { configPath: "wrangler.crofusion.jsonc", remote: true },
  );
  for (const args of [
    [],
    ["--remote"],
    ["--remote", "--config"],
    ["--remote", "--config", "wrangler.jsonc", "--local"],
    ["--preview", "--config", "wrangler.jsonc"],
  ]) {
    assert.throws(() => parseCloudflareDataCommand(args));
  }
});

test("reduces native D1 proxy configuration to the validated account and binding", () => {
  const target = validateCloudflareConfig(validConfig());
  const config = cloudflareDataConfig(target);

  assert.deepEqual(Object.keys(config).sort(), [
    "account_id",
    "compatibility_date",
    "compatibility_flags",
    "d1_databases",
    "name",
  ]);
  assert.equal(config.account_id, target.accountId);
  assert.equal(config.name, target.workerName);
  assert.deepEqual(config.d1_databases, target.config.d1_databases);
  assert.deepEqual(cloudflareDataConfig(target, true).d1_databases, [
    {
      binding: "DB",
      database_name: target.databaseName,
      database_id: target.databaseId,
      migrations_dir: "drizzle/sqlite",
      remote: true,
    },
  ]);
  assert.equal("vars" in config, false);
  assert.equal("secrets" in config, false);
  assert.equal("main" in config, false);
});

test("routes every remote Cloudflare package command through target validation", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  const runner = readFileSync("scripts/run-cloudflare.ts", "utf8");

  for (const name of [
    "cf:backfill",
    "cf:backfill:crofusion",
    "cf:deploy",
    "cf:dry-run",
    "cf:migrate",
    "cf:seed",
  ]) {
    assert.match(packageJson.scripts[name], /scripts\/run-cloudflare\.ts/u);
  }
  assert.match(runner, /readCloudflareTarget/u);
  assert.match(runner, /cloudflareCommandEnvironment/u);
});

test("the maintained config declares the canonical base secret set", () => {
  const target = readCloudflareTarget("wrangler.jsonc");
  assert.deepEqual(target.secretNames, requiredCloudflareSecretNames());
});

function validConfig() {
  return {
    name: "opas-mvp",
    account_id: "f8801c7e8853a113a25f8b52fd9ceec1",
    main: "custom-worker.ts",
    assets: {
      binding: "ASSETS",
      directory: ".open-next/assets",
    },
    workers_dev: true,
    preview_urls: false,
    routes: [
      {
        pattern: "demo.opas.dev",
        custom_domain: true,
      },
    ],
    services: [
      {
        binding: "WORKER_SELF_REFERENCE",
        service: "opas-mvp",
      },
    ],
    ai: {
      binding: "AI",
    },
    secrets: {
      required: requiredCloudflareSecretNames(),
    },
    send_email: [
      {
        name: "SUPPORT_EMAIL",
        allowed_sender_addresses: ["hello@opas.dev"],
      },
    ],
    triggers: {
      crons: ["* * * * *", "15 0 * * *"],
    },
    vars: {
      OPAS_DATABASE_DRIVER: "d1",
      OPAS_ANSWER_DAILY_BUDGET_MICRODOLLARS: "1000000",
      OPAS_ANSWER_ANALYTICS_RETENTION_DAYS: "30",
      OPAS_ANSWER_INPUT_MICRODOLLARS_PER_MILLION_TOKENS: "152000",
      OPAS_ANSWER_LEASE_MILLISECONDS: "45000",
      OPAS_ANSWER_MAXIMUM_CONCURRENCY: "4",
      OPAS_ANSWER_MAXIMUM_INPUT_TOKENS: "32000",
      OPAS_ANSWER_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS: "287000",
      OPAS_GENERATION_GATEWAY_ID: "opas-answers",
      OPAS_GENERATION_MODEL: "@cf/meta/llama-3.1-8b-instruct-fp8",
      OPAS_GENERATION_RETENTION_DISCLOSURE:
        "OPAS retains only configured redacted conversation records; AI Gateway logging is disabled and response caching is bypassed.",
      OPAS_ANALYTICS_REDACTION_PATTERNS: "[]",
      OPAS_EMBED_PARENT_ORIGINS: "https://opas.dev,https://www.opas.dev",
      OPAS_HANDOFF_DAILY_LIMIT: "100",
      OPAS_HANDOFF_FROM_EMAIL: "hello@opas.dev",
      OPAS_HANDOFF_PROVIDER: "cloudflare-email",
      OPAS_HANDOFF_RETENTION_DAYS: "30",
      OPAS_PUBLIC_PROFILE: "opas",
      OPAS_SITE_URL: "https://demo.opas.dev",
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: "opas-mvp",
        database_id: "00000000-0000-4000-8000-000000000001",
        preview_database_id: "DB",
        migrations_dir: "drizzle/sqlite",
      },
    ],
  };
}

function webhookConfig() {
  const config = validConfig();
  const { send_email: _sendEmail, ...target } = config;
  const {
    OPAS_HANDOFF_FROM_EMAIL: _fromEmail,
    ...handoffVars
  } = config.vars;
  void _sendEmail;
  void _fromEmail;
  const vars = {
    ...handoffVars,
    OPAS_HANDOFF_PROVIDER: "webhook",
  };

  return {
    ...target,
    secrets: {
      required: requiredCloudflareSecretNames(vars),
    },
    vars,
  };
}

test("rejects symlinked configs before a bootstrap or remote data command", () => {
  const workspace = mkdtempSync(join(tmpdir(), "opas-config-test-"));
  const target = join(workspace, "target.jsonc");
  writeFileSync(target, `${JSON.stringify(validConfig())}\n`);
  symlinkSync(target, join(workspace, "linked.jsonc"));

  try {
    assert.throws(
      () => readCloudflareTarget("linked.jsonc", workspace),
      /without symbolic-link traversal/,
    );
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("keeps remote data inputs on one validated private snapshot", () => {
  const workspace = mkdtempSync(join(tmpdir(), "opas data snapshot test-"));
  const configPath = join(workspace, "wrangler.jsonc");
  writeFileSync(configPath, `${JSON.stringify(validConfig())}\n`);
  const target = readCloudflareTarget("wrangler.jsonc", workspace);
  const snapshot = prepareCloudflareTargetSnapshot(target, workspace);

  try {
    const changed = validConfig();
    changed.vars.OPAS_GENERATION_MODEL = "changed-after-validation";
    writeFileSync(configPath, `${JSON.stringify(changed)}\n`);
    assert.equal(
      (snapshot.target.config.vars as Record<string, unknown>)
        .OPAS_GENERATION_MODEL,
      validConfig().vars.OPAS_GENERATION_MODEL,
    );
    assert.notEqual(snapshot.target.configPath, target.configPath);
  } finally {
    snapshot.dispose();
    rmSync(workspace, { force: true, recursive: true });
  }
});

function workersDevConfig() {
  const config = validConfig();
  const workerName = "opas-stage-audit";

  return {
    name: workerName,
    account_id: config.account_id,
    main: config.main,
    assets: config.assets,
    services: [
      {
        binding: "WORKER_SELF_REFERENCE",
        service: workerName,
      },
    ],
    ai: config.ai,
    secrets: config.secrets,
    send_email: config.send_email,
    triggers: config.triggers,
    vars: {
      ...config.vars,
      OPAS_SITE_URL: `https://${workerName}.example.workers.dev`,
    },
    d1_databases: [
      {
        ...config.d1_databases[0],
        database_name: workerName,
      },
    ],
  };
}

test("accepts the maintained custom domain with workers.dev fallback", () => {
  const target = validateCloudflareConfig(validConfig());

  assert.equal(target.workerName, "opas-mvp");
  assert.equal(target.databaseName, "opas-mvp");
  assert.equal(target.siteOrigin, "https://demo.opas.dev");
  assert.equal(cloudflareSeedProfile(target), "opas");
});

test("accepts the isolated CROFusion demo target and its branded seed", () => {
  const config = validConfig();
  config.name = "opas-demo-cro";
  config.routes[0].pattern = "demo-cro.opas.dev";
  config.services[0].service = "opas-demo-cro";
  config.vars.OPAS_PUBLIC_PROFILE = "crofusion";
  config.vars.OPAS_SITE_URL = "https://demo-cro.opas.dev";
  config.d1_databases[0].database_name = "opas-demo-cro";

  const target = validateCloudflareConfig(config);

  assert.equal(target.workerName, "opas-demo-cro");
  assert.equal(target.databaseName, "opas-demo-cro");
  assert.equal(target.siteOrigin, "https://demo-cro.opas.dev");
  assert.equal(cloudflareSeedProfile(target), "crofusion");
});

test("runs Cloudflare backfill and seeds through typed native D1 paths", () => {
  const runner = readFileSync("scripts/run-cloudflare.ts", "utf8");
  const data = readFileSync("scripts/cloudflare-data.ts", "utf8");
  const backfill = readFileSync("scripts/backfill-cloudflare.ts", "utf8");
  const seed = readFileSync("scripts/seed-cloudflare.ts", "utf8");
  assert.match(runner, /scripts\/backfill-cloudflare\.ts/u);
  assert.match(runner, /scripts\/seed-cloudflare\.ts/u);
  assert.match(runner, /runCloudflareProcess/u);
  assert.match(
    runner,
    /environment: cloudflareCommandEnvironment\(target\.accountId\)/u,
  );
  assert.match(runner, /localData \? "--local" : "--remote"/u);
  assert.doesNotMatch(runner, /d1["']?,\s*["']execute|--file|seed-d1\.sql/iu);
  assert.match(data, /getPlatformProxy/u);
  assert.match(data, /envFiles: \[\]/u);
  assert.match(data, /remoteBindings: remote/u);
  assert.match(data, /secret-isolated command runner/u);
  assert.doesNotMatch(data, /\bvars\b|send_email|services|assets/u);
  assert.match(backfill, /createD1TeamAuthoringBackfillStore/u);
  assert.match(backfill, /runTeamAuthoringBackfill/u);
  assert.match(seed, /reconcileSqliteDemoSeed/u);
  assert.doesNotMatch(
    `${data}\n${backfill}\n${seed}`,
    /ADMIN_SESSION_SECRET|OPAS_HANDOFF_TO_EMAIL|wrangler["']?,\s*["'](?:dev|deploy)|d1["']?,\s*["']execute|--file|\.sql/iu,
  );
});

test("retains the scoped workers.dev-only bootstrap path", () => {
  const target = validateCloudflareConfig(workersDevConfig());

  assert.equal(
    target.siteOrigin,
    "https://opas-stage-audit.example.workers.dev",
  );
});

test("rejects protected, unrelated, and cross-wired resources", () => {
  const cases = [
    Object.assign(validConfig(), { name: "opas-landing" }),
    Object.assign(validConfig(), { name: "customer-worker" }),
    Object.assign(validConfig(), { account_id: "another-account" }),
    Object.assign(validConfig(), {
      account_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    Object.assign(validConfig(), {
      assets: { binding: "ASSETS", directory: "/tmp/operator-home" },
    }),
    Object.assign(validConfig(), {
      text_blobs: { credentials: "/tmp/operator-home/.env" },
    }),
    Object.assign(validConfig(), {
      build: { command: "node /tmp/injected.cjs" },
    }),
    Object.assign(validConfig(), {
      d1_databases: [
        {
          ...validConfig().d1_databases[0],
          remote: true,
        },
      ],
    }),
    Object.assign(validConfig(), {
      services: [
        validConfig().services[0],
        { binding: "LANDING", service: "opas-landing", remote: true },
      ],
    }),
    Object.assign(validConfig(), {
      d1_databases: [
        {
          binding: "DB",
          database_name: "opas-mvp",
          database_id: "unrelated-resource-id",
          preview_database_id: "DB",
          migrations_dir: "drizzle/sqlite",
        },
      ],
    }),
    Object.assign(validConfig(), { workers_dev: false }),
    Object.assign(validConfig(), {
      vars: {
        OPAS_DATABASE_DRIVER: "d1",
        OPAS_SITE_URL: "https://example.com",
      },
    }),
    Object.assign(validConfig(), {
      d1_databases: [
        {
          binding: "DB",
          database_name: "opas-another-database",
          database_id: "00000000-0000-4000-8000-000000000001",
          preview_database_id: "DB",
          migrations_dir: "drizzle/sqlite",
        },
      ],
    }),
    Object.assign(validConfig(), {
      d1_databases: [
        {
          binding: "DB",
          database_name: "opas-mvp",
          database_id: "00000000-0000-4000-8000-000000000001",
          preview_database_id: "DB",
          migrations_dir: "drizzle/another-directory",
        },
      ],
    }),
  ];

  for (const config of cases) {
    assert.throws(() => validateCloudflareConfig(config));
  }
});

test("requires the scheduled custom Worker and fixed Workers AI binding", () => {
  const cases = [
    Object.assign(validConfig(), { main: ".open-next/worker.js" }),
    Object.assign(validConfig(), { ai: undefined }),
    Object.assign(validConfig(), { ai: { binding: "ANOTHER_AI" } }),
    Object.assign(validConfig(), { triggers: undefined }),
    Object.assign(validConfig(), { triggers: { crons: [] } }),
    Object.assign(validConfig(), { triggers: { crons: ["*/5 * * * *"] } }),
    Object.assign(validConfig(), { triggers: { crons: ["* * * * *"] } }),
    Object.assign(validConfig(), {
      triggers: { crons: ["15 0 * * *", "* * * * *"] },
    }),
  ];

  for (const config of cases) {
    assert.throws(() => validateCloudflareConfig(config));
  }
});

test("requires one fixed support email binding and a secret-only destination", () => {
  const secretVariableCases = [
    "ADMIN_SESSION_SECRET",
    "OPAS_PREVIEW_SIGNING_SECRET",
    "OPAS_HANDOFF_TO_EMAIL",
  ].map((name) =>
    Object.assign(validConfig(), {
      vars: {
        ...validConfig().vars,
        [name]: "must-remain-encrypted",
      },
    }),
  );
  const cases = [
    Object.assign(validConfig(), { send_email: undefined }),
    Object.assign(validConfig(), {
      send_email: [
        {
          name: "ANOTHER_EMAIL",
          allowed_sender_addresses: ["hello@opas.dev"],
        },
      ],
    }),
    Object.assign(validConfig(), {
      send_email: [
        {
          name: "SUPPORT_EMAIL",
          allowed_sender_addresses: ["attacker@example.com"],
        },
      ],
    }),
    Object.assign(validConfig(), {
      vars: {
        ...validConfig().vars,
        OPAS_GENERATION_FALLBACK_API_KEY: "must-remain-encrypted",
      },
    }),
    ...secretVariableCases,
  ];

  for (const config of cases) {
    assert.throws(() => validateCloudflareConfig(config));
  }
});

test("accepts only an encrypted authenticated webhook without email bindings", () => {
  const config = webhookConfig();
  assert.deepEqual(validateCloudflareConfig(config).secretNames, [
    "ADMIN_SESSION_SECRET",
    "OPAS_PREVIEW_SIGNING_SECRET",
    "OPAS_HANDOFF_WEBHOOK_URL",
    "OPAS_HANDOFF_WEBHOOK_TOKEN",
  ]);

  const cases = [
    Object.assign(webhookConfig(), { send_email: validConfig().send_email }),
    Object.assign(webhookConfig(), {
      vars: {
        ...webhookConfig().vars,
        OPAS_HANDOFF_FROM_EMAIL: "hello@opas.dev",
      },
    }),
    Object.assign(webhookConfig(), {
      vars: {
        ...webhookConfig().vars,
        OPAS_HANDOFF_WEBHOOK_URL: "https://hooks.example.com/opas",
      },
    }),
    Object.assign(webhookConfig(), {
      vars: {
        ...webhookConfig().vars,
        OPAS_HANDOFF_WEBHOOK_TOKEN: "must-remain-encrypted",
      },
    }),
    Object.assign(webhookConfig(), {
      secrets: { required: requiredCloudflareSecretNames() },
    }),
  ];

  for (const candidate of cases) {
    assert.throws(() => validateCloudflareConfig(candidate));
  }
});

test("requires the exact secret names for base and fallback deployments", () => {
  const base = validConfig();
  assert.deepEqual(
    validateCloudflareConfig(base).secretNames,
    requiredCloudflareSecretNames(),
  );

  for (const required of [
    requiredCloudflareSecretNames().slice(1),
    [...requiredCloudflareSecretNames(), "STALE_SECRET"],
    [...requiredCloudflareSecretNames()].reverse(),
  ]) {
    assert.throws(() =>
      validateCloudflareConfig(
        Object.assign(validConfig(), { secrets: { required } }),
      ),
    );
  }
});

test("validates the support destination with the encrypted deployment secrets", () => {
  const environment = {
    ADMIN_SESSION_SECRET: "s".repeat(32),
    OPAS_PREVIEW_SIGNING_SECRET: "p".repeat(32),
    OPAS_HANDOFF_TO_EMAIL: "support@example.com",
  };
  assert.deepEqual(validateCloudflareSecrets(environment), environment);

  for (const destination of [
    "",
    "support@localhost",
    "support@example.com\r\nBcc: attacker@example.com",
  ]) {
    assert.throws(() =>
      validateCloudflareSecrets({
        ...environment,
        OPAS_HANDOFF_TO_EMAIL: destination,
      }),
    );
  }

  assert.throws(() =>
    validateCloudflareSecrets({
      ...environment,
      OPAS_HANDOFF_WEBHOOK_TOKEN: "w".repeat(32),
      OPAS_HANDOFF_WEBHOOK_URL: "https://hooks.example.com/opas",
    }),
  );
});

test("validates authenticated webhook values as encrypted deployment secrets", () => {
  const config = webhookConfig();
  const environment = {
    ADMIN_SESSION_SECRET: "s".repeat(32),
    OPAS_PREVIEW_SIGNING_SECRET: "p".repeat(32),
    OPAS_HANDOFF_WEBHOOK_TOKEN: "w".repeat(32),
    OPAS_HANDOFF_WEBHOOK_URL: "https://hooks.example.com/opas",
  };
  assert.deepEqual(validateCloudflareSecrets(environment, config.vars), environment);

  for (const values of [
    { OPAS_HANDOFF_WEBHOOK_URL: "http://hooks.example.com/opas" },
    { OPAS_HANDOFF_WEBHOOK_URL: "https://localhost/opas" },
    { OPAS_HANDOFF_WEBHOOK_URL: "https://hooks.example.com/opas?secret=value" },
    { OPAS_HANDOFF_WEBHOOK_TOKEN: "" },
    { OPAS_HANDOFF_WEBHOOK_TOKEN: "too-short" },
    { OPAS_HANDOFF_TO_EMAIL: "support@example.com" },
  ]) {
    assert.throws(() =>
      validateCloudflareSecrets({ ...environment, ...values }, config.vars),
    );
  }
});

test("keeps opt-in Cloudflare fallback credentials in encrypted secrets", () => {
  const config = validConfig();
  Object.assign(config.vars, {
    OPAS_ANSWER_FALLBACK_INPUT_MICRODOLLARS_PER_MILLION_TOKENS: "400000",
    OPAS_ANSWER_FALLBACK_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS: "600000",
    OPAS_ANSWER_LEASE_MILLISECONDS: "65000",
    OPAS_GENERATION_FALLBACK_ENABLED: "true",
    OPAS_GENERATION_FALLBACK_MODEL: "portable-fallback-v1",
    OPAS_GENERATION_FALLBACK_PROVIDER: "openai-compatible",
    OPAS_GENERATION_FALLBACK_RETENTION_DISCLOSURE:
      "The fallback provider does not retain requests.",
  });
  config.secrets.required = requiredCloudflareSecretNames(config.vars);
  assert.doesNotThrow(() => validateCloudflareConfig(config));
  assert.deepEqual(
    validateCloudflareConfig(config).secretNames,
    requiredCloudflareSecretNames(config.vars),
  );

  const environment = {
    ADMIN_SESSION_SECRET: "s".repeat(32),
    OPAS_PREVIEW_SIGNING_SECRET: "p".repeat(32),
    OPAS_GENERATION_FALLBACK_API_KEY: "fallback-private-key",
    OPAS_GENERATION_FALLBACK_ENDPOINT:
      "https://fallback.example.com/v1/chat/completions",
    OPAS_HANDOFF_TO_EMAIL: "support@example.com",
  };
  assert.deepEqual(validateCloudflareSecrets(environment, config.vars), {
    ADMIN_SESSION_SECRET: "s".repeat(32),
    OPAS_PREVIEW_SIGNING_SECRET: "p".repeat(32),
    OPAS_GENERATION_FALLBACK_API_KEY: "fallback-private-key",
    OPAS_GENERATION_FALLBACK_ENDPOINT:
      "https://fallback.example.com/v1/chat/completions",
    OPAS_HANDOFF_TO_EMAIL: "support@example.com",
  });
  assert.throws(() =>
    validateCloudflareSecrets(
      { ...environment, OPAS_GENERATION_FALLBACK_ENDPOINT: "" },
      config.vars,
    ),
  );
});

test("requires valid Cloudflare answer variables and validates optional topic rules", () => {
  const validTopicRules = validConfig();
  (validTopicRules.vars as Record<string, string>).OPAS_ANSWER_TOPIC_GUARDRAILS = JSON.stringify({
    allow: ["account help"],
    deny: ["internal operations"],
  });
  assert.doesNotThrow(() => validateCloudflareConfig(validTopicRules));

  const missingGateway = validConfig();
  delete (missingGateway.vars as Record<string, unknown>)
    .OPAS_GENERATION_GATEWAY_ID;
  const missingModel = validConfig();
  delete (missingModel.vars as Record<string, unknown>).OPAS_GENERATION_MODEL;
  const missingAdmission = validConfig();
  delete (missingAdmission.vars as Record<string, unknown>)
    .OPAS_ANSWER_DAILY_BUDGET_MICRODOLLARS;
  const cases = [
    missingGateway,
    missingModel,
    missingAdmission,
    Object.assign(validConfig(), {
      vars: {
        ...validConfig().vars,
        OPAS_GENERATION_GATEWAY_ID: "Default Gateway",
      },
    }),
    Object.assign(validConfig(), {
      vars: {
        ...validConfig().vars,
        OPAS_GENERATION_RETENTION_DISCLOSURE: "",
      },
    }),
    Object.assign(validConfig(), {
      vars: {
        ...validConfig().vars,
        OPAS_ANSWER_MAXIMUM_CONCURRENCY: "4.0",
      },
    }),
    Object.assign(validConfig(), {
      vars: {
        ...validConfig().vars,
        OPAS_ANSWER_DAILY_BUDGET_MICRODOLLARS: "1",
      },
    }),
    Object.assign(validConfig(), {
      vars: {
        ...validConfig().vars,
        OPAS_ANSWER_TOPIC_GUARDRAILS: "not-json",
      },
    }),
    Object.assign(validConfig(), {
      vars: {
        ...validConfig().vars,
        OPAS_ANSWER_TOPIC_GUARDRAILS: "",
      },
    }),
  ];

  for (const config of cases) {
    assert.throws(() => validateCloudflareConfig(config));
  }
});

test("rejects protected and unrelated custom routes", () => {
  const routes = [
    { pattern: "opas.dev", custom_domain: true },
    { pattern: "www.opas.dev", custom_domain: true },
    { pattern: "*.opas.dev", custom_domain: true },
    { pattern: "mvp.opas.dev", custom_domain: true },
    { pattern: "demo.opas.dev/*", custom_domain: false },
    {
      pattern: "demo.opas.dev",
      custom_domain: true,
      zone_name: "opas.dev",
    },
  ];

  for (const route of routes) {
    assert.throws(() =>
      validateCloudflareConfig(Object.assign(validConfig(), { routes: [route] })),
    );
  }

  assert.throws(() =>
    validateCloudflareConfig(
      Object.assign(validConfig(), {
        routes: [
          { pattern: "demo.opas.dev", custom_domain: true },
          { pattern: "another.opas.dev", custom_domain: true },
        ],
      }),
    ),
  );
  assert.throws(() =>
    validateCloudflareConfig(Object.assign(validConfig(), { route: "demo.opas.dev/*" })),
  );
});

test("keeps each maintained demo domain paired with its Worker and public profile", () => {
  const wrongWorker = validConfig();
  wrongWorker.routes[0].pattern = "demo-cro.opas.dev";

  const wrongProfile = validConfig();
  wrongProfile.vars.OPAS_PUBLIC_PROFILE = "crofusion";

  const unknownProfile = validConfig();
  unknownProfile.vars.OPAS_PUBLIC_PROFILE = "customer";

  for (const config of [wrongWorker, wrongProfile, unknownProfile]) {
    assert.throws(() => validateCloudflareConfig(config));
  }
});

test("limits the maintained custom domain to its exact account and Worker", () => {
  const missingRoute = validConfig();
  delete (missingRoute as Partial<typeof missingRoute>).routes;
  assert.throws(() => validateCloudflareConfig(missingRoute));
  assert.throws(() =>
    validateCloudflareConfig(
      Object.assign(validConfig(), { account_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    ),
  );
  assert.throws(() =>
    validateCloudflareConfig(Object.assign(validConfig(), { name: "opas-another-worker" })),
  );
  assert.throws(() =>
    validateCloudflareConfig(Object.assign(validConfig(), { preview_urls: true })),
    /preview URLs disabled/,
  );
  const defaultPreviewUrls = validConfig();
  delete (defaultPreviewUrls as Partial<typeof defaultPreviewUrls>).preview_urls;
  assert.throws(
    () => validateCloudflareConfig(defaultPreviewUrls),
    /preview URLs disabled/,
  );
});

test("rejects non-production origins and mismatched self references", () => {
  const httpConfig = validConfig();
  httpConfig.vars.OPAS_SITE_URL = "http://demo.opas.dev";
  assert.throws(() => validateCloudflareConfig(httpConfig), /HTTPS origin/);

  const selfReferenceConfig = validConfig();
  selfReferenceConfig.services[0].service = "opas-another-worker";
  assert.throws(
    () => validateCloudflareConfig(selfReferenceConfig),
    /WORKER_SELF_REFERENCE/,
  );
});
