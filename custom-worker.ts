// ABOUTME: Extends the generated OpenNext fetch entry point with scheduled evidence recovery.
// ABOUTME: Supplies D1 and Workers AI bindings directly outside the Next.js request context.
import { drizzle } from "drizzle-orm/d1";

import {
  embeddingRuntimeFailureDetails,
  runEmbeddingWorkerBatch,
} from "@/ai/embedding-runner";
import type { WorkersAiEmbeddingBinding } from "@/ai/embeddings";
import * as schema from "@/db/schema/sqlite";
import { createSqliteRepository } from "@/db/sqlite/repository";

// @ts-expect-error -- The OpenNext build creates this module before Wrangler bundles this entry point.
import handler from "./.open-next/worker.js";

export default {
  fetch: handler.fetch,

  async scheduled(
    _controller: ScheduledController,
    env: CloudflareEnv,
  ) {
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
  },
} satisfies ExportedHandler<CloudflareEnv>;
