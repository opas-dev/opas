// ABOUTME: Creates and deploys one guarded OPAS Worker and matching D1 database.
// ABOUTME: Rejects configs that could mutate protected or unrelated Cloudflare resources.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { createGenerationAdapter } from "../src/ai/generation-config";
import { maximumAnswerOutputTokens } from "../src/answers/answer";
import { createAnswerAdmissionPolicy } from "../src/answers/admission";
import { createAnswerGuardrails } from "../src/answers/guardrails";
import { createCloudflareWebhookDelivery } from "../src/handoff/delivery";
import { normalizeHandoffEmailAddress } from "../src/handoff/payload";
import { configuredHandoffRetentionDays } from "../src/handoff/retention";
import { createHandoffWriteAdmission } from "../src/outcomes/admission";
import { createConversationAnalyticsPolicy } from "../src/outcomes/records";
import { embedParentOrigins } from "../src/embed/config";
import {
  cloudflareBuildEnvironment,
  prepareCloudflareBuild,
  prepareCloudflareProject,
  registerCloudflareCleanup,
  runBuiltCloudflareCommand,
  sanitizedCloudflareEnvironment,
} from "./cloudflare-artifact";
import { runCloudflareProcess } from "./cloudflare-process";

const protectedWorkerName = "opas-landing";
const maintainedAccountId = "f8801c7e8853a113a25f8b52fd9ceec1";
const maintainedCustomDomain = "demo.opas.dev";
const maintainedWorkerName = "opas-mvp";
const opasResourcePattern = /^opas-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const cloudflareAccountPattern = /^[a-f0-9]{32}$/;
const cloudflareDatabaseIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const allowedCloudflareConfigKeys = new Set([
  "$schema",
  "account_id",
  "ai",
  "assets",
  "compatibility_date",
  "compatibility_flags",
  "d1_databases",
  "main",
  "name",
  "observability",
  "preview_urls",
  "routes",
  "secrets",
  "send_email",
  "services",
  "triggers",
  "vars",
  "workers_dev",
]);
const allowedCloudflareVariableNames = new Set([
  "NEXTJS_ENV",
  "OPAS_ANALYTICS_REDACTION_PATTERNS",
  "OPAS_ANSWER_ANALYTICS_RETENTION_DAYS",
  "OPAS_ANSWER_DAILY_BUDGET_MICRODOLLARS",
  "OPAS_ANSWER_FALLBACK_INPUT_MICRODOLLARS_PER_MILLION_TOKENS",
  "OPAS_ANSWER_FALLBACK_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS",
  "OPAS_ANSWER_INPUT_MICRODOLLARS_PER_MILLION_TOKENS",
  "OPAS_ANSWER_LEASE_MILLISECONDS",
  "OPAS_ANSWER_MAXIMUM_CONCURRENCY",
  "OPAS_ANSWER_MAXIMUM_INPUT_TOKENS",
  "OPAS_ANSWER_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS",
  "OPAS_ANSWER_TOPIC_GUARDRAILS",
  "OPAS_DATABASE_DRIVER",
  "OPAS_EMBED_PARENT_ORIGINS",
  "OPAS_GENERATION_FALLBACK_ENABLED",
  "OPAS_GENERATION_FALLBACK_GATEWAY_ID",
  "OPAS_GENERATION_FALLBACK_MODEL",
  "OPAS_GENERATION_FALLBACK_PROVIDER",
  "OPAS_GENERATION_FALLBACK_RETENTION_DISCLOSURE",
  "OPAS_GENERATION_GATEWAY_ID",
  "OPAS_GENERATION_MODEL",
  "OPAS_GENERATION_RETENTION_DISCLOSURE",
  "OPAS_HANDOFF_DAILY_LIMIT",
  "OPAS_HANDOFF_FROM_EMAIL",
  "OPAS_HANDOFF_PROVIDER",
  "OPAS_HANDOFF_RETENTION_DAYS",
  "OPAS_SITE_URL",
]);

type JsonObject = Record<string, unknown>;

type D1Database = {
  name: string;
  uuid: string;
};

export type CloudflareTarget = {
  accountId: string;
  config: JsonObject;
  configPath: string;
  databaseId: string | undefined;
  databaseName: string;
  siteOrigin: string;
  secretNames: readonly string[];
  sourcePrefix: string;
  workerName: string;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }

  return value;
}

function requireOpasResource(value: unknown, field: string) {
  const name = requireString(value, field);

  if (!opasResourcePattern.test(name) || name === protectedWorkerName) {
    throw new Error(
      `${field} must be an opas-* resource and cannot be ${protectedWorkerName}.`,
    );
  }

  return name;
}

const cloudflareAdminSecretNames = [
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "ADMIN_SESSION_SECRET",
] as const;
const cloudflareEmailSecretNames = ["OPAS_HANDOFF_TO_EMAIL"] as const;
const cloudflareWebhookSecretNames = [
  "OPAS_HANDOFF_WEBHOOK_URL",
  "OPAS_HANDOFF_WEBHOOK_TOKEN",
] as const;

function cloudflareHandoffSecretNames(vars: Readonly<Record<string, unknown>>) {
  const provider = vars.OPAS_HANDOFF_PROVIDER ?? "cloudflare-email";
  if (provider === "cloudflare-email") return cloudflareEmailSecretNames;
  if (provider === "webhook") return cloudflareWebhookSecretNames;
  throw new Error("vars.OPAS_HANDOFF_PROVIDER must select a supported provider.");
}

export function requiredCloudflareSecretNames(
  vars: Readonly<Record<string, unknown>> = {},
) {
  return [
    ...cloudflareAdminSecretNames,
    ...cloudflareHandoffSecretNames(vars),
    ...(vars.OPAS_GENERATION_FALLBACK_ENABLED === "true"
      ? [
          "OPAS_GENERATION_FALLBACK_API_KEY",
          "OPAS_GENERATION_FALLBACK_ENDPOINT",
        ]
      : []),
  ];
}

function validateRequiredSecrets(config: JsonObject, vars: JsonObject) {
  const requiredNames = requiredCloudflareSecretNames(vars);
  const secrets = config.secrets;
  if (
    !isObject(secrets) ||
    Object.keys(secrets).length !== 1 ||
    !Array.isArray(secrets.required) ||
    !isDeepStrictEqual(secrets.required, requiredNames)
  ) {
    throw new Error(
      "secrets.required must declare the exact canonical OPAS secret names.",
    );
  }
  return requiredNames;
}

function validateRouting(config: JsonObject, accountId: string, workerName: string) {
  if ("route" in config) {
    throw new Error("Singular Worker routes are not permitted.");
  }

  if (!("routes" in config)) {
    if (
      accountId === maintainedAccountId &&
      workerName === maintainedWorkerName
    ) {
      throw new Error(
        `The maintained ${maintainedWorkerName} Worker must keep ${maintainedCustomDomain}.`,
      );
    }
    if (config.workers_dev === false) {
      throw new Error("workers.dev must remain enabled.");
    }

    return undefined;
  }

  const routes = config.routes;
  const route = Array.isArray(routes) && routes.length === 1 ? routes[0] : undefined;
  const routeKeys = isObject(route) ? Object.keys(route).sort() : [];
  const isMaintainedRoute =
    accountId === maintainedAccountId &&
    workerName === maintainedWorkerName &&
    config.workers_dev === true &&
    config.preview_urls === false &&
    isObject(route) &&
    route.pattern === maintainedCustomDomain &&
    route.custom_domain === true &&
    routeKeys.length === 2 &&
    routeKeys[0] === "custom_domain" &&
    routeKeys[1] === "pattern";

  if (!isMaintainedRoute) {
    throw new Error(
      `Custom routing is limited to ${maintainedCustomDomain} on the maintained ${maintainedWorkerName} Worker, with workers.dev enabled and preview URLs disabled.`,
    );
  }

  return maintainedCustomDomain;
}

function validateSiteOrigin(
  value: unknown,
  workerName: string,
  customDomain: string | undefined,
) {
  const configuredOrigin = requireString(value, "vars.OPAS_SITE_URL");
  let siteUrl: URL;

  try {
    siteUrl = new URL(configuredOrigin);
  } catch {
    throw new Error("vars.OPAS_SITE_URL must be a valid HTTPS origin.");
  }

  const hasExpectedHostname = customDomain
    ? siteUrl.hostname === customDomain
    : siteUrl.hostname.startsWith(`${workerName}.`) &&
      siteUrl.hostname.endsWith(".workers.dev");

  if (
    siteUrl.protocol !== "https:" ||
    siteUrl.username !== "" ||
    siteUrl.password !== "" ||
    siteUrl.pathname !== "/" ||
    siteUrl.search !== "" ||
    siteUrl.hash !== "" ||
    siteUrl.origin !== configuredOrigin ||
    !hasExpectedHostname
  ) {
    throw new Error("vars.OPAS_SITE_URL must be an exact HTTPS origin.");
  }

  return siteUrl.origin;
}

function validateAnswerConfiguration(vars: JsonObject) {
  const topicConfiguration = vars.OPAS_ANSWER_TOPIC_GUARDRAILS;
  if (
    topicConfiguration !== undefined &&
    (typeof topicConfiguration !== "string" || topicConfiguration === "")
  ) {
    throw new Error(
      "vars.OPAS_ANSWER_TOPIC_GUARDRAILS must be omitted or contain valid topic rules.",
    );
  }
  if (
    createAnswerGuardrails(topicConfiguration as string | undefined).status !==
    "ready"
  ) {
    throw new Error(
      "vars.OPAS_ANSWER_TOPIC_GUARDRAILS must be omitted or contain valid topic rules.",
    );
  }

  createAnswerAdmissionPolicy(
    {
      OPAS_ANSWER_DAILY_BUDGET_MICRODOLLARS: requireString(
        vars.OPAS_ANSWER_DAILY_BUDGET_MICRODOLLARS,
        "vars.OPAS_ANSWER_DAILY_BUDGET_MICRODOLLARS",
      ),
      OPAS_ANSWER_INPUT_MICRODOLLARS_PER_MILLION_TOKENS: requireString(
        vars.OPAS_ANSWER_INPUT_MICRODOLLARS_PER_MILLION_TOKENS,
        "vars.OPAS_ANSWER_INPUT_MICRODOLLARS_PER_MILLION_TOKENS",
      ),
      OPAS_ANSWER_LEASE_MILLISECONDS: requireString(
        vars.OPAS_ANSWER_LEASE_MILLISECONDS,
        "vars.OPAS_ANSWER_LEASE_MILLISECONDS",
      ),
      OPAS_ANSWER_MAXIMUM_CONCURRENCY: requireString(
        vars.OPAS_ANSWER_MAXIMUM_CONCURRENCY,
        "vars.OPAS_ANSWER_MAXIMUM_CONCURRENCY",
      ),
      OPAS_ANSWER_MAXIMUM_INPUT_TOKENS: requireString(
        vars.OPAS_ANSWER_MAXIMUM_INPUT_TOKENS,
        "vars.OPAS_ANSWER_MAXIMUM_INPUT_TOKENS",
      ),
      OPAS_ANSWER_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS: requireString(
        vars.OPAS_ANSWER_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS,
        "vars.OPAS_ANSWER_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS",
      ),
      OPAS_ANSWER_FALLBACK_INPUT_MICRODOLLARS_PER_MILLION_TOKENS:
        typeof vars.OPAS_ANSWER_FALLBACK_INPUT_MICRODOLLARS_PER_MILLION_TOKENS ===
        "string"
          ? vars.OPAS_ANSWER_FALLBACK_INPUT_MICRODOLLARS_PER_MILLION_TOKENS
          : undefined,
      OPAS_ANSWER_FALLBACK_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS:
        typeof vars.OPAS_ANSWER_FALLBACK_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS ===
        "string"
          ? vars.OPAS_ANSWER_FALLBACK_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS
          : undefined,
      OPAS_GENERATION_FALLBACK_ENABLED:
        typeof vars.OPAS_GENERATION_FALLBACK_ENABLED === "string"
          ? vars.OPAS_GENERATION_FALLBACK_ENABLED
          : undefined,
    },
    maximumAnswerOutputTokens,
  );

  const fallbackEnabled = vars.OPAS_GENERATION_FALLBACK_ENABLED;
  if (
    fallbackEnabled !== undefined &&
    fallbackEnabled !== "false" &&
    fallbackEnabled !== "true"
  ) {
    throw new Error("vars.OPAS_GENERATION_FALLBACK_ENABLED must be true or false.");
  }
  const optionalFallbackValue = (name: string) => {
    const value = vars[name];
    if (value === undefined) return undefined;
    return requireString(value, `vars.${name}`);
  };
  const fallbackEnvironment = {
    OPAS_GENERATION_FALLBACK_ENABLED:
      fallbackEnabled as string | undefined,
    OPAS_GENERATION_FALLBACK_GATEWAY_ID: optionalFallbackValue(
      "OPAS_GENERATION_FALLBACK_GATEWAY_ID",
    ),
    OPAS_GENERATION_FALLBACK_MODEL: optionalFallbackValue(
      "OPAS_GENERATION_FALLBACK_MODEL",
    ),
    OPAS_GENERATION_FALLBACK_PROVIDER: optionalFallbackValue(
      "OPAS_GENERATION_FALLBACK_PROVIDER",
    ),
    OPAS_GENERATION_FALLBACK_RETENTION_DISCLOSURE: optionalFallbackValue(
      "OPAS_GENERATION_FALLBACK_RETENTION_DISCLOSURE",
    ),
    ...(fallbackEnabled === "true"
      ? {
          OPAS_GENERATION_FALLBACK_API_KEY: "validated-at-secret-upload",
          OPAS_GENERATION_FALLBACK_ENDPOINT:
            "https://fallback.invalid/v1/chat/completions",
        }
      : {}),
  };

  createGenerationAdapter({
    environment: {
      OPAS_DATABASE_DRIVER: "d1",
      OPAS_GENERATION_GATEWAY_ID: requireString(
        vars.OPAS_GENERATION_GATEWAY_ID,
        "vars.OPAS_GENERATION_GATEWAY_ID",
      ),
      OPAS_GENERATION_MODEL: requireString(
        vars.OPAS_GENERATION_MODEL,
        "vars.OPAS_GENERATION_MODEL",
      ),
      OPAS_GENERATION_RETENTION_DISCLOSURE: requireString(
        vars.OPAS_GENERATION_RETENTION_DISCLOSURE,
        "vars.OPAS_GENERATION_RETENTION_DISCLOSURE",
      ),
      ...fallbackEnvironment,
    },
    workersAiBinding: {
      async run() {
        throw new Error("Cloudflare answer validation does not run inference.");
      },
    } as never,
  });
}

function validateHandoffConfiguration(config: JsonObject, vars: JsonObject) {
  const provider = vars.OPAS_HANDOFF_PROVIDER;
  if (provider === "cloudflare-email") {
    const bindings = config.send_email;
    const binding = Array.isArray(bindings) && bindings.length === 1
      ? bindings[0]
      : undefined;
    if (
      !isObject(binding) ||
      binding.name !== "SUPPORT_EMAIL" ||
      !Array.isArray(binding.allowed_sender_addresses) ||
      binding.allowed_sender_addresses.length !== 1 ||
      binding.allowed_sender_addresses[0] !== "hello@opas.dev" ||
      Object.keys(binding).sort().join(",") !==
        "allowed_sender_addresses,name"
    ) {
      throw new Error(
        "send_email must expose one SUPPORT_EMAIL binding limited to hello@opas.dev.",
      );
    }
    if (
      vars.OPAS_HANDOFF_FROM_EMAIL !== "hello@opas.dev" ||
      "OPAS_HANDOFF_TO_EMAIL" in vars
    ) {
      throw new Error(
        "Cloudflare email handoff must use the fixed binding and a secret destination.",
      );
    }
  } else if (provider === "webhook") {
    if ("send_email" in config || "OPAS_HANDOFF_FROM_EMAIL" in vars) {
      throw new Error(
        "Cloudflare webhook handoff cannot include email delivery configuration.",
      );
    }
  } else {
    throw new Error("vars.OPAS_HANDOFF_PROVIDER must select a supported provider.");
  }
  createHandoffWriteAdmission({
    environment: {
      OPAS_HANDOFF_DAILY_LIMIT: requireString(
        vars.OPAS_HANDOFF_DAILY_LIMIT,
        "vars.OPAS_HANDOFF_DAILY_LIMIT",
      ),
    },
    store: {
      async cleanup() {
        return 0;
      },
      async consumeOutcomeWindow() {
        return true;
      },
      async reserve() {
        return { accepted: true as const };
      },
    },
    workspaceId: "workspace_demo",
  });
  if (
    configuredHandoffRetentionDays({
      OPAS_HANDOFF_RETENTION_DAYS: requireString(
        vars.OPAS_HANDOFF_RETENTION_DAYS,
        "vars.OPAS_HANDOFF_RETENTION_DAYS",
      ),
    }) === null
  ) {
    throw new Error("vars.OPAS_HANDOFF_RETENTION_DAYS must be between 1 and 365.");
  }
}

function validateAnalyticsConfiguration(vars: JsonObject) {
  const policy = createConversationAnalyticsPolicy({
    OPAS_ANALYTICS_REDACTION_PATTERNS: requireString(
      vars.OPAS_ANALYTICS_REDACTION_PATTERNS,
      "vars.OPAS_ANALYTICS_REDACTION_PATTERNS",
    ),
    OPAS_ANSWER_ANALYTICS_RETENTION_DAYS: requireString(
      vars.OPAS_ANSWER_ANALYTICS_RETENTION_DAYS,
      "vars.OPAS_ANSWER_ANALYTICS_RETENTION_DAYS",
    ),
  });
  if (policy.status === "unavailable") {
    throw new Error("Cloudflare analytics privacy configuration is invalid.");
  }
}

function validateEmbedConfiguration(vars: JsonObject) {
  const configured = vars.OPAS_EMBED_PARENT_ORIGINS;
  if (configured !== undefined && typeof configured !== "string") {
    throw new Error("vars.OPAS_EMBED_PARENT_ORIGINS must be a string.");
  }
  embedParentOrigins(configured as string | undefined);
}

export function validateCloudflareConfig(
  config: unknown,
  configPath = "wrangler.jsonc",
): CloudflareTarget {
  if (!isObject(config)) {
    throw new Error("Wrangler config must contain a JSON object.");
  }
  const unsupportedKeys = Object.keys(config).filter(
    (key) => !allowedCloudflareConfigKeys.has(key),
  );
  if (unsupportedKeys.length > 0) {
    throw new Error(
      `Wrangler config contains unsupported fields: ${unsupportedKeys.sort().join(", ")}.`,
    );
  }

  const workerName = requireOpasResource(config.name, "name");
  const accountId = requireString(config.account_id, "account_id");

  if (
    !cloudflareAccountPattern.test(accountId) ||
    accountId !== maintainedAccountId
  ) {
    throw new Error("account_id must identify the maintained DevPlant account.");
  }

  const customDomain = validateRouting(config, accountId, workerName);

  if (config.main !== "custom-worker.ts") {
    throw new Error("main must use the scheduled OPAS custom Worker entry point.");
  }

  if (
    !isObject(config.assets) ||
    config.assets.binding !== "ASSETS" ||
    config.assets.directory !== ".open-next/assets" ||
    Object.keys(config.assets).sort().join(",") !== "binding,directory" ||
    ["site", "wasm_modules", "text_blobs", "data_blobs"].some(
      (field) => field in config,
    )
  ) {
    throw new Error(
      "assets must use only the generated .open-next/assets directory and ASSETS binding.",
    );
  }

  if (
    !isObject(config.ai) ||
    config.ai.binding !== "AI" ||
    Object.keys(config.ai).length !== 1
  ) {
    throw new Error("ai must expose the single fixed Workers AI binding.");
  }

  if (
    !isObject(config.triggers) ||
    !Array.isArray(config.triggers.crons) ||
    config.triggers.crons.length !== 2 ||
    config.triggers.crons[0] !== "* * * * *" ||
    config.triggers.crons[1] !== "15 0 * * *" ||
    Object.keys(config.triggers).length !== 1
  ) {
    throw new Error(
      "triggers must run minute embedding recovery and daily analytics cleanup.",
    );
  }

  if (!isObject(config.vars) || config.vars.OPAS_DATABASE_DRIVER !== "d1") {
    throw new Error("vars.OPAS_DATABASE_DRIVER must be d1.");
  }
  const unsupportedVariables = Object.keys(config.vars).filter(
    (name) => !allowedCloudflareVariableNames.has(name),
  );
  if (unsupportedVariables.length > 0) {
    throw new Error(
      `Cloudflare vars contain secret or unsupported names: ${unsupportedVariables.sort().join(", ")}.`,
    );
  }
  if (
    config.vars.NEXTJS_ENV !== undefined &&
    config.vars.NEXTJS_ENV !== "production"
  ) {
    throw new Error("vars.NEXTJS_ENV must be production when configured.");
  }

  validateAnswerConfiguration(config.vars);
  validateAnalyticsConfiguration(config.vars);
  validateEmbedConfiguration(config.vars);
  validateHandoffConfiguration(config, config.vars);
  const secretNames = validateRequiredSecrets(config, config.vars);

  const siteOrigin = validateSiteOrigin(
    config.vars.OPAS_SITE_URL,
    workerName,
    customDomain,
  );
  const databases = config.d1_databases;

  if (!Array.isArray(databases) || databases.length !== 1 || !isObject(databases[0])) {
    throw new Error("d1_databases must contain exactly one OPAS database binding.");
  }

  const database = databases[0];
  const databaseName = requireOpasResource(database.database_name, "database_name");
  const databaseId = database.database_id;
  const databaseKeys = Object.keys(database);
  const allowedDatabaseKeys = new Set([
    "binding",
    "database_id",
    "database_name",
    "migrations_dir",
    "preview_database_id",
  ]);

  if (
    database.binding !== "DB" ||
    databaseName !== workerName ||
    database.migrations_dir !== "drizzle/sqlite" ||
    database.preview_database_id !== "DB" ||
    databaseKeys.some((key) => !allowedDatabaseKeys.has(key)) ||
    (databaseId !== undefined &&
      (typeof databaseId !== "string" ||
        !cloudflareDatabaseIdPattern.test(databaseId)))
  ) {
    throw new Error("The DB binding, D1 database, and Worker must form one exact OPAS target.");
  }

  const services = config.services;
  const service = Array.isArray(services) && services.length === 1
    ? services[0]
    : undefined;
  const hasSelfReference =
    isObject(service) &&
    service.binding === "WORKER_SELF_REFERENCE" &&
    service.service === workerName &&
    Object.keys(service).sort().join(",") === "binding,service";

  if (!hasSelfReference) {
    throw new Error("WORKER_SELF_REFERENCE must point to the same OPAS Worker.");
  }

  return {
    accountId,
    config,
    configPath,
    databaseId: typeof databaseId === "string" ? databaseId : undefined,
    databaseName,
    siteOrigin,
    secretNames,
    sourcePrefix: "",
    workerName,
  };
}

export function readCloudflareTarget(
  configPath: string,
  workspaceRoot = process.cwd(),
): CloudflareTarget {
  const absoluteConfigPath = resolve(workspaceRoot, configPath);
  const workspaceRelativePath = relative(workspaceRoot, absoluteConfigPath);

  if (
    workspaceRelativePath === "" ||
    workspaceRelativePath.startsWith("..") ||
    isAbsolute(workspaceRelativePath)
  ) {
    throw new Error("Cloudflare config must be a file inside the current workspace.");
  }
  if (
    !existsSync(absoluteConfigPath) ||
    lstatSync(absoluteConfigPath).isSymbolicLink() ||
    !lstatSync(absoluteConfigPath).isFile() ||
    realpathSync(absoluteConfigPath) !==
      resolve(realpathSync(workspaceRoot), workspaceRelativePath)
  ) {
    throw new Error(
      "Cloudflare config must be a regular file without symbolic-link traversal.",
    );
  }

  const source = readFileSync(absoluteConfigPath, "utf8");
  const objectStart = source.indexOf("{");

  if (objectStart === -1) {
    throw new Error("Wrangler config must contain a JSON object.");
  }

  let config: unknown;

  try {
    config = JSON.parse(source.slice(objectStart));
  } catch {
    throw new Error("Wrangler config must be JSON with comments only before the object.");
  }

  return {
    ...validateCloudflareConfig(config, absoluteConfigPath),
    sourcePrefix: source.slice(0, objectStart),
  };
}

export function prepareCloudflareTargetSnapshot(
  target: CloudflareTarget,
  workspaceRoot = process.cwd(),
) {
  const snapshot = prepareCloudflareProject(workspaceRoot);

  try {
    const configPath = relative(workspaceRoot, target.configPath);
    const snapshotTarget = readCloudflareTarget(configPath, snapshot.directory);
    if (!isDeepStrictEqual(snapshotTarget.config, target.config)) {
      throw new Error(
        "The isolated Cloudflare config no longer matches the validated source.",
      );
    }
    return { ...snapshot, target: snapshotTarget };
  } catch (error) {
    snapshot.dispose();
    throw error;
  }
}

export function validateCloudflareSecrets(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  vars: JsonObject = {},
) {
  const email = (environment.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = environment.ADMIN_PASSWORD ?? "";
  const sessionSecret = environment.ADMIN_SESSION_SECRET ?? "";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("ADMIN_EMAIL must contain a valid email address.");
  }

  if (password.length < 8) {
    throw new Error("ADMIN_PASSWORD must contain at least 8 characters.");
  }

  if (new TextEncoder().encode(sessionSecret).byteLength < 32) {
    throw new Error("ADMIN_SESSION_SECRET must contain at least 32 bytes.");
  }

  const provider = vars.OPAS_HANDOFF_PROVIDER ?? "cloudflare-email";
  let handoffSecrets: Readonly<Record<string, string>>;
  if (provider === "cloudflare-email") {
    const handoffDestination = normalizeHandoffEmailAddress(
      environment.OPAS_HANDOFF_TO_EMAIL,
    );
    if (!handoffDestination) {
      throw new Error(
        "OPAS_HANDOFF_TO_EMAIL must contain a verified destination email address.",
      );
    }
    if (
      environment.OPAS_HANDOFF_WEBHOOK_URL ||
      environment.OPAS_HANDOFF_WEBHOOK_TOKEN
    ) {
      throw new Error("Cloudflare email deployment cannot include webhook secrets.");
    }
    handoffSecrets = { OPAS_HANDOFF_TO_EMAIL: handoffDestination };
  } else if (provider === "webhook") {
    const endpoint = environment.OPAS_HANDOFF_WEBHOOK_URL ?? "";
    const token = environment.OPAS_HANDOFF_WEBHOOK_TOKEN ?? "";
    const tokenBytes = new TextEncoder().encode(token).byteLength;
    if (environment.OPAS_HANDOFF_TO_EMAIL) {
      throw new Error("Cloudflare webhook deployment cannot include email secrets.");
    }
    try {
      if (tokenBytes < 32 || tokenBytes > 4_096) {
        throw new Error("invalid token length");
      }
      createCloudflareWebhookDelivery({
        endpoint,
        fetch: async () => new Response(null, { status: 204 }),
        token,
      });
    } catch {
      throw new Error("Cloudflare webhook secrets are invalid.");
    }
    handoffSecrets = {
      OPAS_HANDOFF_WEBHOOK_URL: endpoint,
      OPAS_HANDOFF_WEBHOOK_TOKEN: token,
    };
  } else {
    throw new Error("vars.OPAS_HANDOFF_PROVIDER must select a supported provider.");
  }

  const fallbackEnabled = vars.OPAS_GENERATION_FALLBACK_ENABLED === "true";
  const fallbackApiKey = environment.OPAS_GENERATION_FALLBACK_API_KEY ?? "";
  const fallbackEndpoint = environment.OPAS_GENERATION_FALLBACK_ENDPOINT ?? "";
  if (!fallbackEnabled && (fallbackApiKey || fallbackEndpoint)) {
    throw new Error(
      "Cloudflare fallback secrets require explicit fallback configuration.",
    );
  }
  if (fallbackEnabled) {
    let endpoint: URL;
    try {
      endpoint = new URL(fallbackEndpoint);
    } catch {
      throw new Error(
        "OPAS_GENERATION_FALLBACK_ENDPOINT must contain a valid HTTPS URL.",
      );
    }
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      endpoint.toString() !== fallbackEndpoint ||
      fallbackApiKey.trim() !== fallbackApiKey ||
      fallbackApiKey.length < 8 ||
      fallbackApiKey.length > 4_096 ||
      /[\u0000-\u001f\u007f]/u.test(fallbackApiKey)
    ) {
      throw new Error("Cloudflare fallback secrets are invalid.");
    }
  }

  return {
    ADMIN_EMAIL: email,
    ADMIN_PASSWORD: password,
    ADMIN_SESSION_SECRET: sessionSecret,
    ...handoffSecrets,
    ...(fallbackEnabled
      ? {
          OPAS_GENERATION_FALLBACK_API_KEY: fallbackApiKey,
          OPAS_GENERATION_FALLBACK_ENDPOINT: fallbackEndpoint,
        }
      : {}),
  };
}

export function cloudflareCommandEnvironment(
  accountId: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (accountId !== maintainedAccountId) {
    throw new Error("Cloudflare commands are pinned to the maintained DevPlant account.");
  }
  const configured = environment.CLOUDFLARE_ACCOUNT_ID;
  const configuredAlias = environment.CF_ACCOUNT_ID;
  if (
    (configured && configured !== accountId) ||
    (configuredAlias && configuredAlias !== accountId)
  ) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID conflicts with the validated Wrangler account.");
  }
  return sanitizedCloudflareEnvironment(process.cwd(), {
    ...environment,
    CLOUDFLARE_ACCOUNT_ID: accountId,
  });
}

async function run(
  command: string,
  args: string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  console.info(`\n$ ${command} ${args.join(" ")}`);
  await runCloudflareProcess(command, args, {
    cwd: process.cwd(),
    environment: { ...environment, CI: "1" },
  });
}

async function capture(
  command: string,
  args: string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  return runCloudflareProcess(command, args, {
    captureOutput: true,
    cwd: process.cwd(),
    environment: { ...environment, CI: "1" },
  });
}

async function listD1Databases(configPath: string, accountId: string) {
  const output = await capture("pnpm", [
    "exec",
    "wrangler",
    "d1",
    "list",
    "--json",
    "--config",
    configPath,
  ], cloudflareCommandEnvironment(accountId));
  let result: unknown;

  try {
    result = JSON.parse(output);
  } catch {
    throw new Error("Wrangler returned an invalid D1 database list.");
  }

  if (!Array.isArray(result)) {
    throw new Error("Wrangler returned an invalid D1 database list.");
  }

  return result.flatMap((entry): D1Database[] => {
    if (
      !isObject(entry) ||
      typeof entry.name !== "string" ||
      typeof entry.uuid !== "string"
    ) {
      return [];
    }

    return [{ name: entry.name, uuid: entry.uuid }];
  });
}

async function listD1DatabasesForTarget(target: CloudflareTarget) {
  const snapshot = prepareCloudflareTargetSnapshot(target);
  try {
    return await listD1Databases(
      snapshot.target.configPath,
      snapshot.target.accountId,
    );
  } finally {
    snapshot.dispose();
  }
}

function saveDatabaseId(target: CloudflareTarget, databaseId: string) {
  const databases = target.config.d1_databases;

  if (!Array.isArray(databases) || !isObject(databases[0])) {
    throw new Error("Cannot update the validated D1 binding.");
  }

  databases[0].database_id = databaseId;
  const prefix = target.sourcePrefix.trimEnd();
  const contents = `${prefix.length > 0 ? `${prefix}\n` : ""}${JSON.stringify(
    target.config,
    null,
    2,
  )}\n`;
  writeFileSync(target.configPath, contents, "utf8");
}

async function resolveD1Database(target: CloudflareTarget) {
  const environment = cloudflareCommandEnvironment(target.accountId);
  let exactMatches = (await listD1DatabasesForTarget(target)).filter(
    (database) => database.name === target.databaseName,
  );

  if (exactMatches.length === 0) {
    const snapshot = prepareCloudflareTargetSnapshot(target);
    try {
      await run("pnpm", [
        "exec",
        "wrangler",
        "d1",
        "create",
        target.databaseName,
        "--location",
        "eeur",
        "--config",
        snapshot.target.configPath,
      ], environment);
    } finally {
      snapshot.dispose();
    }
    exactMatches = (await listD1DatabasesForTarget(target)).filter(
      (database) => database.name === target.databaseName,
    );
  }

  if (exactMatches.length !== 1) {
    throw new Error("Expected exactly one D1 database matching the configured OPAS target.");
  }

  const database = exactMatches[0];

  if (target.databaseId !== database.uuid) {
    saveDatabaseId(target, database.uuid);
    target.databaseId = database.uuid;
    console.info(`Pinned ${target.databaseName} to its exact D1 database ID.`);
  }
}

export async function verifyCloudflareDatabaseTarget(target: CloudflareTarget) {
  const exactMatches = (await listD1DatabasesForTarget(target)).filter(
    (database) => database.name === target.databaseName,
  );
  if (
    exactMatches.length !== 1 ||
    target.databaseId === undefined ||
    exactMatches[0].uuid !== target.databaseId
  ) {
    throw new Error(
      "The validated Worker config must pin the exact remote OPAS D1 database ID.",
    );
  }
}

function parseConfigPath(args: string[]) {
  if (args.length === 0) {
    return "wrangler.jsonc";
  }

  if (args.length === 2 && args[0] === "--config" && args[1].length > 0) {
    return args[1];
  }

  throw new Error("Usage: bootstrap-cloudflare.ts [--config <wrangler.jsonc>]");
}

async function main() {
  const target = readCloudflareTarget(parseConfigPath(process.argv.slice(2)));
  const environment = cloudflareCommandEnvironment(target.accountId);
  const deploymentSecrets = validateCloudflareSecrets(
    process.env,
    target.config.vars as JsonObject,
  );
  const seedPath = resolve(process.cwd(), "scripts/seed-d1.sql");
  const migrationsPath = resolve(dirname(target.configPath), "drizzle/sqlite");

  if (!existsSync(seedPath) || !existsSync(migrationsPath)) {
    throw new Error("Cloudflare migrations and seed SQL must exist before bootstrap.");
  }

  await capture(
    "pnpm",
    ["exec", "wrangler", "whoami", "--config", target.configPath],
    environment,
  );
  console.info(`Authenticated for guarded target ${target.workerName}.`);

  const build = await prepareCloudflareBuild(["--config", target.configPath], {
    environment,
    expectedTarget: target,
  });

  try {
    await resolveD1Database(target);
    const secretDirectory = mkdtempSync(join(tmpdir(), "opas-cloudflare-"));
    const secretPath = join(secretDirectory, "secrets.json");
    chmodSync(secretDirectory, 0o700);
    const cleanupSecrets = () =>
      rmSync(secretDirectory, { force: true, recursive: true });
    const unregisterSecretCleanup = registerCloudflareCleanup(cleanupSecrets);

    try {
      writeFileSync(secretPath, JSON.stringify(deploymentSecrets), { mode: 0o600 });
      await runBuiltCloudflareCommand(
        "deploy",
        [
          "--config",
          target.configPath,
          "--dry-run",
          "--secrets-file",
          secretPath,
        ],
        build,
        {
          environment,
          expectedSecrets: deploymentSecrets,
          expectedTarget: target,
        },
      );

      const dataSnapshot = prepareCloudflareTargetSnapshot(target);
      try {
        await run("pnpm", [
          "exec",
          "wrangler",
          "d1",
          "migrations",
          "apply",
          target.databaseName,
          "--remote",
          "--config",
          dataSnapshot.target.configPath,
        ], environment);
        await run("pnpm", [
          "exec",
          "wrangler",
          "d1",
          "execute",
          target.databaseName,
          "--remote",
          "--file",
          resolve(dataSnapshot.directory, "scripts/seed-d1.sql"),
          "--yes",
          "--config",
          dataSnapshot.target.configPath,
        ], environment);
      } finally {
        dataSnapshot.dispose();
      }

      await runBuiltCloudflareCommand(
        "deploy",
        ["--config", target.configPath, "--secrets-file", secretPath],
        build,
        {
          environment,
          expectedSecrets: deploymentSecrets,
          expectedTarget: target,
        },
      );
    } finally {
      unregisterSecretCleanup();
      cleanupSecrets();
    }
  } finally {
    build.dispose();
  }

  await run(
    "bash",
    [resolve(process.cwd(), "scripts/smoke.sh"), target.siteOrigin],
    cloudflareBuildEnvironment(process.cwd(), environment),
  );
  console.info(`\nCloudflare bootstrap complete: ${target.siteOrigin}`);
}

const invokedModule = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (import.meta.url === invokedModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    if (!process.exitCode) process.exitCode = 1;
  });
}
