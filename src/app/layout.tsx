// ABOUTME: Defines the shared document shell and metadata for every OPAS route.
// ABOUTME: Pins the application shell to the Node.js runtime on every deployment target.
import type { Metadata } from "next";
import type { ReactNode } from "react";

import {
  publicSiteIdentity,
  resolveSiteOrigin,
} from "@/site";
import { getCurrentTheme } from "@/theme/current";
import { themeStylesheet } from "@/theme/stylesheet";

import "./globals.css";

export const runtime = "nodejs";

export function generateMetadata(): Metadata {
  const identity = publicSiteIdentity();

  return {
    metadataBase: new URL(resolveSiteOrigin()),
    title: {
      default: identity.siteName,
      template: `%s · ${identity.productName}`,
    },
    description: identity.siteDescription,
    applicationName: identity.productName,
    publisher: identity.publisherName,
  };
}

type RootLayoutProps = Readonly<{
  children: ReactNode;
}>;

export default async function RootLayout({ children }: RootLayoutProps) {
  const theme = await getCurrentTheme();
  const identity = publicSiteIdentity();

  return (
    <html data-public-profile={identity.id} data-scroll-behavior="smooth" lang="en">
      <head>
        <style id="opas-runtime-theme">{themeStylesheet(theme.config)}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
