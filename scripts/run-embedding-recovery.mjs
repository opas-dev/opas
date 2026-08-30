// ABOUTME: Invokes the private embedding recovery route on a fixed Docker interval.
// ABOUTME: Keeps credentials and response bodies out of process output and avoids overlapping runs.
const defaultIntervalMilliseconds = 30_000;
const minimumIntervalMilliseconds = 10_000;
const maximumIntervalMilliseconds = 3_600_000;
const requestTimeoutMilliseconds = 55_000;
const encoder = new TextEncoder();

function intervalMilliseconds(value) {
  if (value === undefined || value === "") {
    return defaultIntervalMilliseconds;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) &&
    parsed >= minimumIntervalMilliseconds &&
    parsed <= maximumIntervalMilliseconds
    ? parsed
    : defaultIntervalMilliseconds;
}

function recoveryUrl(value) {
  try {
    const url = new URL(value ?? "");

    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/api/internal/embeddings" &&
      url.search === "" &&
      url.hash === ""
    ) {
      return url;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function validSecret(value) {
  return (
    typeof value === "string" &&
    encoder.encode(value).byteLength >= 32 &&
    encoder.encode(value).byteLength <= 4_096 &&
    !/[\r\n]/u.test(value)
  );
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function failureType(error) {
  return error instanceof Error ? "Error" : "UnknownError";
}

async function recover(url, secret) {
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(requestTimeoutMilliseconds),
    });

    if (response.ok) {
      console.info("Embedding recovery request completed.", {
        httpStatus: response.status,
      });
      return;
    }

    console.error("Embedding recovery request failed.", {
      httpStatus: response.status,
    });
  } catch (error) {
    console.error("Embedding recovery request failed.", {
      type: failureType(error),
    });
  }
}

const interval = intervalMilliseconds(
  process.env.OPAS_EMBEDDING_RECOVERY_INTERVAL_MS,
);
const url = recoveryUrl(process.env.OPAS_EMBEDDING_RECOVERY_URL);
const secret = process.env.CRON_SECRET;
let reportedDisabled = false;

while (true) {
  if (url !== undefined && validSecret(secret)) {
    await recover(url, secret);
  } else if (!reportedDisabled) {
    console.info(
      "Embedding recovery is disabled until its private URL and 32-byte secret are configured.",
    );
    reportedDisabled = true;
  }

  await wait(interval);
}
