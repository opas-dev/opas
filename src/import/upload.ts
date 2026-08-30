// ABOUTME: Converts one browser knowledge upload into the bounded import file contract.
// ABOUTME: Applies portable request limits before ZIP extraction or Markdown planning.
import {
  archiveLimits,
  extractArchiveFiles,
  type ArchiveFile,
} from "@/import/archive";

export class ImportUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportUploadError";
  }
}

function safeUploadName(value: string) {
  const normalized = value.normalize("NFC");

  if (
    normalized.length === 0 ||
    normalized.length > 255 ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes("\u0000") ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new ImportUploadError("Choose a file with a safe, portable name.");
  }

  return normalized;
}

function extension(name: string) {
  const offset = name.lastIndexOf(".");
  return offset < 0 ? "" : name.slice(offset).toLocaleLowerCase("en-US");
}

export async function readKnowledgeUpload(value: FormDataEntryValue | null) {
  if (!(value instanceof File)) {
    throw new ImportUploadError("Choose one Markdown file or ZIP archive.");
  }

  const name = safeUploadName(value.name);
  const fileExtension = extension(name);
  const sizeLimit =
    fileExtension === ".zip" ? archiveLimits.compressedBytes : archiveLimits.fileBytes;

  if (value.size === 0 || value.size > sizeLimit) {
    throw new ImportUploadError(
      fileExtension === ".zip"
        ? "ZIP archives must be 4 MiB or smaller."
        : "Markdown files must be 2 MiB or smaller.",
    );
  }

  const content = new Uint8Array(await value.arrayBuffer());
  if (fileExtension === ".zip") {
    return extractArchiveFiles(content);
  }

  if (fileExtension === ".md" || fileExtension === ".markdown") {
    return [{ path: name, content }] satisfies ArchiveFile[];
  }

  throw new ImportUploadError("Choose a .md, .markdown, or .zip file.");
}
