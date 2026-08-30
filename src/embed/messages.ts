// ABOUTME: Defines the bounded message protocol shared by the embed document and parent loader.
// ABOUTME: Rejects forged sources, origins, fields, protocols, versions, and resize values.

export const maximumEmbedMessageUtf8Bytes = 4_096;
export const maximumEmbedPageUrlUtf8Bytes = 2_048;
export const minimumEmbedHeight = 240;
export const maximumEmbedHeight = 1_200;

export type ParentContextMessage = Readonly<{
  pageUrl: string;
  type: "opas:context";
  version: 1;
}>;

export type EmbedControlMessage =
  | Readonly<{ type: "opas:ready"; version: 1 }>
  | Readonly<{ height: number; type: "opas:resize"; version: 1 }>;

type MessageEventBoundary = Readonly<{
  data: unknown;
  origin: string;
  source: unknown;
}>;

const encoder = new TextEncoder();

function exactKeys(record: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(record).sort();
  const expectedKeys = [...expected].sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function boundedRecord(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  try {
    if (encoder.encode(JSON.stringify(value)).byteLength > maximumEmbedMessageUtf8Bytes) {
      return null;
    }
  } catch {
    return null;
  }
  return value as Record<string, unknown>;
}

function pageUrl(value: unknown, expectedOrigin: string) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    encoder.encode(value).byteLength > maximumEmbedPageUrlUtf8Bytes
  ) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    url.origin === expectedOrigin
  );
}

export function isParentContextMessageEvent(
  event: MessageEventBoundary,
  expectedOrigin: string,
  expectedSource: unknown,
): event is MessageEventBoundary & Readonly<{ data: ParentContextMessage }> {
  if (event.origin !== expectedOrigin || event.source !== expectedSource) return false;
  const record = boundedRecord(event.data);
  return Boolean(
    record &&
      exactKeys(record, ["pageUrl", "type", "version"]) &&
      record.type === "opas:context" &&
      record.version === 1 &&
      pageUrl(record.pageUrl, expectedOrigin),
  );
}

export function isEmbedControlMessageEvent(
  event: MessageEventBoundary,
  expectedOrigin: string,
  expectedSource: unknown,
): event is MessageEventBoundary & Readonly<{ data: EmbedControlMessage }> {
  if (event.origin !== expectedOrigin || event.source !== expectedSource) return false;
  const record = boundedRecord(event.data);
  if (!record || record.version !== 1) return false;
  if (record.type === "opas:ready") {
    return exactKeys(record, ["type", "version"]);
  }
  return (
    record.type === "opas:resize" &&
    exactKeys(record, ["height", "type", "version"]) &&
    Number.isSafeInteger(record.height) &&
    (record.height as number) >= minimumEmbedHeight &&
    (record.height as number) <= maximumEmbedHeight
  );
}
