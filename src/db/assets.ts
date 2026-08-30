// ABOUTME: Validates and hashes image assets before either database dialect stores them.
// ABOUTME: Keeps the portable one-mebibyte and media-type contract independent of drivers.
import type {
  ArticleAssetSelection,
  AssetMediaType,
  AssetUpload,
} from "@/db/repository";

export const maximumAssetBytes = 1024 * 1024;

const mediaTypes = new Set<AssetMediaType>([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const assetHashPattern = /^[a-f0-9]{64}$/u;

export class AssetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetValidationError";
  }
}

function isAssetMediaType(value: string): value is AssetMediaType {
  return mediaTypes.has(value as AssetMediaType);
}

function hex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function startsWith(content: Uint8Array, signature: readonly number[]) {
  return signature.every((byte, index) => content[index] === byte);
}

function hasImageSignature(mediaType: AssetMediaType, content: Uint8Array) {
  if (mediaType === "image/png") {
    return startsWith(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }

  if (mediaType === "image/jpeg") {
    return startsWith(content, [0xff, 0xd8, 0xff]);
  }

  if (mediaType === "image/gif") {
    return (
      startsWith(content, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      startsWith(content, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    );
  }

  return (
    startsWith(content, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(content.subarray(8), [0x57, 0x45, 0x42, 0x50])
  );
}

export async function prepareAsset(upload: AssetUpload) {
  if (!isAssetMediaType(upload.mediaType)) {
    throw new AssetValidationError("Use a PNG, JPEG, GIF, or WebP image.");
  }

  if (upload.content.byteLength === 0) {
    throw new AssetValidationError("Images cannot be empty.");
  }

  if (upload.content.byteLength > maximumAssetBytes) {
    throw new AssetValidationError("Images must be 1 MiB or smaller.");
  }

  if (!hasImageSignature(upload.mediaType, upload.content)) {
    throw new AssetValidationError("The image content does not match its media type.");
  }

  const content = upload.content.slice();
  const digest = await crypto.subtle.digest("SHA-256", content);

  return {
    hash: hex(new Uint8Array(digest)),
    mediaType: upload.mediaType,
    byteSize: content.byteLength,
    content,
  };
}

export function prepareAssetSelection(selection: ArticleAssetSelection) {
  const hashes = [...new Set(selection.hashes)].sort();

  if (hashes.some((hash) => !assetHashPattern.test(hash))) {
    throw new AssetValidationError("Article assets must use SHA-256 hashes.");
  }

  return { manifestId: selection.manifestId, hashes };
}
