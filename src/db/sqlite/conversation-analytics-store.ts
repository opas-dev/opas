// ABOUTME: Persists expiry-scoped redacted conversation analytics in SQLite and D1.
// ABOUTME: Uses portable SQL while keeping every read and update inside retention scope.
import { sql, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AnyD1Database, DrizzleD1Database } from "drizzle-orm/d1";

import type * as schema from "@/db/schema/sqlite";
import type {
  ConversationAnalyticsMessage,
  ConversationAnalyticsRecord,
  ConversationOutcome,
  ConversationRetrievalTrace,
} from "@/outcomes/records";
import {
  maximumConversationAnalyticsMessageUtf8Bytes,
  maximumConversationAnalyticsMessages,
  maximumConversationAnalyticsUtf8Bytes,
  maximumRetrievalExcerptUtf8Bytes,
  maximumRetrievalHeadingCount,
  maximumRetrievalHeadingUtf8Bytes,
  maximumRetrievalTraceEntries,
  maximumRetrievalTraceUtf8Bytes,
} from "@/outcomes/records";
import type { ConversationAnalyticsStore } from "@/outcomes/store";

type D1BackedDatabase = DrizzleD1Database<typeof schema> & {
  $client: AnyD1Database;
};
type SqliteDatabase =
  | D1BackedDatabase
  | BetterSQLite3Database<typeof schema>;
type StoredRow = Omit<
  ConversationAnalyticsRecord,
  "conversation" | "expiresAt" | "retrievalTrace" | "startedAt" | "updatedAt"
> & {
  conversation: string;
  expiresAt: number;
  retrievalTrace: string;
  startedAt: number;
  updatedAt: number;
};

const recordFields = sql`
  id,
  workspace_id as "workspaceId",
  outcome,
  reason,
  conversation,
  retrieval_trace as "retrievalTrace",
  provider,
  model,
  duration_milliseconds as "durationMilliseconds",
  first_token_milliseconds as "firstTokenMilliseconds",
  input_tokens as "inputTokens",
  output_tokens as "outputTokens",
  cost_microdollars as "costMicrodollars",
  bucket_day as "bucketDay",
  bucket_slot as "bucketSlot",
  started_at as "startedAt",
  updated_at as "updatedAt",
  expires_at as "expiresAt"
`;
const encoder = new TextEncoder();
const contentHashPattern = /^[a-f\d]{64}$/u;

function utf8Length(value: string) {
  return encoder.encode(value).byteLength;
}

function isD1Database(database: SqliteDatabase): database is D1BackedDatabase {
  return "batch" in database && "$client" in database;
}

function prepared(database: D1BackedDatabase, statement: SQL) {
  const query = database.run(statement).getQuery();
  return database.$client.prepare(query.sql).bind(...query.params);
}

function d1Rows<T>(value: unknown): T[] {
  return value !== null &&
    typeof value === "object" &&
    "results" in value &&
    Array.isArray(value.results)
    ? (value.results as T[])
    : [];
}

async function rows<T>(database: SqliteDatabase, statement: SQL): Promise<T[]> {
  return isD1Database(database)
    ? d1Rows<T>(await prepared(database, statement).all())
    : database.all<T>(statement);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function parsedJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Stored conversation analytics are invalid");
  }
}

function conversation(value: string): readonly ConversationAnalyticsMessage[] {
  const parsed = parsedJson(value);
  if (!Array.isArray(parsed) || parsed.length > maximumConversationAnalyticsMessages) {
    throw new Error("Stored conversation analytics are invalid");
  }
  const messages =
    parsed.map((entry) => {
      if (
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        !exactKeys(entry as Record<string, unknown>, ["content", "role"]) ||
        typeof (entry as { content?: unknown }).content !== "string" ||
        !["assistant", "user"].includes(String((entry as { role?: unknown }).role)) ||
        utf8Length((entry as { content: string }).content) >
          maximumConversationAnalyticsMessageUtf8Bytes
      ) {
        throw new Error("Stored conversation analytics are invalid");
      }
      return Object.freeze(entry as ConversationAnalyticsMessage);
    });
  if (
    messages.reduce((total, message) => total + utf8Length(message.content), 0) >
    maximumConversationAnalyticsUtf8Bytes
  ) {
    throw new Error("Stored conversation analytics are invalid");
  }
  return Object.freeze(messages);
}

function retrievalTrace(value: string): readonly ConversationRetrievalTrace[] {
  const parsed = parsedJson(value);
  if (!Array.isArray(parsed) || parsed.length > maximumRetrievalTraceEntries) {
    throw new Error("Stored retrieval analytics are invalid");
  }
  const entries =
    parsed.map((entry) => {
      if (
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        !exactKeys(entry as Record<string, unknown>, [
          "articleContentHash",
          "articleId",
          "canonicalUrl",
          "contentHash",
          "excerpt",
          "headingPath",
          "indexGeneration",
          "mode",
          "ordinal",
          "score",
          "sourceId",
          "sourceLineRange",
          "title",
        ])
      ) {
        throw new Error("Stored retrieval analytics are invalid");
      }
      const record = entry as Record<string, unknown>;
      if (
        ![
          "articleContentHash",
          "articleId",
          "canonicalUrl",
          "contentHash",
          "excerpt",
          "sourceId",
          "title",
        ].every(
          (key) => typeof record[key] === "string",
        ) ||
        !contentHashPattern.test(record.articleContentHash as string) ||
        !contentHashPattern.test(record.contentHash as string) ||
        !Array.isArray(record.headingPath) ||
        record.headingPath.length > maximumRetrievalHeadingCount ||
        record.headingPath.some(
          (heading) =>
            typeof heading !== "string" ||
            heading.length === 0 ||
            utf8Length(heading) > maximumRetrievalHeadingUtf8Bytes,
        ) ||
        record.sourceLineRange === null ||
        typeof record.sourceLineRange !== "object" ||
        Array.isArray(record.sourceLineRange) ||
        !exactKeys(record.sourceLineRange as Record<string, unknown>, [
          "end",
          "start",
        ]) ||
        !Number.isSafeInteger(
          (record.sourceLineRange as { start?: unknown }).start,
        ) ||
        !Number.isSafeInteger(
          (record.sourceLineRange as { end?: unknown }).end,
        ) ||
        (record.sourceLineRange as { start: number }).start < 1 ||
        (record.sourceLineRange as { end: number }).end <
          (record.sourceLineRange as { start: number }).start ||
        (record.sourceLineRange as { end: number }).end > 1_000_000 ||
        !["hybrid", "lexical", "vector"].includes(String(record.mode)) ||
        !Number.isSafeInteger(record.indexGeneration) ||
        (record.indexGeneration as number) < 1 ||
        !Number.isSafeInteger(record.ordinal) ||
        (record.ordinal as number) < 0 ||
        !Number.isFinite(record.score) ||
        (record.score as number) < 0 ||
        utf8Length(record.excerpt as string) > maximumRetrievalExcerptUtf8Bytes
      ) {
        throw new Error("Stored retrieval analytics are invalid");
      }
      return Object.freeze(entry as ConversationRetrievalTrace);
    });
  if (
    entries.reduce(
      (total, entry) =>
        total +
        [
          entry.articleContentHash,
          entry.articleId,
          entry.canonicalUrl,
          entry.contentHash,
          entry.excerpt,
          ...entry.headingPath,
          entry.sourceId,
          entry.title,
        ]
          .reduce((sum, field) => sum + utf8Length(field), 0),
      0,
    ) > maximumRetrievalTraceUtf8Bytes
  ) {
    throw new Error("Stored retrieval analytics are invalid");
  }
  return Object.freeze(entries);
}

function storedRecord(row: StoredRow): ConversationAnalyticsRecord {
  if (
    !["abandoned", "abstained", "answered", "escalated", "low-rated"].includes(
      row.outcome,
    ) ||
    !Number.isSafeInteger(row.durationMilliseconds) ||
    row.durationMilliseconds < 0 ||
    row.durationMilliseconds > 300_000 ||
    (row.firstTokenMilliseconds !== null &&
      (!Number.isSafeInteger(row.firstTokenMilliseconds) ||
        row.firstTokenMilliseconds < 0 ||
        row.firstTokenMilliseconds > row.durationMilliseconds))
  ) {
    throw new Error("Stored conversation analytics are invalid");
  }
  return Object.freeze({
    ...row,
    conversation: conversation(row.conversation),
    expiresAt: new Date(row.expiresAt),
    outcome: row.outcome as ConversationOutcome,
    retrievalTrace: retrievalTrace(row.retrievalTrace),
    startedAt: new Date(row.startedAt),
    updatedAt: new Date(row.updatedAt),
  });
}

function validLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("Conversation analytics limits must be between 1 and 1,000");
  }
  return limit;
}

export function createSqliteConversationAnalyticsStore(
  database: SqliteDatabase,
): ConversationAnalyticsStore {
  const store: ConversationAnalyticsStore = {
    async put(record) {
      const updatedAt = record.updatedAt.getTime();
      const update = sql`
        update conversation_analytics
        set outcome = case
              when outcome = 'escalated' or ${record.outcome} = 'escalated'
                then 'escalated'
              when outcome = 'low-rated' or ${record.outcome} = 'low-rated'
                then 'low-rated'
              when outcome = 'answered' or ${record.outcome} = 'answered'
                then 'answered'
              when outcome = 'abstained' or ${record.outcome} = 'abstained'
                then 'abstained'
              else 'abandoned'
            end,
            reason = case
              when ${record.outcome} = 'escalated' and outcome <> 'escalated'
                then ${record.reason}
              when outcome = 'escalated' and ${record.outcome} <> 'escalated'
                then reason
              when ${record.outcome} = 'low-rated' and outcome not in ('escalated', 'low-rated')
                then ${record.reason}
              when outcome = 'low-rated' and ${record.outcome} not in ('escalated', 'low-rated')
                then reason
              when ${record.outcome} = 'answered' and outcome in ('abandoned', 'abstained')
                then ${record.reason}
              when outcome = 'answered' and ${record.outcome} in ('abandoned', 'abstained')
                then reason
              when ${record.outcome} = 'abstained' and outcome = 'abandoned'
                then ${record.reason}
              when outcome = 'abstained' and ${record.outcome} = 'abandoned'
                then reason
              when ${updatedAt} >= updated_at then ${record.reason}
              else reason
            end,
            conversation = ${JSON.stringify(record.conversation)},
            retrieval_trace = ${JSON.stringify(record.retrievalTrace)},
            provider = ${record.provider},
            model = ${record.model},
            duration_milliseconds = ${record.durationMilliseconds},
            first_token_milliseconds = ${record.firstTokenMilliseconds},
            input_tokens = ${record.inputTokens},
            output_tokens = ${record.outputTokens},
            cost_microdollars = ${record.costMicrodollars},
            updated_at = max(updated_at, ${updatedAt})
        where id = ${record.id}
          and workspace_id = ${record.workspaceId}
          and expires_at > ${updatedAt}
        returning id
      `;
      const insert = sql`
        insert into conversation_analytics (
          id, workspace_id, outcome, reason, conversation, retrieval_trace,
          provider, model, duration_milliseconds, first_token_milliseconds,
          input_tokens, output_tokens, cost_microdollars, bucket_day,
          bucket_slot, started_at, updated_at, expires_at
        ) values (
          ${record.id}, ${record.workspaceId}, ${record.outcome}, ${record.reason},
          ${JSON.stringify(record.conversation)}, ${JSON.stringify(record.retrievalTrace)},
          ${record.provider}, ${record.model}, ${record.durationMilliseconds},
          ${record.firstTokenMilliseconds}, ${record.inputTokens},
          ${record.outputTokens}, ${record.costMicrodollars}, ${record.bucketDay},
          ${record.bucketSlot}, ${record.startedAt.getTime()}, ${updatedAt},
          ${record.expiresAt.getTime()}
        )
        on conflict do nothing
        returning id
      `;
      if (isD1Database(database)) {
        const results = await database.$client.batch([
          prepared(database, update),
          prepared(database, insert),
        ]);
        if (results.some((result) => d1Rows<{ id: string }>(result).length === 1)) {
          return true;
        }
        return (await rows<{ id: string }>(database, update)).length === 1;
      }
      const written = database.transaction((transaction) => {
        const updated = transaction.all<{ id: string }>(update);
        if (updated.length === 1) return true;
        return transaction.all<{ id: string }>(insert).length === 1;
      });
      return written || (await rows<{ id: string }>(database, update)).length === 1;
    },

    async updateOutcome(request) {
      const changed = await rows<{ id: string }>(database, sql`
        update conversation_analytics
        set outcome = ${request.outcome},
            reason = ${request.reason},
            updated_at = max(updated_at, ${request.updatedAt.getTime()})
        where id = ${request.id}
          and workspace_id = ${request.workspaceId}
          and expires_at > ${request.scope.readAt.getTime()}
          and started_at >= ${request.scope.retentionStartedAt.getTime()}
          and (
            (outcome = ${request.outcome} and ${request.updatedAt.getTime()} >= updated_at)
            or (${request.outcome} = 'escalated' and outcome <> 'escalated')
            or (${request.outcome} = 'low-rated' and outcome = 'answered')
          )
        returning id
      `);
      return changed.length === 1;
    },

    async get(workspaceId, id, scope) {
      const row = (
        await rows<StoredRow>(database, sql`
          select ${recordFields}
          from conversation_analytics
          where id = ${id}
            and workspace_id = ${workspaceId}
            and expires_at > ${scope.readAt.getTime()}
            and started_at >= ${scope.retentionStartedAt.getTime()}
          limit 1
        `)
      )[0];
      return row ? storedRecord(row) : null;
    },

    async list(workspaceId, scope, limit) {
      const found = await rows<StoredRow>(database, sql`
        select ${recordFields}
        from conversation_analytics
        where workspace_id = ${workspaceId}
          and expires_at > ${scope.readAt.getTime()}
          and started_at >= ${scope.retentionStartedAt.getTime()}
        order by updated_at desc, id
        limit ${validLimit(limit)}
      `);
      return Object.freeze(found.map(storedRecord));
    },

    async cleanup(request) {
      const deleted = await rows<{ id: string }>(database, sql`
        delete from conversation_analytics
        where (id, workspace_id) in (
          select id, workspace_id
          from conversation_analytics
          where workspace_id = ${request.workspaceId}
            and (
              expires_at <= ${request.scope.readAt.getTime()}
              or started_at < ${request.scope.retentionStartedAt.getTime()}
            )
          order by expires_at, id
          limit ${validLimit(request.limit)}
        )
        returning id
      `);
      return deleted.length;
    },
  };
  return Object.freeze(store);
}
