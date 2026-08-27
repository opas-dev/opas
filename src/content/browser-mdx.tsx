// ABOUTME: Executes sanitized compiled MDX in the browser for the Cloudflare D1 target.
// ABOUTME: Keeps request-time dynamic evaluation out of workerd while preserving live content.
"use client";

import { executeMdx } from "@fumadocs/mdx-remote/client";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

type BrowserMdxProps = {
  compiled: string;
};

export function BrowserMdx({ compiled }: BrowserMdxProps) {
  const [content, setContent] = useState<ReactNode>(
    <p className="mdx-runtime-status" role="status">
      Rendering this answer…
    </p>,
  );

  useEffect(() => {
    let active = true;

    executeMdx(compiled)
      .then(async (module) => {
        const rendered = await module.default({});

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
  }, [compiled]);

  return content;
}
