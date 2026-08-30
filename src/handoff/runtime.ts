// ABOUTME: Selects the server-configured support destination and durable deployment store.
// ABOUTME: Loads current published evidence for one fixed workspace before accepting handoffs.
import type { SendEmail } from "@cloudflare/workers-types";

import type { EvidenceChunkRecord } from "@/db/repository";
import { demoIds } from "@/db/demo";
import {
  createCloudflareEmailDelivery,
  createCloudflareRestEmailDelivery,
  createCloudflareWebhookDelivery,
  createNodeWebhookDelivery,
  type CloudflareEmailBinding,
  type HandoffDelivery,
  type HandoffHostnameResolver,
  type HandoffNodeHttpsRequest,
} from "@/handoff/delivery";
import { HandoffError } from "@/handoff/errors";
import type { HandoffEvidence } from "@/handoff/payload";
import { embedParentOrigins } from "@/embed/config";
import {
  createHandoffService,
  type HandoffService,
  type HandoffStore,
} from "@/handoff/service";
import { resolveSiteOrigin } from "@/site";

export type HandoffRuntimeEnvironment = Readonly<{
  OPAS_DATABASE_DRIVER?: string;
  OPAS_EMBED_PARENT_ORIGINS?: string;
  OPAS_HANDOFF_CLOUDFLARE_ACCOUNT_ID?: string;
  OPAS_HANDOFF_CLOUDFLARE_API_TOKEN?: string;
  OPAS_HANDOFF_FROM_EMAIL?: string;
  OPAS_HANDOFF_PROVIDER?: string;
  OPAS_HANDOFF_TO_EMAIL?: string;
  OPAS_HANDOFF_WEBHOOK_TOKEN?: string;
  OPAS_HANDOFF_WEBHOOK_URL?: string;
  OPAS_SITE_URL?: string;
}>;

type HandoffEvidenceRecord = Pick<
  EvidenceChunkRecord,
  | "articleContentHash"
  | "articleId"
  | "canonicalUrl"
  | "contentHash"
  | "headingPath"
  | "id"
  | "sourceLineRange"
  | "title"
>;

type HandoffEvidenceRepository = Readonly<{
  listEvidenceChunks(workspaceId: string): Promise<readonly HandoffEvidenceRecord[]>;
}>;

export type HandoffRuntimeDependencies = Readonly<{
  environment?: HandoffRuntimeEnvironment;
  fetch?: typeof fetch;
  getCloudflareEmailBinding?: () => Promise<CloudflareEmailBinding | undefined>;
  getRepository?: () => Promise<HandoffEvidenceRepository>;
  getStore?: () => Promise<HandoffStore>;
  now?: () => Date;
  requestHttps?: HandoffNodeHttpsRequest;
  resolveHostname?: HandoffHostnameResolver;
}>;

function configuration(): never {
  throw new HandoffError("configuration");
}

async function cloudflareEmailBinding() {
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const { env } = getCloudflareContext();
  return (env as { SUPPORT_EMAIL?: SendEmail }).SUPPORT_EMAIL;
}

async function selectedRepository() {
  const { getRepository } = await import("@/db");
  return getRepository();
}

async function selectedStore(): Promise<HandoffStore> {
  const { getConfiguredHandoffStore } = await import("@/handoff/storage-runtime");
  return getConfiguredHandoffStore();
}

async function configuredDelivery(
  environment: HandoffRuntimeEnvironment,
  dependencies: HandoffRuntimeDependencies,
): Promise<HandoffDelivery> {
  if (environment.OPAS_HANDOFF_PROVIDER === "cloudflare-email") {
    const binding = await (
      dependencies.getCloudflareEmailBinding ?? cloudflareEmailBinding
    )();
    if (!binding) return configuration();
    return createCloudflareEmailDelivery({
      binding,
      from: environment.OPAS_HANDOFF_FROM_EMAIL ?? "",
      to: environment.OPAS_HANDOFF_TO_EMAIL ?? "",
    });
  }
  if (environment.OPAS_HANDOFF_PROVIDER === "cloudflare-rest-email") {
    return createCloudflareRestEmailDelivery({
      accountId: environment.OPAS_HANDOFF_CLOUDFLARE_ACCOUNT_ID ?? "",
      apiToken: environment.OPAS_HANDOFF_CLOUDFLARE_API_TOKEN ?? "",
      fetch: dependencies.fetch,
      from: environment.OPAS_HANDOFF_FROM_EMAIL ?? "",
      to: environment.OPAS_HANDOFF_TO_EMAIL ?? "",
    });
  }
  if (environment.OPAS_HANDOFF_PROVIDER === "webhook") {
    const webhookOptions = {
      endpoint: environment.OPAS_HANDOFF_WEBHOOK_URL ?? "",
      ...(environment.OPAS_HANDOFF_WEBHOOK_TOKEN
        ? { token: environment.OPAS_HANDOFF_WEBHOOK_TOKEN }
        : {}),
    };
    return environment.OPAS_DATABASE_DRIVER === "d1"
      ? createCloudflareWebhookDelivery({
          ...webhookOptions,
          fetch: dependencies.fetch,
        })
      : createNodeWebhookDelivery({
          ...webhookOptions,
          request: dependencies.requestHttps,
          resolveHostname: dependencies.resolveHostname,
        });
  }
  return configuration();
}

function handoffEvidence(record: HandoffEvidenceRecord): HandoffEvidence {
  return Object.freeze({
    articleContentHash: record.articleContentHash,
    articleId: record.articleId,
    canonicalUrl: record.canonicalUrl,
    contentHash: record.contentHash,
    headingPath: Object.freeze([...record.headingPath]),
    id: record.id,
    sourceLineRange: Object.freeze({ ...record.sourceLineRange }),
    title: record.title,
  });
}

export async function createConfiguredHandoffService(
  dependencies: HandoffRuntimeDependencies = {},
): Promise<HandoffService> {
  const environment =
    dependencies.environment ?? (process.env as HandoffRuntimeEnvironment);
  try {
    const [delivery, repository, store] = await Promise.all([
      configuredDelivery(environment, dependencies),
      (dependencies.getRepository ?? selectedRepository)(),
      (dependencies.getStore ?? selectedStore)(),
    ]);
    return createHandoffService({
      delivery,
      loadEvidence: async () =>
        (await repository.listEvidenceChunks(demoIds.workspace)).map(
          handoffEvidence,
        ),
      now: dependencies.now,
      store,
      trustedPageOrigins: Object.freeze([
        resolveSiteOrigin(environment.OPAS_SITE_URL),
        ...embedParentOrigins(environment.OPAS_EMBED_PARENT_ORIGINS),
      ]),
      workspaceId: demoIds.workspace,
    });
  } catch (error) {
    if (error instanceof HandoffError) throw error;
    throw new HandoffError("configuration");
  }
}
