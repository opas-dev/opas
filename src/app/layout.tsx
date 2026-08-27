// ABOUTME: Defines the shared document shell and metadata for every OPAS route.
// ABOUTME: Pins the application shell to the Node.js runtime on every deployment target.
import type { Metadata } from "next";
import type { ReactNode } from "react";

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

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
