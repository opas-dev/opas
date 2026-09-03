// ABOUTME: Encodes authentication bytes canonically and validates configured identity scopes.
// ABOUTME: Keeps browser, Node, and workerd security values on one Web Crypto-compatible contract.

const base64UrlAlphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const canonicalDeploymentPattern = /^[a-z0-9](?:[a-z0-9.-]{0,46}[a-z0-9])?$/;

export type RandomBytes = (length: number) => Uint8Array;

export const authEncoder = new TextEncoder();

export function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];

    encoded += base64UrlAlphabet[first >> 2];
    encoded += base64UrlAlphabet[((first & 0b11) << 4) | ((second ?? 0) >> 4)];

    if (second !== undefined) {
      encoded +=
        base64UrlAlphabet[((second & 0b1111) << 2) | ((third ?? 0) >> 6)];
    }

    if (third !== undefined) {
      encoded += base64UrlAlphabet[third & 0b111111];
    }
  }

  return encoded;
}

export function encodeLowercaseHex(bytes: Uint8Array): string {
  let encoded = "";

  for (const byte of bytes) {
    encoded += byte.toString(16).padStart(2, "0");
  }

  return encoded;
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    return null;
  }

  const decoded: number[] = [];
  let buffer = 0;
  let availableBits = 0;

  for (const character of value) {
    const digit = base64UrlAlphabet.indexOf(character);

    if (digit < 0) {
      return null;
    }

    buffer = (buffer << 6) | digit;
    availableBits += 6;

    if (availableBits >= 8) {
      availableBits -= 8;
      decoded.push((buffer >> availableBits) & 0xff);
      buffer &= (1 << availableBits) - 1;
    }
  }

  const bytes = new Uint8Array(decoded);
  return encodeBase64Url(bytes) === value ? bytes : null;
}

export function createRandomBytes(
  length: number,
  source?: RandomBytes,
): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(length) || length < 1 || length > 1024) {
    throw new Error("INVALID_RANDOM_BYTE_LENGTH");
  }

  if (source) {
    const bytes = source(length);

    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
      throw new Error("INVALID_RANDOM_SOURCE");
    }

    return new Uint8Array(bytes);
  }

  return crypto.getRandomValues(new Uint8Array(length));
}

export function sessionSecretBytes(secret: string): Uint8Array<ArrayBuffer> {
  const bytes = authEncoder.encode(secret);

  if (bytes.byteLength < 32) {
    throw new Error("SESSION_SECRET_TOO_SHORT");
  }

  return bytes;
}

export function canonicalDeploymentId(deploymentId: string): string {
  if (!canonicalDeploymentPattern.test(deploymentId)) {
    throw new Error("INVALID_DEPLOYMENT_ID");
  }

  return deploymentId;
}

export function deploymentCookieScope(deploymentId: string): string {
  return encodeBase64Url(authEncoder.encode(canonicalDeploymentId(deploymentId)));
}

export function hasCanonicalJwtEncoding(
  token: string,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): boolean {
  const segments = token.split(".");
  const signature = segments.length === 3 ? decodeBase64Url(segments[2] ?? "") : null;

  return (
    segments.length === 3 &&
    segments[0] === encodeBase64Url(authEncoder.encode(JSON.stringify(header))) &&
    segments[1] === encodeBase64Url(authEncoder.encode(JSON.stringify(payload))) &&
    signature?.byteLength === 32
  );
}

export function assertAuthIdentifier(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("INVALID_AUTH_IDENTIFIER");
  }

  return value;
}

export function epochSeconds(value: Date): number {
  const milliseconds = value.getTime();

  if (!Number.isFinite(milliseconds)) {
    throw new Error("INVALID_AUTH_CLOCK");
  }

  return Math.floor(milliseconds / 1000);
}

export async function deriveAuthenticationKey(
  secret: string,
  deploymentId: string,
  purpose: string,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    sessionSecretBytes(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: authEncoder.encode(`opas-auth-v1\0${canonicalDeploymentId(deploymentId)}`),
      info: authEncoder.encode(purpose),
    },
    keyMaterial,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}
