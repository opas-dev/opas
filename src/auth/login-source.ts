// ABOUTME: Resolves one canonical login source from deployment-owned request headers.
// ABOUTME: Rejects spoofable, missing, and malformed network identity outside development.
import { isIP } from "node:net";

export const dockerLoginSourceHeader = "x-opas-client-address" as const;

type LoginSourceEnvironment = Readonly<{
  NODE_ENV?: string;
  OPAS_DATABASE_DRIVER?: string;
}>;

export class LoginSourceError extends Error {
  readonly code = "LOGIN_SOURCE_UNAVAILABLE" as const;

  constructor() {
    super("LOGIN_SOURCE_UNAVAILABLE");
    this.name = "LoginSourceError";
  }
}

function canonicalIpAddress(value: string | null) {
  if (value === null) return null;
  const address = value.trim();
  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6 || address.includes("%")) return null;

  try {
    const hostname = new URL(`http://[${address}]/`).hostname;
    return hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : null;
  } catch {
    return null;
  }
}

function deploymentSourceHeader(environment: LoginSourceEnvironment) {
  if (environment.OPAS_DATABASE_DRIVER === "d1") return "cf-connecting-ip";
  if (environment.OPAS_DATABASE_DRIVER === "neon") {
    return "x-vercel-forwarded-for";
  }
  return dockerLoginSourceHeader;
}

export function readLoginSource(
  request: Request,
  environment: LoginSourceEnvironment = process.env,
) {
  const header = deploymentSourceHeader(environment);
  const source = canonicalIpAddress(request.headers.get(header));
  if (source !== null) return source;

  if (
    environment.OPAS_DATABASE_DRIVER !== "d1" &&
    environment.OPAS_DATABASE_DRIVER !== "neon" &&
    environment.NODE_ENV !== "production"
  ) {
    return "127.0.0.1";
  }
  throw new LoginSourceError();
}
