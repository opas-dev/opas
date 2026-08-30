// ABOUTME: Defines the URL schemes permitted in stored OPAS article links and images.
// ABOUTME: Keeps editor feedback and the authoritative server validator on one policy.
import { assetHashFromUrl } from "@/assets/identity";

const linkProtocols = new Set(["http:", "https:", "mailto:", "tel:"]);
const imageProtocols = new Set(["https:"]);

function hasAllowedProtocol(value: string, protocols: ReadonlySet<string>) {
  const normalized = value.replace(/[\u0000-\u0020]/g, "");
  const protocolMatch = /^([a-z][a-z\d+.-]*:)/i.exec(normalized);

  return protocolMatch === null || protocols.has(protocolMatch[1].toLowerCase());
}

export function articleLinkUrlIssue(value: string) {
  if (hasAllowedProtocol(value, linkProtocols)) {
    return null;
  }

  return "Links must use http, https, mailto, tel, or a relative path.";
}

export function articleImageUrlIssue(value: string) {
  const normalized = value.replace(/[\u0000-\u0020]/g, "");

  if (normalized.startsWith("/api/assets/") && !assetHashFromUrl(value)) {
    return "Stored OPAS images must use their exact content-addressed URL.";
  }

  if (!/^[\\/]{2}/.test(normalized) && hasAllowedProtocol(normalized, imageProtocols)) {
    return null;
  }

  return "Images must use https or a relative path.";
}

export function articleAssetHash(value: string) {
  return assetHashFromUrl(value);
}
