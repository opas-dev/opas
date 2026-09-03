// ABOUTME: Enforces the named-member password policy and creates portable password verifiers.
// ABOUTME: Chains bounded PBKDF2 stages and performs constant-time HMAC verification through Web Crypto.

import {
  authEncoder,
  createRandomBytes,
  decodeBase64Url,
  encodeBase64Url,
  type RandomBytes,
} from "@/auth/security-encoding";

export const memberPasswordScheme = Object.freeze({
  digestBytes: 32,
  hash: "SHA-256",
  id: "opas-pbkdf2-hmac-sha256-chain-v1",
  iterationsPerStage: 100_000,
  stageCount: 6,
  totalIterations: 600_000,
});

export const memberPasswordPolicy = Object.freeze({
  minimumCodePoints: 15,
  maximumCodePoints: 1024,
  maximumUtf8Bytes: 4096,
  iterations: memberPasswordScheme.totalIterations,
  saltBytes: 32,
  digestBytes: memberPasswordScheme.digestBytes,
});

export type MemberPasswordVerifier = {
  digest: string;
  iterations: number;
  salt: string;
};

export type MemberPasswordPolicyFailure =
  | "PASSWORD_INVALID_UNICODE"
  | "PASSWORD_TOO_LONG"
  | "PASSWORD_TOO_SHORT";

export class MemberPasswordPolicyError extends Error {
  readonly code: MemberPasswordPolicyFailure;

  constructor(code: MemberPasswordPolicyFailure) {
    super(code);
    this.code = code;
  }
}

const verifierMessage = authEncoder.encode("opas-member-password-verifier-v1");
const stageDomain = authEncoder.encode(`${memberPasswordScheme.id}\0`);
const dummyPassword = authEncoder.encode("opas-bounded-password-verification-dummy");
const dummySalt = new Uint8Array(memberPasswordPolicy.saltBytes);
const dummyDigest = new Uint8Array(memberPasswordPolicy.digestBytes);

function boundedCodePointLength(value: string): number {
  if (value.length > memberPasswordPolicy.maximumCodePoints * 2) {
    return memberPasswordPolicy.maximumCodePoints + 1;
  }

  let length = 0;

  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);

    if (codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff) {
      return -1;
    }

    index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    length += 1;

    if (length > memberPasswordPolicy.maximumCodePoints) {
      return length;
    }
  }

  return length;
}

function passwordBytesForCreation(password: string): Uint8Array<ArrayBuffer> {
  const codePointLength = boundedCodePointLength(password);

  if (codePointLength < 0) {
    throw new MemberPasswordPolicyError("PASSWORD_INVALID_UNICODE");
  }

  if (codePointLength < memberPasswordPolicy.minimumCodePoints) {
    throw new MemberPasswordPolicyError("PASSWORD_TOO_SHORT");
  }

  if (codePointLength > memberPasswordPolicy.maximumCodePoints) {
    throw new MemberPasswordPolicyError("PASSWORD_TOO_LONG");
  }

  const bytes = authEncoder.encode(password);

  if (bytes.byteLength > memberPasswordPolicy.maximumUtf8Bytes) {
    throw new MemberPasswordPolicyError("PASSWORD_TOO_LONG");
  }

  return bytes;
}

function passwordBytesForVerification(password: string): {
  bytes: Uint8Array<ArrayBuffer>;
  withinBounds: boolean;
} {
  const codePointLength = boundedCodePointLength(password);

  if (codePointLength < 0 || codePointLength > memberPasswordPolicy.maximumCodePoints) {
    return { bytes: dummyPassword, withinBounds: false };
  }

  const bytes = authEncoder.encode(password);
  const withinBounds = bytes.byteLength <= memberPasswordPolicy.maximumUtf8Bytes;

  return {
    bytes: withinBounds ? bytes : dummyPassword,
    withinBounds,
  };
}

function createStageSalt(
  salt: Uint8Array<ArrayBuffer>,
  stageNumber: number,
): Uint8Array<ArrayBuffer> {
  const stageSalt = new Uint8Array(stageDomain.byteLength + 4 + salt.byteLength);
  stageSalt.set(stageDomain);
  new DataView(stageSalt.buffer).setUint32(stageDomain.byteLength, stageNumber, false);
  stageSalt.set(salt, stageDomain.byteLength + 4);
  return stageSalt;
}

async function deriveVerifierKey(
  password: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  let stageInput = password;

  for (let stageNumber = 1; stageNumber <= memberPasswordScheme.stageCount; stageNumber += 1) {
    const passwordKey = await crypto.subtle.importKey("raw", stageInput, "PBKDF2", false, [
      "deriveBits",
    ]);
    stageInput = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          hash: memberPasswordScheme.hash,
          iterations: memberPasswordScheme.iterationsPerStage,
          salt: createStageSalt(salt, stageNumber),
        },
        passwordKey,
        memberPasswordScheme.digestBytes * 8,
      ),
    );
  }

  return crypto.subtle.importKey(
    "raw",
    stageInput,
    { name: "HMAC", hash: memberPasswordScheme.hash },
    false,
    ["sign", "verify"],
  );
}

function parseVerifier(verifier: MemberPasswordVerifier | null): {
  digest: Uint8Array<ArrayBuffer>;
  salt: Uint8Array<ArrayBuffer>;
  valid: boolean;
} {
  if (
    !verifier ||
    typeof verifier.salt !== "string" ||
    typeof verifier.digest !== "string" ||
    typeof verifier.iterations !== "number"
  ) {
    return { digest: dummyDigest, salt: dummySalt, valid: false };
  }

  const salt = decodeBase64Url(verifier.salt);
  const digest = decodeBase64Url(verifier.digest);
  const valid =
    verifier.iterations === memberPasswordPolicy.iterations &&
    salt?.byteLength === memberPasswordPolicy.saltBytes &&
    digest?.byteLength === memberPasswordPolicy.digestBytes;

  return {
    digest: valid ? digest : dummyDigest,
    salt: valid ? salt : dummySalt,
    valid,
  };
}

export function assertMemberPasswordPolicy(password: string): void {
  passwordBytesForCreation(password);
}

export async function createMemberPasswordVerifier(
  password: string,
  randomBytes?: RandomBytes,
): Promise<MemberPasswordVerifier> {
  const passwordBytes = passwordBytesForCreation(password);
  const salt = createRandomBytes(memberPasswordPolicy.saltBytes, randomBytes);
  const key = await deriveVerifierKey(passwordBytes, salt);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, verifierMessage));

  return {
    digest: encodeBase64Url(digest),
    iterations: memberPasswordPolicy.iterations,
    salt: encodeBase64Url(salt),
  };
}

export async function verifyMemberPassword(
  password: string,
  verifier: MemberPasswordVerifier | null,
): Promise<boolean> {
  const candidate = passwordBytesForVerification(password);
  const stored = parseVerifier(verifier);
  const key = await deriveVerifierKey(candidate.bytes, stored.salt);
  const matches = await crypto.subtle.verify(
    "HMAC",
    key,
    stored.digest,
    verifierMessage,
  );

  return candidate.withinBounds && stored.valid && matches;
}
