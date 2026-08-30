// ABOUTME: Invokes private analytics cleanup on a fixed Docker interval.
// ABOUTME: Keeps credentials and response bodies out of logs and prevents overlapping runs.
const defaultIntervalMilliseconds = 6 * 60 * 60 * 1_000;
const minimumIntervalMilliseconds = 60_000;
const maximumIntervalMilliseconds = 24 * 60 * 60 * 1_000;
const requestTimeoutMilliseconds = 55_000;
const encoder = new TextEncoder();

function intervalMilliseconds(value) {
  if (value === undefined || value === "") return defaultIntervalMilliseconds;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) &&
    parsed >= minimumIntervalMilliseconds &&
    parsed <= maximumIntervalMilliseconds
    ? parsed
    : defaultIntervalMilliseconds;
}

function cleanupUrl(value) {
  try {
    const url = new URL(value ?? "");
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      url.pathname === "/api/internal/analytics" &&
      !url.search &&
      !url.hash
    ) {
      return url;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function validSecret(value) {
  return typeof value === "string" &&
    encoder.encode(value).byteLength >= 32 &&
    encoder.encode(value).byteLength <= 4_096 &&
    !/[\r\n]/u.test(value);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function cleanup(url, secret) {
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(requestTimeoutMilliseconds),
    });
    const details = { httpStatus: response.status };
    if (response.ok) console.info("Analytics cleanup request completed.", details);
    else console.error("Analytics cleanup request failed.", details);
  } catch (error) {
    console.error("Analytics cleanup request failed.", {
      type: error instanceof Error ? "Error" : "UnknownError",
    });
  }
}

const interval = intervalMilliseconds(process.env.OPAS_ANALYTICS_CLEANUP_INTERVAL_MS);
const url = cleanupUrl(process.env.OPAS_ANALYTICS_CLEANUP_URL);
const secret = process.env.CRON_SECRET;
let reportedDisabled = false;

while (true) {
  if (url && validSecret(secret)) await cleanup(url, secret);
  else if (!reportedDisabled) {
    console.info(
      "Analytics cleanup is disabled until its private URL and 32-byte secret are configured.",
    );
    reportedDisabled = true;
  }
  await wait(interval);
}
