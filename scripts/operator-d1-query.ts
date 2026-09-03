// ABOUTME: Runs one in-memory SQL batch through Wrangler's authenticated D1 command handler.
// ABOUTME: Accepts sensitive derived values only on stdin so they never enter process arguments or files.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  experimental_getWranglerCommands,
  unstable_readConfig,
} from "wrangler";

const maximumSqlBytes = 1024 * 1024;

async function readSql() {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > maximumSqlBytes) throw new Error("D1_OPERATOR_QUERY_TOO_LARGE");
    chunks.push(bytes);
  }
  const statement = Buffer.concat(chunks).toString("utf8");
  if (!statement.trim()) throw new Error("D1_OPERATOR_QUERY_MISSING");
  return statement;
}

export async function main(args: readonly string[]) {
  const [database, location, configPath, persistTo] = args;
  if (
    !database ||
    (location !== "local" && location !== "remote") ||
    !configPath ||
    (location === "remote" && persistTo)
  ) {
    throw new Error("D1_OPERATOR_QUERY_ARGUMENTS_INVALID");
  }
  const d1 = experimental_getWranglerCommands().registry.subtree.get("d1");
  const execute = d1?.subtree.get("execute")?.definition;
  if (!execute || execute.type !== "command") {
    throw new Error("D1_OPERATOR_QUERY_UNAVAILABLE");
  }
  const config = unstable_readConfig({ config: configPath });
  const handler = execute.handler as unknown as (
    command: Readonly<Record<string, unknown>>,
    context: Readonly<{ config: typeof config }>,
  ) => Promise<void>;
  await handler(
    {
      command: await readSql(),
      config: configPath,
      database,
      file: undefined,
      json: true,
      local: location === "local",
      persistTo,
      preview: false,
      remote: location === "remote",
      yes: true,
    },
    { config },
  );
}

const invokedModule = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (import.meta.url === invokedModule) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write("D1_OPERATOR_QUERY_FAILED\n");
    process.exitCode = 1;
  });
}
