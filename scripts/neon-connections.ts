// ABOUTME: Validates pooled and direct Neon URLs as one database identity.
// ABOUTME: Derives a direct URL only after checking complete credentials and endpoint pairing.

type NeonEnvironment = Readonly<Record<string, string | undefined>>;

const neonPooledHostPattern =
  /^ep-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-pooler(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\.neon\.tech$/u;
const neonDirectHostPattern =
  /^ep-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\.neon\.tech$/u;
const permittedConnectionParameters = new Set(["channel_binding", "sslmode"]);
const permittedSslModes = new Set(["require", "verify-full"]);
const forbiddenTlsEnvironmentNames = new Set([
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "OPENSSL_CONF",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
]);

function parsePostgresUrl(value: string | undefined, name: string) {
  if (!value || value.trim() !== value) {
    throw new Error(`${name} must contain a PostgreSQL URL.`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must contain a PostgreSQL URL.`);
  }

  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !url.hostname ||
    !url.username ||
    !url.password ||
    !url.pathname ||
    url.pathname === "/" ||
    url.hash
  ) {
    throw new Error(`${name} must contain a complete PostgreSQL URL.`);
  }

  const seenParameters = new Set<string>();
  for (const [parameter] of url.searchParams) {
    if (
      !permittedConnectionParameters.has(parameter) ||
      seenParameters.has(parameter)
    ) {
      throw new Error(
        `${name} may contain only one sslmode and channel_binding parameter.`,
      );
    }
    seenParameters.add(parameter);
  }
  if (!permittedSslModes.has(url.searchParams.get("sslmode") ?? "")) {
    throw new Error(`${name} must require verified TLS.`);
  }
  const channelBinding = url.searchParams.get("channel_binding");
  if (channelBinding !== null && channelBinding !== "require") {
    throw new Error(`${name} channel_binding must be require when present.`);
  }

  return { url, value };
}

export function requireNeonConnectionStrings(environment: NeonEnvironment) {
  const pooled = parsePostgresUrl(
    environment.NEON_DATABASE_URL,
    "NEON_DATABASE_URL",
  );

  if (!neonPooledHostPattern.test(pooled.url.hostname)) {
    throw new Error("NEON_DATABASE_URL must use a pooled Neon host.");
  }

  const derivedDirect = new URL(pooled.url);
  derivedDirect.hostname = pooled.url.hostname.replace("-pooler.", ".");
  const direct = parsePostgresUrl(
    environment.NEON_DIRECT_DATABASE_URL || derivedDirect.toString(),
    "NEON_DIRECT_DATABASE_URL",
  );

  if (!neonDirectHostPattern.test(direct.url.hostname)) {
    throw new Error("NEON_DIRECT_DATABASE_URL must use a direct Neon host.");
  }

  if (
    derivedDirect.hostname !== direct.url.hostname ||
    (pooled.url.port || "5432") !== (direct.url.port || "5432") ||
    pooled.url.username !== direct.url.username ||
    pooled.url.password !== direct.url.password ||
    pooled.url.pathname !== direct.url.pathname
  ) {
    throw new Error(
      "The pooled and direct Neon URLs must address the same endpoint, port, credentials, and database.",
    );
  }

  return { pooled: pooled.value, direct: direct.value };
}

export function requireNeonDirectConnectionString(
  environment: NeonEnvironment = process.env,
) {
  const ambientSetting = Object.keys(environment).find((name) => {
    const normalizedName = name.toUpperCase();
    return (
      /^PG[A-Z0-9_]*$/u.test(normalizedName) ||
      forbiddenTlsEnvironmentNames.has(normalizedName)
    );
  });
  if (ambientSetting) {
    throw new Error(
      "Ambient PostgreSQL or TLS environment settings are not allowed during Neon preparation.",
    );
  }
  return requireNeonConnectionStrings(environment).direct;
}
