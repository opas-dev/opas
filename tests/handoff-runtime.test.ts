// ABOUTME: Verifies deployment configuration for support-handoff delivery and evidence authority.
// ABOUTME: Covers fixed provider selection, Cloudflare bindings, portable HTTP delivery, and safe failures.
import assert from "node:assert/strict";
import test from "node:test";

import type { CloudflareEmailBinding } from "@/handoff/delivery";
import { HandoffError } from "@/handoff/errors";
import { createConfiguredHandoffService } from "@/handoff/runtime";
import type {
  HandoffStorageRecord,
  HandoffStore,
} from "@/handoff/service";

const idempotencyKey = "123e4567-e89b-42d3-a456-426614174000";
const articleContentHash = "a".repeat(64);
const contentHash = "b".repeat(64);

const evidence = Object.freeze({
  articleContentHash,
  articleId: "article_password",
  canonicalUrl: "https://help.example.com/account/reset-password",
  contentHash,
  headingPath: Object.freeze(["Account", "Password"]),
  id: "chunk_password",
  sourceLineRange: Object.freeze({ end: 12, start: 4 }),
  title: "Reset your password",
});

const handoff = Object.freeze({
  citations: Object.freeze([
    Object.freeze({
      ...evidence,
      id: "C1",
      sourceId: evidence.id,
    }),
  ]),
  contact: Object.freeze({ email: "reader@example.com", name: "Reader" }),
  outcome: "abstained",
  pageUrl: "https://customer.example.com/account",
  question: "How do I reset my password?",
  transcript: Object.freeze([
    Object.freeze({ content: "How do I reset my password?", role: "user" }),
  ]),
});

class MemoryStore implements HandoffStore {
  readonly records = new Map<string, HandoffStorageRecord>();

  async cleanup() {
    return 0;
  }

  async reserve(record: HandoffStorageRecord) {
    const current = this.records.get(record.id);
    if (!current) {
      this.records.set(record.id, record);
      return { state: "reserved" as const };
    }
    return current.payloadHash === record.payloadHash
      ? { state: "duplicate" as const, status: current.status }
      : { state: "conflict" as const };
  }

  async finish(request: {
    finishedAt: Date;
    id: string;
    status: "delivered" | "failed";
    workspaceId: string;
  }) {
    const current = this.records.get(request.id);
    if (current) {
      this.records.set(request.id, { ...current, status: request.status });
    }
  }
}

function repository() {
  return {
    async listEvidenceChunks(workspaceId: string) {
      assert.equal(workspaceId, "workspace_demo");
      return [evidence];
    },
  };
}

test("uses the fixed Cloudflare binding and rebuilds citations from repository evidence", async () => {
  const messages: unknown[] = [];
  const binding = {
    async send(message: unknown) {
      messages.push(message);
      return { messageId: "message-id" };
    },
  } as unknown as CloudflareEmailBinding;
  const service = await createConfiguredHandoffService({
    environment: {
      OPAS_HANDOFF_FROM_EMAIL: "support@opas.dev",
      OPAS_HANDOFF_PROVIDER: "cloudflare-email",
      OPAS_HANDOFF_TO_EMAIL: "helpdesk@example.com",
      OPAS_SITE_URL: "https://customer.example.com",
    },
    getCloudflareEmailBinding: async () => binding,
    getRepository: async () => repository(),
    getStore: async () => new MemoryStore(),
  });

  assert.deepEqual(
    await service.submit({ idempotencyKey, submission: handoff }),
    { status: "delivered" },
  );
  assert.equal(messages.length, 1);
  assert.equal(
    (messages[0] as { replyTo: string }).replyTo,
    "reader@example.com",
  );
});

test("selects a configured webhook without allowing request-controlled routing", async () => {
  const calls: Array<{
    endpoint: string;
    pinnedAddress: string;
    headers: Readonly<Record<string, string>>;
  }> = [];
  const service = await createConfiguredHandoffService({
    environment: {
      OPAS_DATABASE_DRIVER: "postgres",
      OPAS_HANDOFF_PROVIDER: "webhook",
      OPAS_HANDOFF_WEBHOOK_TOKEN: "server-token",
      OPAS_HANDOFF_WEBHOOK_URL: "https://hooks.example.com/opas/support",
      OPAS_SITE_URL: "https://customer.example.com",
    },
    requestHttps: async ({ endpoint, headers, pinnedAddress }) => {
      calls.push({ endpoint, headers, pinnedAddress });
    },
    resolveHostname: async () => ["93.184.216.34"],
    getRepository: async () => repository(),
    getStore: async () => new MemoryStore(),
  });

  await service.submit({ idempotencyKey, submission: handoff });

  assert.equal(calls[0]?.endpoint, "https://hooks.example.com/opas/support");
  assert.equal(calls[0]?.pinnedAddress, "93.184.216.34");
  assert.equal(
    calls[0]?.headers.authorization,
    "Bearer server-token",
  );
});

test("uses Workers fetch for a D1 webhook without loading Node DNS", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const service = await createConfiguredHandoffService({
    environment: {
      OPAS_DATABASE_DRIVER: "d1",
      OPAS_HANDOFF_PROVIDER: "webhook",
      OPAS_HANDOFF_WEBHOOK_URL: "https://hooks.example.com/opas/support",
      OPAS_SITE_URL: "https://customer.example.com",
    },
    fetch: async (input, init) => {
      calls.push({ input, init });
      return new Response(null, { status: 204 });
    },
    getRepository: async () => repository(),
    getStore: async () => new MemoryStore(),
    resolveHostname: async () => {
      throw new Error("Workers must not call node:dns");
    },
  });

  await service.submit({ idempotencyKey, submission: handoff });

  assert.equal(calls.length, 1);
  assert.equal(String(calls[0]?.input), "https://hooks.example.com/opas/support");
  assert.equal(calls[0]?.init?.redirect, "error");
});

test("uses the portable Cloudflare REST email API for Docker or Vercel", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const service = await createConfiguredHandoffService({
    environment: {
      OPAS_HANDOFF_CLOUDFLARE_ACCOUNT_ID:
        "f8801c7e8853a113a25f8b52fd9ceec1",
      OPAS_HANDOFF_CLOUDFLARE_API_TOKEN: "server-email-token",
      OPAS_HANDOFF_FROM_EMAIL: "support@opas.dev",
      OPAS_HANDOFF_PROVIDER: "cloudflare-rest-email",
      OPAS_HANDOFF_TO_EMAIL: "helpdesk@example.com",
      OPAS_SITE_URL: "https://customer.example.com",
    },
    fetch: async (input, init) => {
      calls.push({ input, init });
      return Response.json({ success: true });
    },
    getRepository: async () => repository(),
    getStore: async () => new MemoryStore(),
  });

  await service.submit({ idempotencyKey, submission: handoff });

  assert.equal(
    String(calls[0]?.input),
    "https://api.cloudflare.com/client/v4/accounts/f8801c7e8853a113a25f8b52fd9ceec1/email/sending/send",
  );
});

test("rejects absent, unknown, or incomplete provider configuration with a fixed error", async () => {
  for (const environment of [
    {},
    { OPAS_HANDOFF_PROVIDER: "smtp" },
    {
      OPAS_HANDOFF_FROM_EMAIL: "support@opas.dev",
      OPAS_HANDOFF_PROVIDER: "cloudflare-email",
    },
  ]) {
    await assert.rejects(
      createConfiguredHandoffService({
        environment,
        getRepository: async () => repository(),
        getStore: async () => new MemoryStore(),
      }),
      (error: unknown) => {
        assert.ok(error instanceof HandoffError);
        assert.equal(error.code, "configuration");
        assert.doesNotMatch(String(error), /smtp|support@opas\.dev/u);
        return true;
      },
    );
  }
});
