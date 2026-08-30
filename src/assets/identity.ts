// ABOUTME: Defines the portable identities and canonical URLs for content-addressed image assets.
// ABOUTME: Shares exact hash and manifest validation across browser, HTTP, content, and storage edges.
const assetHashPattern = /^[a-f0-9]{64}$/u;
const assetManifestPattern = /^asset_manifest_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const assetUrlPattern = /^\/api\/assets\/([a-f0-9]{64})$/u;

export function isAssetHash(value: string) {
  return assetHashPattern.test(value);
}

export function isAssetManifestId(value: string) {
  return assetManifestPattern.test(value);
}

export function assetHashFromUrl(value: string) {
  return assetUrlPattern.exec(value)?.[1] ?? null;
}

export function authenticatedAssetUrl(value: string) {
  const hash = assetHashFromUrl(value);
  return hash ? `/admin/content/assets/${hash}` : value;
}
