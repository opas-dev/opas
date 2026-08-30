// ABOUTME: Parses the exact parent origins allowed to frame the OPAS assistant.
// ABOUTME: Fails closed on malformed, wildcarded, oversized, or non-origin configuration.

export const maximumEmbedParentOrigins = 16;

const maximumEmbedParentOriginUtf8Bytes = 1_024;
const maximumEmbedParentOriginsUtf8Bytes = 4_096;
const encoder = new TextEncoder();

function invalidParentOrigins(): never {
  throw new Error(
    "OPAS_EMBED_PARENT_ORIGINS must contain comma-separated canonical HTTP(S) origins",
  );
}

export function embedParentOrigins(
  configuredOrigins: string | undefined = process.env.OPAS_EMBED_PARENT_ORIGINS,
): readonly string[] {
  if (configuredOrigins === undefined || configuredOrigins.trim() === "") {
    return Object.freeze([]);
  }
  if (encoder.encode(configuredOrigins).byteLength > maximumEmbedParentOriginsUtf8Bytes) {
    return invalidParentOrigins();
  }

  const candidates = configuredOrigins.split(",");
  if (
    candidates.length === 0 ||
    candidates.length > maximumEmbedParentOrigins ||
    candidates.some((candidate) => candidate.trim() === "")
  ) {
    return invalidParentOrigins();
  }

  const origins: string[] = [];
  for (const value of candidates) {
    const candidate = value.trim();
    if (
      candidate.includes("*") ||
      encoder.encode(candidate).byteLength > maximumEmbedParentOriginUtf8Bytes
    ) {
      return invalidParentOrigins();
    }

    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return invalidParentOrigins();
    }

    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.origin !== candidate
    ) {
      return invalidParentOrigins();
    }

    if (!origins.includes(candidate)) origins.push(candidate);
  }

  return Object.freeze(origins);
}
