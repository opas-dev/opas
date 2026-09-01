// ABOUTME: Renders the runtime-branded navigation shared by public help-center pages.
// ABOUTME: Reuses the request-scoped theme so logo changes appear without a rebuild.
import Image from "next/image";
import Link from "next/link";

import { getCurrentTheme } from "@/theme/current";
import { publicSiteIdentity } from "@/site";

export async function PublicHeader() {
  const theme = await getCurrentTheme();
  const identity = publicSiteIdentity();

  return (
    <header className="site-header">
      <Link
        aria-label={`${identity.siteName} home`}
        className="wordmark"
        data-profile={identity.id}
        href="/"
      >
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
            {identity.productName.slice(0, 1)}
          </span>
        )}
        {identity.productName}
      </Link>
      <span className="header-note">{identity.headerNote}</span>
    </header>
  );
}
