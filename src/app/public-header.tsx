// ABOUTME: Renders the runtime-branded navigation shared by public help-center pages.
// ABOUTME: Reuses the request-scoped theme so logo changes appear without a rebuild.
import Image from "next/image";
import Link from "next/link";

import { getCurrentTheme } from "@/theme/current";

export async function PublicHeader() {
  const theme = await getCurrentTheme();

  return (
    <header className="site-header">
      <Link className="wordmark" href="/" aria-label="OPAS help center home">
        {theme.config.logoUrl ? (
          <Image
            alt=""
            className="wordmark-logo"
            height={30}
            src={theme.config.logoUrl}
            unoptimized
            width={30}
          />
        ) : (
          <span className="wordmark-mark" aria-hidden="true">
            O
          </span>
        )}
        OPAS
      </Link>
      <span className="header-note">Help that stays yours</span>
    </header>
  );
}
