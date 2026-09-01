// ABOUTME: Gives lost help-center readers a branded route back to useful content.
// ABOUTME: Preserves the public profile while keeping recovery choices concise.
import Link from "next/link";

import { PublicHeader } from "@/app/public-header";

export default function NotFoundPage() {
  return (
    <>
      <PublicHeader />
      <main id="main-content">
        <section className="not-found" aria-labelledby="not-found-heading">
          <p>404 · Page not found</p>
          <h1 id="not-found-heading">This guide isn’t here.</h1>
          <p>
            The address may have changed, or the guide may no longer be published.
          </p>
          <Link href="/">Search the help center</Link>
        </section>
      </main>
    </>
  );
}
