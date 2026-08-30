// ABOUTME: Verifies bounded ZIP extraction for portable Markdown knowledge imports.
// ABOUTME: Exercises valid files and rejects hostile paths, metadata, nesting, and expansion.
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import test from "node:test";

import {
  archiveLimits,
  ArchiveValidationError,
  extractArchiveFiles,
} from "@/import/archive";

type ZipEntry = {
  path: string;
  content?: string | Uint8Array;
  encrypted?: boolean;
  mode?: number;
  declaredSize?: number;
};

const textEncoder = new TextEncoder();

function crc32(value: Uint8Array) {
  let crc = 0xffffffff;

  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function zipFixture(entries: readonly ZipEntry[]) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const content =
      typeof entry.content === "string"
        ? textEncoder.encode(entry.content)
        : (entry.content ?? new Uint8Array());
    const compressed = deflateRawSync(content);
    const flags = 0x0800 | (entry.encrypted ? 0x0001 : 0);
    const checksum = crc32(content);
    const declaredSize = entry.declaredSize ?? content.byteLength;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.byteLength, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);

    localOffset += local.byteLength + name.byteLength + compressed.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(localOffset, 16);

  return new Uint8Array(Buffer.concat([...localParts, centralDirectory, end]));
}

function centralOffset(archive: Uint8Array) {
  const offset = Buffer.from(archive).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.notEqual(offset, -1);
  return offset;
}

test("extracts a bounded UTF-8 Markdown archive without filesystem access", () => {
  const archive = zipFixture([
    { path: "guides/", mode: 0o040755 },
    { path: "SUMMARY.md", content: "# Summary\n" },
    { path: "guides/install.md", content: "# Install\n\nRun it.\n" },
    {
      path: "guides/screenshot.png",
      content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    },
  ]);

  const files = extractArchiveFiles(archive);

  assert.deepEqual(
    files.map((file) => file.path),
    ["SUMMARY.md", "guides/install.md", "guides/screenshot.png"],
  );
  assert.equal(new TextDecoder().decode(files[1].content), "# Install\n\nRun it.\n");
});

test("rejects unsafe and ambiguous archive paths before extraction", () => {
  const cases = [
    { label: "parent traversal", entries: [{ path: "../secret.md" }] },
    { label: "absolute path", entries: [{ path: "/etc/passwd" }] },
    { label: "drive path", entries: [{ path: "C:/secret.md" }] },
    { label: "backslash path", entries: [{ path: "guides\\secret.md" }] },
    {
      label: "duplicate normalized path",
      entries: [{ path: "Guides/Start.md" }, { path: "guides/start.md" }],
    },
  ];

  for (const candidate of cases) {
    assert.throws(
      () => extractArchiveFiles(zipFixture(candidate.entries)),
      ArchiveValidationError,
      candidate.label,
    );
  }
});

test("rejects encrypted, symbolic-link, nested, and oversized entries", () => {
  const cases = [
    { label: "encrypted", entries: [{ path: "secret.md", encrypted: true }] },
    { label: "symbolic link", entries: [{ path: "linked.md", mode: 0o120777 }] },
    { label: "nested archive", entries: [{ path: "nested.zip" }] },
    {
      label: "nested archive with a disguised name",
      entries: [
        {
          path: "payload.bin",
          content: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
        },
      ],
    },
    {
      label: "oversized file",
      entries: [{ path: "large.md", declaredSize: archiveLimits.fileBytes + 1 }],
    },
    {
      label: "excessive expansion ratio",
      entries: [
        {
          path: "compressed.md",
          content: "a",
          declaredSize: archiveLimits.expansionRatio + 1_024,
        },
      ],
    },
  ];

  for (const candidate of cases) {
    assert.throws(
      () => extractArchiveFiles(zipFixture(candidate.entries)),
      ArchiveValidationError,
      candidate.label,
    );
  }
});

test("rejects contradictory local headers, checksums, and host-disguised links", () => {
  const localPath = zipFixture([{ path: "safe.md", content: "Safe" }]);
  localPath.set(textEncoder.encode("../x.md"), 30);

  const localEncryption = zipFixture([{ path: "safe.md", content: "Safe" }]);
  localEncryption[6] |= 0x01;

  const localMethod = zipFixture([{ path: "safe.md", content: "Safe" }]);
  localMethod[8] = 0;

  const localChecksum = zipFixture([{ path: "safe.md", content: "Safe" }]);
  localChecksum.fill(0, 14, 18);

  const strongEncryption = zipFixture([{ path: "safe.md", content: "Safe" }]);
  strongEncryption[6] |= 0x40;
  strongEncryption[centralOffset(strongEncryption) + 8] |= 0x40;

  const hostDisguisedLink = zipFixture([
    { path: "linked.md", mode: 0o120777 },
  ]);
  hostDisguisedLink[centralOffset(hostDisguisedLink) + 5] = 0;

  for (const archive of [
    localPath,
    localEncryption,
    localMethod,
    localChecksum,
    strongEncryption,
    hostDisguisedLink,
  ]) {
    assert.throws(() => extractArchiveFiles(archive), ArchiveValidationError);
  }
});

test("rejects archives that exceed the file-count boundary", () => {
  const entries = Array.from({ length: archiveLimits.files + 1 }, (_, index) => ({
    path: `page-${index}.md`,
  }));

  assert.throws(() => extractArchiveFiles(zipFixture(entries)), ArchiveValidationError);
});
