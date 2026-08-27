// ABOUTME: Defines the shared document shell and metadata for every OPAS route.
// ABOUTME: Pins the application shell to the Node.js runtime on every deployment target.
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { getCurrentTheme } from "@/theme/current";
import { themeStylesheet } from "@/theme/stylesheet";

import "./globals.css";

export const runtime = "nodejs";

export const metadata: Metadata = {
  title: {
    default: "OPAS Help Center",
    template: "%s · OPAS",
  },
  description: "A help center you can theme, deploy, and own.",
};

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
