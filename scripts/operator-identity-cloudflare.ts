// ABOUTME: Opens the operator identity repository against an explicitly selected Wrangler D1 target.
// ABOUTME: Pipes bound identity SQL through Wrangler without placing verifier material in arguments or files.

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

import { drizzle } from "drizzle-orm/d1";
import type { AnyD1Database } from "drizzle-orm/d1";

import type { OperatorIdentityRepository } from "../src/auth/operator-identity";
import * as schema from "../src/db/schema/sqlite";
import { createSqliteOperatorIdentityRepository } from "../src/db/sqlite/operator-identity-repository";
import {
  cloudflareCommandEnvironment,
  prepareCloudflareTargetSnapshot,
  readCloudflareTarget,
  verifyCloudflareDatabaseTarget,
} from "./bootstrap-cloudflare";

export type OperatorCloudflareTarget = Readonly<{
  configPath: string;
  location: "local" | "remote";
  persistTo?: string;
}>;

export type OpenOperatorIdentityRepository = Readonly<{
  close(): Promise<void>;
  repository: OperatorIdentityRepository;
}>;

type BoundValue = ArrayBuffer | boolean | null | number | string;

type BoundStatement = Readonly<{
  parameters: readonly BoundValue[];
  source: string;
}>;

type D1CommandResult = Readonly<{
  meta?: Readonly<Record<string, unknown>>;
  results: readonly Readonly<Record<string, unknown>>[];
  success: boolean;
}>;

const maximumOutputBytes = 10 * 1024 * 1024;

function sqliteLiteral(value: BoundValue): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("D1_OPERATOR_PARAMETER_INVALID");
    return String(value);
  }
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error("D1_OPERATOR_PARAMETER_INVALID");
}

export function bindD1Statement(statement: BoundStatement): string {
  let output = "";
  let parameterIndex = 0;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < statement.source.length; index += 1) {
    const character = statement.source[index] ?? "";
    const following = statement.source[index + 1];
    if (quote) {
      output += character;
      if (character === quote && following === quote) {
        output += following;
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      output += character;
      continue;
    }
    if (character === "?") {
      const value = statement.parameters[parameterIndex];
      if (value === undefined) throw new Error("D1_OPERATOR_PARAMETER_MISSING");
      output += sqliteLiteral(value);
      parameterIndex += 1;
      continue;
    }
    output += character;
  }

  if (quote || parameterIndex !== statement.parameters.length) {
    throw new Error("D1_OPERATOR_STATEMENT_INVALID");
  }
  return output;
}

function parseD1CommandResults(output: string): readonly D1CommandResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("D1_OPERATOR_RESULT_INVALID");
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("success" in entry) ||
      entry.success !== true ||
      !("results" in entry) ||
      !Array.isArray(entry.results)
    ) {
      throw new Error("D1_OPERATOR_RESULT_INVALID");
    }
    const results = entry.results.map((row: unknown) => {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new Error("D1_OPERATOR_RESULT_INVALID");
      }
      return row as Readonly<Record<string, unknown>>;
    });
    return {
      ...(typeof entry === "object" && entry !== null && "meta" in entry &&
      typeof entry.meta === "object" && entry.meta !== null
        ? { meta: entry.meta as Readonly<Record<string, unknown>> }
        : {}),
      results,
      success: true,
    };
  });
}

function runD1Query(
  project: string,
  databaseName: string,
  target: OperatorCloudflareTarget,
  environment: Record<string, string | undefined>,
  sql: string,
) {
  return new Promise<readonly D1CommandResult[]>((resolveResult, reject) => {
    const args = [
      "--import",
      "tsx",
      join(project, "scripts/operator-d1-query.ts"),
      databaseName,
      target.location,
      resolve(target.configPath),
    ];
    if (target.location === "local" && target.persistTo) {
      args.push(resolve(target.persistTo));
    }
    const child = spawn(process.execPath, args, {
      cwd: project,
      env: environment as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputBytes = 0;
    const capture = (targetBuffers: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maximumOutputBytes) {
        child.kill("SIGKILL");
        return;
      }
      targetBuffers.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(output, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(errors, chunk));
    child.once("error", () => reject(new Error("D1_OPERATOR_QUERY_FAILED")));
    child.once("close", (status) => {
      if (status !== 0 || outputBytes > maximumOutputBytes) {
        reject(new Error("D1_OPERATOR_QUERY_FAILED"));
        return;
      }
      try {
        resolveResult(parseD1CommandResults(Buffer.concat(output).toString("utf8")));
      } catch {
        reject(new Error("D1_OPERATOR_QUERY_FAILED"));
      }
    });
    child.stdin.end(sql);
  });
}

function createCommandDatabase(
  execute: (statements: readonly BoundStatement[]) => Promise<readonly D1CommandResult[]>,
) {
  type PreparedStatement = BoundStatement & {
    bind(...values: BoundValue[]): PreparedStatement;
  };
  const prepare = (source: string) => {
    const bound = (parameters: readonly BoundValue[]): PreparedStatement => ({
      bind: (...values) => bound(values),
      parameters,
      source,
    });
    return bound([]);
  };
  const client = {
    async batch(statements: readonly BoundStatement[]) {
      return execute(statements);
    },
    prepare,
  } as unknown as AnyD1Database;
  return drizzle(client, { schema });
}

export async function openCloudflareOperatorIdentityRepository(
  target: OperatorCloudflareTarget,
): Promise<OpenOperatorIdentityRepository> {
  const project = process.cwd();
  const configured = readCloudflareTarget(target.configPath);
  if (target.location === "remote") await verifyCloudflareDatabaseTarget(configured);
  const snapshot = prepareCloudflareTargetSnapshot(configured);
  try {
    const environment = cloudflareCommandEnvironment(configured.accountId);
    const database = createCommandDatabase(async (statements) => {
      const results = await runD1Query(
        project,
        snapshot.target.databaseName,
        {
          ...target,
          configPath: snapshot.target.configPath,
        },
        environment,
        statements.map(bindD1Statement).join(";\n"),
      );
      if (results.length !== statements.length) {
        throw new Error("D1_OPERATOR_RESULT_INVALID");
      }
      return results;
    });
    return Object.freeze({
      async close() {
        snapshot.dispose();
      },
      repository: createSqliteOperatorIdentityRepository(database),
    });
  } catch (error) {
    snapshot.dispose();
    throw error;
  }
}
