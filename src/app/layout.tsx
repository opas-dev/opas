// ABOUTME: Defines the shared document shell and metadata for every OPAS route.
// ABOUTME: Pins the application shell to the Node.js runtime on every deployment target.
import type { Metadata } from "next";
import type { ReactNode } from "react";

import {
  resolveSiteOrigin,
  siteDescription,
  siteName,
  sitePublisherName,
} from "@/site";
import { getCurrentTheme } from "@/theme/current";
import { themeStylesheet } from "@/theme/stylesheet";

import "./globals.css";

export const runtime = "nodejs";

export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(resolveSiteOrigin()),
    title: {
      default: siteName,
      template: "%s · OPAS",
    },
    description: siteDescription,
    applicationName: "OPAS",
    publisher: sitePublisherName,
  };
}

type RootLayoutProps = Readonly<{
  children: ReactNode;
}>;

export default async function RootLayout({ children }: RootLayoutProps) {
  const theme = await getCurrentTheme();

  return (
    <html lang="en">
      <head>
        <style id="opas-runtime-theme">{themeStylesheet(theme.config)}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
