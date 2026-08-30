// ABOUTME: Authenticates private analytics cleanup and returns only bounded deletion counts.
// ABOUTME: Uses digest comparison without logging credentials, records, or request metadata.
import { runConfiguredAnalyticsCleanup } from "@/outcomes/runtime";

export const minimumAnalyticsCleanupSecretBytes = 32;

type AnalyticsCleanupSummary = Awaited<
  ReturnType<typeof runConfiguredAnalyticsCleanup>
>;
type AnalyticsCleanupRouteDependencies = Readonly<{
  cleanup?: () => Promise<AnalyticsCleanupSummary>;
  configuredSecret?: string;
  reportFailure?: (details: Readonly<{ type: string }>) => void;
}>;

const encoder = new TextEncoder();
const responseHeaders = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});

function response(body: unknown, status: number) {
  return Response.json(body, { headers: responseHeaders, status });
}

function validSecret(value: string | undefined): value is string {
  if (typeof value !== "string" || /[\r\n]/u.test(value)) return false;
  const bytes = encoder.encode(value).byteLength;
  return bytes >= minimumAnalyticsCleanupSecretBytes && bytes <= 4_096;
}

async function digest(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
}

async function authorized(request: Request, secret: string) {
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const [expectedDigest, suppliedDigest] = await Promise.all([
    digest(secret),
    digest(supplied),
  ]);
  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= expectedDigest[index] ^ suppliedDigest[index];
  }
  return difference === 0 && authorization.startsWith("Bearer ");
}

export async function handleAnalyticsCleanupRequest(
  request: Request,
  dependencies: AnalyticsCleanupRouteDependencies = {},
) {
  const configuredSecret = dependencies.configuredSecret ?? process.env.CRON_SECRET;
  if (!validSecret(configuredSecret)) {
    return response({ status: "unavailable" }, 503);
  }
  if (!(await authorized(request, configuredSecret))) {
    return response({ status: "unauthorized" }, 401);
  }
  try {
    const cleanup = dependencies.cleanup ?? runConfiguredAnalyticsCleanup;
    return response(await cleanup(), 200);
  } catch (error) {
    (dependencies.reportFailure ?? ((details) => {
      console.error("Analytics cleanup request failed.", details);
    }))({ type: error instanceof Error ? error.name : "UnknownError" });
    return response({ status: "unavailable" }, 503);
  }
}
