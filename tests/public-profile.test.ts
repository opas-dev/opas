// ABOUTME: Verifies the fixed public identities used by generic and CROFusion deployments.
// ABOUTME: Prevents unknown environment values from silently publishing the wrong brand.
import assert from "node:assert/strict";
import test from "node:test";

import { publicSiteIdentity } from "@/site";

test("defaults to the generic OPAS public identity", () => {
  assert.deepEqual(publicSiteIdentity({}), {
    id: "opas",
    productName: "OPAS",
    siteName: "OPAS Help Center",
    siteDescription: "A help center you can theme, deploy, and own.",
    publisherName: "OPAS",
    headerNote: "Help that stays yours",
    heroContext: "OPAS Help Center",
    heroHeading: "How can we help?",
    heroCopy:
      "Search practical guides or ask for a cited answer about OPAS features, authoring, and deployment.",
  });
});

test("selects the complete CROFusion public identity explicitly", () => {
  assert.deepEqual(publicSiteIdentity({ OPAS_PUBLIC_PROFILE: "crofusion" }), {
    id: "crofusion",
    productName: "CROFusion",
    siteName: "CROFusion Help Center",
    siteDescription:
      "Guidance for creating, publishing, and improving landing pages with CROFusion.",
    publisherName: "CROFusion",
    headerNote: "Create. Test. Convert.",
    heroContext: "CROFusion Help Center",
    heroHeading: "How can we help you convert?",
    heroCopy:
      "Search practical guides or ask for a cited answer about creating, publishing, and improving landing pages.",
  });
});

test("rejects unknown public profiles", () => {
  assert.throws(
    () => publicSiteIdentity({ OPAS_PUBLIC_PROFILE: "customer" }),
    /OPAS_PUBLIC_PROFILE/,
  );
});
