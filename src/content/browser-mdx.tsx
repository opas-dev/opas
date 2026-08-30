// ABOUTME: Executes sanitized compiled MDX in the browser for the Cloudflare D1 target.
// ABOUTME: Maps private preview assets without changing canonical stored content.
"use client";

import { executeMdx } from "@fumadocs/mdx-remote/client";
import type { ComponentProps, ReactNode } from "react";
import { useEffect, useState } from "react";

import { authenticatedAssetUrl } from "@/assets/identity";

type BrowserMdxProps = {
  authenticatedAssets?: boolean;
  compiled: string;
};

function AuthenticatedImage({ alt = "", src, ...props }: ComponentProps<"img">) {
  return (
    // MDX images have author-controlled intrinsic dimensions, so Next Image cannot size them safely.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...props}
      alt={alt}
      src={typeof src === "string" ? authenticatedAssetUrl(src) : src}
    />
  );
}

function AuthenticatedLink({ href, ...props }: ComponentProps<"a">) {
  return (
    <a
      {...props}
      href={typeof href === "string" ? authenticatedAssetUrl(href) : href}
    />
  );
}

export function BrowserMdx({ authenticatedAssets = false, compiled }: BrowserMdxProps) {
  const [content, setContent] = useState<ReactNode>(
    <p className="mdx-runtime-status" role="status">
      Rendering this answer…
    </p>,
  );

  useEffect(() => {
    let active = true;

    executeMdx(compiled)
      .then(async (module) => {
        const rendered = await module.default(
          authenticatedAssets
            ? { components: { a: AuthenticatedLink, img: AuthenticatedImage } }
            : {},
        );

        if (active) {
          setContent(rendered);
        }
      })
      .catch(() => {
        if (active) {
          setContent(
            <p className="mdx-runtime-status" role="alert">
              This answer could not be rendered.
            </p>,
          );
        }
      });

    return () => {
      active = false;
    };
  }, [authenticatedAssets, compiled]);

  return content;
}
