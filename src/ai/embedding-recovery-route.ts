// ABOUTME: Authenticates private embedding recovery requests and returns a redacted result.
// ABOUTME: Uses fixed-size digest comparison so bearer validation does not reveal the secret.
import {
  embeddingRuntimeFailureDetails,
  runConfiguredEmbeddingWorker,
  type EmbeddingRecoverySummary,
  type EmbeddingRuntimeFailureDetails,
} from "@/ai/embedding-runtime";

export const minimumEmbeddingRecoverySecretBytes = 32;

type EmbeddingRecoveryRouteDependencies = {
  configuredSecret?: string;
  recover?: () => Promise<EmbeddingRecoverySummary>;
  reportFailure?: (details: EmbeddingRuntimeFailureDetails) => void;
};

const encoder = new TextEncoder();
const responseHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function response(body: unknown, status: number) {
  return Response.json(body, { status, headers: responseHeaders });
}

function validConfiguredSecret(secret: string | undefined): secret is string {
  if (secret === undefined) {
    return false;
  }

  const byteLength = encoder.encode(secret).byteLength;
  return (
    byteLength >= minimumEmbeddingRecoverySecretBytes &&
    byteLength <= 4_096 &&
    !/[\r\n]/u.test(secret)
  );
}

async function digest(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
}

async function authorized(request: Request, configuredSecret: string) {
  const authorization = request.headers.get("authorization") ?? "";
  const suppliedSecret = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const [expectedDigest, suppliedDigest] = await Promise.all([
    digest(configuredSecret),
    digest(suppliedSecret),
  ]);
  let difference = 0;

  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= expectedDigest[index] ^ suppliedDigest[index];
  }

  return difference === 0 && authorization.startsWith("Bearer ");
}

function reportEmbeddingRecoveryFailure(
  details: EmbeddingRuntimeFailureDetails,
) {
  console.error("Embedding recovery request failed.", details);
}

export async function handleEmbeddingRecoveryRequest(
  request: Request,
  dependencies: EmbeddingRecoveryRouteDependencies = {},
) {
  const configuredSecret =
    dependencies.configuredSecret ?? process.env.CRON_SECRET;

  if (!validConfiguredSecret(configuredSecret)) {
    return response({ status: "unavailable" }, 503);
  }

  if (!(await authorized(request, configuredSecret))) {
    return response({ status: "unauthorized" }, 401);
  }

  try {
    const recover = dependencies.recover ?? runConfiguredEmbeddingWorker;
    return response(await recover(), 200);
  } catch (error) {
    const reportFailure =
      dependencies.reportFailure ?? reportEmbeddingRecoveryFailure;
    reportFailure(embeddingRuntimeFailureDetails(error));
    return response({ status: "unavailable" }, 503);
  }
}
