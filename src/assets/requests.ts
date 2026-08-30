// ABOUTME: Parses the bounded browser requests used to stage and discard article image assets.
// ABOUTME: Rejects duplicate, oversized, and structurally unexpected values before repository writes.
import { isAssetManifestId } from "@/assets/identity";
import { maximumAssetBytes } from "@/db/assets";
import type { AssetUpload } from "@/db/repository";

export const assetManifestLifetimeMilliseconds = 60 * 60 * 1000;
export const maximumAssetRequestBytes = maximumAssetBytes + 64 * 1024;

export class AssetRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AssetRequestError";
  }
}

function requestLengthIssue(request: Request) {
  const header = request.headers.get("content-length");
  if (header === null) {
    return null;
  }

  const length = Number(header);
  if (!Number.isSafeInteger(length) || length < 0) {
    return new AssetRequestError(400, "The asset request length is invalid.");
  }

  return length > maximumAssetRequestBytes
    ? new AssetRequestError(413, "Image upload requests must be 1 MiB or smaller.")
    : null;
}

function manifestId(value: unknown) {
  return typeof value === "string" && isAssetManifestId(value) ? value : null;
}

export async function readAssetStageRequest(request: Request): Promise<{
  manifestId?: string;
  upload: AssetUpload;
}> {
  const lengthIssue = requestLengthIssue(request);
  if (lengthIssue) {
    throw lengthIssue;
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    throw new AssetRequestError(400, "Send one image as multipart form data.");
  }

  const names = [...formData.keys()];
  if (
    names.some((name) => name !== "file" && name !== "manifestId") ||
    formData.getAll("file").length !== 1 ||
    formData.getAll("manifestId").length > 1
  ) {
    throw new AssetRequestError(400, "Send exactly one image and one optional asset manifest.");
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new AssetRequestError(400, "Choose an image file to upload.");
  }
  if (file.size > maximumAssetBytes) {
    throw new AssetRequestError(413, "Images must be 1 MiB or smaller.");
  }

  const suppliedManifest = formData.get("manifestId");
  let parsedManifest: string | undefined;
  if (suppliedManifest !== null) {
    const parsed = manifestId(suppliedManifest);
    if (!parsed) {
      throw new AssetRequestError(400, "The asset manifest is invalid.");
    }
    parsedManifest = parsed;
  }

  return {
    manifestId: parsedManifest,
    upload: {
      mediaType: file.type,
      content: new Uint8Array(await file.arrayBuffer()),
    },
  };
}

export async function readAssetDiscardRequest(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > 1_024) {
    throw new AssetRequestError(400, "The asset discard request is invalid.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AssetRequestError(400, "The asset discard request is invalid.");
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !("manifestId" in body)
  ) {
    throw new AssetRequestError(400, "The asset discard request is invalid.");
  }

  const parsedManifest = manifestId(body.manifestId);
  if (!parsedManifest) {
    throw new AssetRequestError(400, "The asset manifest is invalid.");
  }

  return parsedManifest;
}
