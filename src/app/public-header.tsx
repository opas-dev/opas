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
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="site-header">
        <div className="site-header-inner">
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
                height={34}
                src={theme.config.logoUrl}
                unoptimized
                width={34}
              />
            ) : (
              <span className="wordmark-mark" aria-hidden="true">
                {identity.productName.slice(0, 1)}
              </span>
            )}
            <span className="wordmark-copy">
              <strong>{identity.productName}</strong>
              <span>Help center</span>
            </span>
          </Link>
          <span className="header-note">{identity.headerNote}</span>
        </div>
      </header>
    </>
  );
}
