// ABOUTME: Serves a deployment-specific browser icon for the generic and CROFusion demos.
// ABOUTME: Keeps favicon branding aligned with the public profile selected at request time.
import { publicSiteIdentity } from "@/site";

export const dynamic = "force-dynamic";
export const size = { width: 64, height: 64 };
export const contentType = "image/svg+xml";

const icons = {
  opas: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#a82230"/><circle cx="32" cy="32" r="15" fill="none" stroke="#fff" stroke-width="8"/></svg>`,
  crofusion: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#275bc5" d="M2 2h54a6 6 0 0 1 6 6v24H32z"/><path fill="#fe6679" d="M32 32h30L32 62z"/><path fill="#fe6679" d="M8 40h16v16L2 62z"/></svg>`,
} as const;

export default function Icon() {
  return new Response(icons[publicSiteIdentity().id], {
    headers: { "content-type": contentType },
  });
}
