// ABOUTME: Serves the dedicated frameable assistant document for one configured parent origin.
// ABOUTME: Rejects direct, wildcarded, and unconfigured embed document requests before rendering.
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EmbedAssistant } from "@/app/embed/embed-assistant";
import { embedParentOrigins } from "@/embed/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = {
  icons: { icon: [] },
  robots: { follow: false, index: false },
  title: "Help assistant",
};

type EmbedPageProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export default async function EmbedPage({ searchParams }: EmbedPageProps) {
  const parentOrigin = (await searchParams).parentOrigin;
  const allowedOrigins = embedParentOrigins();
  if (
    typeof parentOrigin !== "string" ||
    !allowedOrigins.includes(parentOrigin)
  ) {
    notFound();
  }

  return <EmbedAssistant parentOrigin={parentOrigin} />;
}
