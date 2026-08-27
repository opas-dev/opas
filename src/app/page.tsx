// ABOUTME: Introduces the OPAS help center before database-backed content is connected.
// ABOUTME: Provides a lightweight public shell for initial runtime and styling verification.
import Link from "next/link";
import Image from "next/image";

import { getCurrentTheme } from "@/theme/current";

export const runtime = "nodejs";

const launchPoints = [
  {
    label: "Understand the product",
    detail: "Why ownership, runtime themes, and portable deployment belong together.",
  },
  {
    label: "Publish your first answer",
    detail: "Create focused support content and make it available without a rebuild.",
  },
  {
    label: "Choose where it runs",
    detail: "Use Docker, Vercel, or Cloudflare Workers from the same codebase.",
  },
];

export default async function HomePage() {
  const theme = await getCurrentTheme();

  return (
    <main>
      <header className="site-header">
        <Link className="wordmark" href="/" aria-label="OPAS home">
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

      <section className="hero" aria-labelledby="hero-heading">
        <p className="hero-context">Open-source help center</p>
        <h1 id="hero-heading">Answers should be easy to find—and yours to keep.</h1>
        <p className="hero-copy">
          Theme it at runtime. Deploy it anywhere. Give readers and agents one reliable source of truth.
        </p>
        <form className="search-preview" role="search">
          <label htmlFor="help-search">What can we help you find?</label>
          <div className="search-field">
            <input id="help-search" name="query" placeholder="Search the help center" disabled />
            <span aria-hidden="true">⌘ K</span>
          </div>
          <p>The searchable article library arrives with the content phase.</p>
        </form>
      </section>

      <section className="launch-points" aria-labelledby="launch-points-heading">
        <div className="section-heading">
          <h2 id="launch-points-heading">Start with the essentials</h2>
          <p>Three short paths through the OPAS story.</p>
        </div>
        <ol>
          {launchPoints.map((point, index) => (
            <li key={point.label}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h3>{point.label}</h3>
                <p>{point.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
