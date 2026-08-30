// ABOUTME: Extends OpenNext with independent evidence and analytics recovery schedules.
// ABOUTME: Supplies D1 and Workers AI bindings outside the Next.js request context.
import { drizzle } from "drizzle-orm/d1";

import {
  embeddingRuntimeFailureDetails,
  runEmbeddingWorkerBatch,
} from "@/ai/embedding-runner";
import type { WorkersAiEmbeddingBinding } from "@/ai/embeddings";
import * as schema from "@/db/schema/sqlite";
import { createSqliteRepository } from "@/db/sqlite/repository";
import { createSqliteConversationAnalyticsStore } from "@/db/sqlite/conversation-analytics-store";
import { createSqlitePublicWriteAdmissionStore } from "@/db/sqlite/public-write-admission-store";
import { createSqliteSupportHandoffStore } from "@/db/sqlite/support-handoff-store";
import { runConfiguredAnalyticsCleanup } from "@/outcomes/runtime";
import { outcomeFailureDetails } from "@/outcomes/public";

// @ts-expect-error -- The OpenNext build creates this module before Wrangler bundles this entry point.
import handler from "./.open-next/worker.js";

export default {
  fetch: handler.fetch,

  async scheduled(
    controller: ScheduledController,
    env: CloudflareEnv,
  ) {
    if (controller.cron === "* * * * *") {
      try {
        const repository = createSqliteRepository(drizzle(env.DB, { schema }));
        const result = await runEmbeddingWorkerBatch({
          environment: env,
          getRepository: async () => repository,
          workersAiBinding: env.AI as unknown as WorkersAiEmbeddingBinding,
        });
        console.info("Scheduled embedding recovery completed.", result);
      } catch (error) {
        console.error(
          "Scheduled embedding recovery failed.",
          embeddingRuntimeFailureDetails(error),
        );
        throw new Error("Scheduled embedding recovery failed.");
      }
      return;
    }
    if (controller.cron === "15 0 * * *") {
      try {
        const database = drizzle(env.DB, { schema });
        const result = await runConfiguredAnalyticsCleanup({
          analyticsStore: createSqliteConversationAnalyticsStore(database),
          environment: env,
          handoffStore: createSqliteSupportHandoffStore(database),
          publicWriteStore: createSqlitePublicWriteAdmissionStore(database),
        });
        console.info("Scheduled analytics cleanup completed.", result);
      } catch (error) {
        console.error(
          "Scheduled analytics cleanup failed.",
          outcomeFailureDetails(error),
        );
        throw new Error("Scheduled analytics cleanup failed.");
      }
    }
  },
} satisfies ExportedHandler<CloudflareEnv>;
