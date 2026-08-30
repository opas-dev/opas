// ABOUTME: Extracts small ZIP knowledge archives behind strict portable safety limits.
// ABOUTME: Rejects hostile paths, metadata, nesting, duplication, and excessive expansion.
import { unzipSync } from "fflate";

export const archiveLimits = {
  compressedBytes: 4 * 1_024 * 1_024,
  totalBytes: 24 * 1_024 * 1_024,
  fileBytes: 2 * 1_024 * 1_024,
  files: 100,
  expansionRatio: 100,
} as const;

export type ArchiveFile = {
  path: string;
  content: Uint8Array;
};

export class ArchiveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveValidationError";
  }
}

type CentralEntry = {
  checksum: number;
  compression: number;
  path: string;
  rawPath: string;
  compressedSize: number;
  expandedSize: number;
  directory: boolean;
  flags: number;
  localOffset: number;
};

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const nestedArchiveExtensions = new Set([
  ".7z",
  ".bz2",
  ".gz",
  ".rar",
  ".tar",
  ".tgz",
  ".xz",
  ".zip",
]);

function readUint16(source: Uint8Array, offset: number) {
  return source[offset] | (source[offset + 1] << 8);
}

function readUint32(source: Uint8Array, offset: number) {
  return (
    (source[offset] |
      (source[offset + 1] << 8) |
      (source[offset + 2] << 16) |
      (source[offset + 3] << 24)) >>>
    0
  );
}

function findEndOfCentralDirectory(source: Uint8Array) {
  const earliestOffset = Math.max(0, source.byteLength - 65_557);

  for (let offset = source.byteLength - 22; offset >= earliestOffset; offset -= 1) {
    if (
      readUint32(source, offset) === 0x06054b50 &&
      offset + 22 + readUint16(source, offset + 20) === source.byteLength
    ) {
      return offset;
    }
  }

  throw new ArchiveValidationError("The archive central directory is missing.");
}

function safeArchivePath(value: string) {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    value.startsWith("/") ||
    /^[a-z]:/iu.test(value)
  ) {
    throw new ArchiveValidationError("The archive contains an unsafe path.");
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ArchiveValidationError("The archive contains an unsafe path.");
  }

  const normalized = segments.join("/").normalize("NFC");
  if (normalized !== value.normalize("NFC")) {
    throw new ArchiveValidationError("The archive contains an ambiguous path.");
  }

  return normalized;
}

function isNestedArchive(path: string) {
  const normalized = path.toLocaleLowerCase("en-US");
  return [...nestedArchiveExtensions].some((extension) => normalized.endsWith(extension));
}

function hasBytes(source: Uint8Array, offset: number, bytes: readonly number[]) {
  return bytes.every((byte, index) => source[offset + index] === byte);
}

function hasNestedArchiveSignature(source: Uint8Array) {
  return (
    hasBytes(source, 0, [0x50, 0x4b, 0x03, 0x04]) ||
    hasBytes(source, 0, [0x50, 0x4b, 0x05, 0x06]) ||
    hasBytes(source, 0, [0x1f, 0x8b]) ||
    hasBytes(source, 0, [0x42, 0x5a, 0x68]) ||
    hasBytes(source, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) ||
    hasBytes(source, 0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) ||
    hasBytes(source, 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) ||
    hasBytes(source, 257, [0x75, 0x73, 0x74, 0x61, 0x72])
  );
}

function checksum(source: Uint8Array) {
  let value = 0xffffffff;

  for (const byte of source) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }

  return (value ^ 0xffffffff) >>> 0;
}

function validateLocalEntries(source: Uint8Array, entries: readonly CentralEntry[], centralOffset: number) {
  const ranges: Array<{ start: number; end: number }> = [];

  for (const entry of entries) {
    const offset = entry.localOffset;
    if (offset + 30 > centralOffset || readUint32(source, offset) !== 0x04034b50) {
      throw new ArchiveValidationError("The archive local headers are invalid.");
    }

    const flags = readUint16(source, offset + 6);
    const compression = readUint16(source, offset + 8);
    const localChecksum = readUint32(source, offset + 14);
    const compressedSize = readUint32(source, offset + 18);
    const expandedSize = readUint32(source, offset + 22);
    const nameLength = readUint16(source, offset + 26);
    const extraLength = readUint16(source, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;

    if (
      flags !== entry.flags ||
      compression !== entry.compression ||
      dataStart > centralOffset ||
      dataEnd > centralOffset
    ) {
      throw new ArchiveValidationError("The archive local headers do not match its directory.");
    }

    let localPath: string;
    try {
      localPath = textDecoder.decode(source.subarray(nameStart, nameStart + nameLength));
    } catch {
      throw new ArchiveValidationError("The archive contains an invalid UTF-8 local path.");
    }
    if (localPath !== entry.rawPath) {
      throw new ArchiveValidationError("The archive local path does not match its directory.");
    }

    let rangeEnd = dataEnd;
    if (flags & 0x0008) {
      const descriptorOffset =
        readUint32(source, dataEnd) === 0x08074b50 ? dataEnd + 4 : dataEnd;
      if (
        descriptorOffset + 12 > centralOffset ||
        readUint32(source, descriptorOffset) !== entry.checksum ||
        readUint32(source, descriptorOffset + 4) !== entry.compressedSize ||
        readUint32(source, descriptorOffset + 8) !== entry.expandedSize
      ) {
        throw new ArchiveValidationError("The archive data descriptor is invalid.");
      }
      rangeEnd = descriptorOffset + 12;
    } else if (
      localChecksum !== entry.checksum ||
      compressedSize !== entry.compressedSize ||
      expandedSize !== entry.expandedSize
    ) {
      throw new ArchiveValidationError("The archive local sizes or checksum do not match.");
    }

    ranges.push({ start: offset, end: rangeEnd });
  }

  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1].end > ranges[index].start) {
      throw new ArchiveValidationError("The archive local entries overlap.");
    }
  }
}

function parseCentralDirectory(source: Uint8Array) {
  const endOffset = findEndOfCentralDirectory(source);
  const diskNumber = readUint16(source, endOffset + 4);
  const centralDiskNumber = readUint16(source, endOffset + 6);
  const diskEntries = readUint16(source, endOffset + 8);
  const totalEntries = readUint16(source, endOffset + 10);
  const centralSize = readUint32(source, endOffset + 12);
  const centralOffset = readUint32(source, endOffset + 16);
  const commentLength = readUint16(source, endOffset + 20);

  if (
    diskNumber !== 0 ||
    centralDiskNumber !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0xffff ||
    centralOffset === 0xffffffff ||
    centralSize === 0xffffffff ||
    endOffset + 22 + commentLength !== source.byteLength ||
    centralOffset + centralSize !== endOffset ||
    totalEntries > archiveLimits.files
  ) {
    throw new ArchiveValidationError("The archive structure is unsupported or too large.");
  }

  const entries: CentralEntry[] = [];
  const normalizedPaths = new Set<string>();
  let expandedTotal = 0;
  let offset = centralOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (readUint32(source, offset) !== 0x02014b50 || offset + 46 > endOffset) {
      throw new ArchiveValidationError("The archive central directory is invalid.");
    }

    const flags = readUint16(source, offset + 8);
    const compression = readUint16(source, offset + 10);
    const checksum = readUint32(source, offset + 16);
    const compressedSize = readUint32(source, offset + 20);
    const expandedSize = readUint32(source, offset + 24);
    const nameLength = readUint16(source, offset + 28);
    const extraLength = readUint16(source, offset + 30);
    const entryCommentLength = readUint16(source, offset + 32);
    const externalAttributes = readUint32(source, offset + 38);
    const localOffset = readUint32(source, offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + entryCommentLength;

    if (
      nextOffset > endOffset ||
      (flags & ~0x080e) !== 0 ||
      (compression === 0 && (flags & 0x0006) !== 0) ||
      (compression !== 0 && compression !== 8) ||
      compressedSize === 0xffffffff ||
      expandedSize === 0xffffffff
    ) {
      throw new ArchiveValidationError("The archive contains an unsupported entry.");
    }

    let rawPath: string;
    try {
      rawPath = textDecoder.decode(
        source.subarray(offset + 46, offset + 46 + nameLength),
      );
    } catch {
      throw new ArchiveValidationError("The archive contains an invalid UTF-8 path.");
    }

    const directory = rawPath.endsWith("/");
    const safePath = safeArchivePath(directory ? rawPath.slice(0, -1) : rawPath);
    const path = directory ? `${safePath}/` : safePath;
    const pathKey = safePath.toLocaleLowerCase("en-US");
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const fileType = unixMode & 0o170000;

    if (
      (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) ||
      (!directory && fileType === 0o040000) ||
      (!directory && (externalAttributes & 0x10) !== 0)
    ) {
      throw new ArchiveValidationError("The archive contains a symbolic link or special file.");
    }

    if (directory && (expandedSize !== 0 || fileType === 0o100000)) {
      throw new ArchiveValidationError("The archive contains an invalid directory entry.");
    }

    if (normalizedPaths.has(pathKey)) {
      throw new ArchiveValidationError("The archive contains a duplicate path.");
    }

    if (!directory && isNestedArchive(safePath)) {
      throw new ArchiveValidationError("The archive contains a nested archive.");
    }

    if (
      expandedSize > archiveLimits.fileBytes ||
      (compressedSize === 0
        ? expandedSize > 0
        : expandedSize > compressedSize * archiveLimits.expansionRatio)
    ) {
      throw new ArchiveValidationError("The archive entry exceeds its expansion limits.");
    }

    expandedTotal += expandedSize;
    if (expandedTotal > archiveLimits.totalBytes) {
      throw new ArchiveValidationError("The archive exceeds its expanded size limit.");
    }

    normalizedPaths.add(pathKey);
    entries.push({
      checksum,
      compression,
      path,
      rawPath,
      compressedSize,
      expandedSize,
      directory,
      flags,
      localOffset,
    });
    offset = nextOffset;
  }

  if (offset !== endOffset) {
    throw new ArchiveValidationError("The archive central directory is inconsistent.");
  }

  validateLocalEntries(source, entries, centralOffset);
  return entries;
}

export function extractArchiveFiles(source: Uint8Array): ArchiveFile[] {
  if (source.byteLength === 0 || source.byteLength > archiveLimits.compressedBytes) {
    throw new ArchiveValidationError("The archive exceeds its compressed size limit.");
  }

  const entries = parseCentralDirectory(source);
  let extracted: Record<string, Uint8Array>;

  try {
    extracted = unzipSync(source, {
      filter: (file) => {
        const entry = entries.find((candidate) => candidate.path === file.name);
        return Boolean(
          entry &&
            !entry.directory &&
            entry.compressedSize === file.size &&
            entry.expandedSize === file.originalSize,
        );
      },
    });
  } catch {
    throw new ArchiveValidationError("The archive could not be safely extracted.");
  }

  const files = entries.filter((entry) => !entry.directory);
  if (Object.keys(extracted).length !== files.length) {
    throw new ArchiveValidationError("The archive metadata did not match its extracted files.");
  }

  return files.map((entry) => {
    const content = extracted[entry.path];
    if (!content || content.byteLength !== entry.expandedSize) {
      throw new ArchiveValidationError("The archive metadata did not match its extracted files.");
    }

    if (checksum(content) !== entry.checksum) {
      throw new ArchiveValidationError("The archive entry checksum is invalid.");
    }

    if (hasNestedArchiveSignature(content)) {
      throw new ArchiveValidationError("The archive contains a nested archive.");
    }

    return { path: entry.path, content };
  });
}
