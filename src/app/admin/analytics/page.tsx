// ABOUTME: Summarizes article readership, helpfulness, and sampled search misses for administrators.
// ABOUTME: Presents privacy-light workspace analytics in an accessible report rather than a decorative dashboard.
import type { Metadata } from "next";
import Link from "next/link";

import { AdminHeader } from "@/app/admin/header";
import { requireMemberCapability } from "@/auth/admin";
import { getRepository } from "@/db";
import { demoIds } from "@/db/demo";

export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Analytics",
  description: "Review OPAS article readership, feedback, and sampled search misses.",
};

const numberFormatter = new Intl.NumberFormat("en");

function helpfulRate(helpfulCount: number, feedbackCount: number) {
  if (feedbackCount === 0) {
    return null;
  }

  return Math.round((helpfulCount / feedbackCount) * 100);
}

export default async function AnalyticsAdminPage() {
  const admin = await requireMemberCapability("content:read", demoIds.workspace);
  const repository = await getRepository();
  const analytics = await repository.getAnalytics(demoIds.workspace);
  const { articles } = analytics;
  const totalViews = articles.reduce((total, article) => total + article.views, 0);
  const totalResponses = articles.reduce(
    (total, article) => total + article.feedbackCount,
    0,
  );
  const totalHelpful = articles.reduce(
    (total, article) => total + article.helpfulCount,
    0,
  );
  const overallHelpfulRate = helpfulRate(totalHelpful, totalResponses);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <AdminHeader email={admin.email} active="analytics" />
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="max-w-3xl">
          <p className="m-0 text-sm font-semibold text-primary">Reader signals</p>
          <h1 className="mb-0 mt-3 text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-4xl">
            See where answers help—and where they do not.
          </h1>
          <p className="mb-0 mt-4 max-w-2xl text-base leading-7 text-muted text-pretty">
            Anonymous event samples from the last 30 days show useful patterns without claiming
            unique visitors. Use them to decide which answers need another pass.
          </p>
        </div>

        <section className="mt-10" aria-labelledby="analytics-overview-heading">
          <h2 id="analytics-overview-heading" className="sr-only">
            Analytics overview
          </h2>
          <dl className="m-0 grid border-y border-border sm:grid-cols-3 sm:divide-x sm:divide-border">
            <div className="py-5 sm:px-6 sm:first:pl-0">
              <dt className="text-sm font-semibold text-muted">View samples</dt>
              <dd className="mb-0 mt-2 text-2xl font-semibold tabular-nums">
                {numberFormatter.format(totalViews)}
              </dd>
            </div>
            <div className="border-t border-border py-5 sm:border-t-0 sm:px-6">
              <dt className="text-sm font-semibold text-muted">Overall helpful</dt>
              <dd className="mb-0 mt-2 text-2xl font-semibold tabular-nums">
                {overallHelpfulRate === null ? "—" : `${overallHelpfulRate}%`}
              </dd>
            </div>
            <div className="border-t border-border py-5 sm:border-t-0 sm:px-6 sm:last:pr-0">
              <dt className="text-sm font-semibold text-muted">Feedback samples</dt>
              <dd className="mb-0 mt-2 text-2xl font-semibold tabular-nums">
                {numberFormatter.format(totalResponses)}
              </dd>
            </div>
          </dl>
          {overallHelpfulRate === null ? (
            <p className="mb-0 mt-3 text-sm leading-6 text-muted">
              The helpfulness rate will appear after the first sampled response.
            </p>
          ) : null}
        </section>

        <section className="mt-14" aria-labelledby="article-performance-heading">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
            <div>
              <h2
                id="article-performance-heading"
                className="m-0 text-xl font-semibold tracking-[-0.02em]"
              >
                Article performance
              </h2>
              <p className="mb-0 mt-2 text-sm leading-6 text-muted">
                Helpful percentages use sampled yes-or-no responses from the last 30 days.
              </p>
            </div>
          </div>

          {articles.length > 0 ? (
            <div
              className="overflow-x-auto"
              role="region"
              aria-labelledby="article-performance-heading"
              tabIndex={0}
            >
              <table className="w-full min-w-[42rem] border-collapse text-left text-sm">
                <caption className="sr-only">
                  Sampled views and helpfulness for every article in the workspace
                </caption>
                <thead>
                  <tr className="border-b border-border text-muted">
                    <th scope="col" className="py-3 pr-5 font-semibold">
                      Article
                    </th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">
                      View samples
                    </th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">
                      Feedback samples
                    </th>
                    <th scope="col" className="py-3 pl-5 text-right font-semibold">
                      Helpful
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {articles.map((article) => {
                    const rate = helpfulRate(article.helpfulCount, article.feedbackCount);

                    return (
                      <tr key={article.articleId}>
                        <th scope="row" className="py-4 pr-5 font-normal">
                          <div className="flex min-w-0 items-center gap-2">
                            <Link
                              href={`/admin/content/articles/${encodeURIComponent(article.articleId)}`}
                              className="truncate font-semibold text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-primary"
                            >
                              {article.title}
                            </Link>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                                article.status === "published"
                                  ? "bg-success text-success-foreground"
                                  : "bg-surface-strong text-muted"
                              }`}
                            >
                              {article.status === "published" ? "Published" : "Draft"}
                            </span>
                          </div>
                        </th>
                        <td className="px-5 py-4 text-right tabular-nums">
                          {numberFormatter.format(article.views)}
                        </td>
                        <td className="px-5 py-4 text-right tabular-nums">
                          {numberFormatter.format(article.feedbackCount)}
                        </td>
                        <td className="py-4 pl-5 text-right tabular-nums">
                          {rate === null ? (
                            <span className="text-muted">No responses</span>
                          ) : (
                            `${rate}%`
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="border-b border-border py-8">
              <p className="m-0 font-semibold">No article analytics yet</p>
              <p className="mb-0 mt-2 max-w-2xl text-sm leading-6 text-muted">
                Create and publish an article. Its anonymous event samples will appear here.
              </p>
            </div>
          )}
        </section>

        <section className="mt-14" aria-labelledby="search-misses-heading">
          <div className="border-b border-border pb-4">
            <h2
              id="search-misses-heading"
              className="m-0 text-xl font-semibold tracking-[-0.02em]"
            >
              Top sampled misses, last 30 days
            </h2>
            <p className="mb-0 mt-2 max-w-3xl text-sm leading-6 text-muted">
              This report includes anonymous zero-result search samples recorded in the last 30
              days. Counts reflect the sample, not every search; older rows are removed
              opportunistically when another miss arrives.
            </p>
          </div>

          {analytics.searchMisses.length > 0 ? (
            <ol className="m-0 list-none divide-y divide-border p-0">
              {analytics.searchMisses.map((miss, index) => (
                <li key={miss.query} className="flex items-baseline gap-4 py-4">
                  <span className="w-7 shrink-0 text-sm tabular-nums text-muted" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 break-words font-semibold">{miss.query}</span>
                  <span className="shrink-0 text-sm tabular-nums text-muted">
                    {numberFormatter.format(miss.count)} {miss.count === 1 ? "sample" : "samples"}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="border-b border-border py-8">
              <p className="m-0 font-semibold">No sampled misses in the last 30 days</p>
              <p className="mb-0 mt-2 max-w-2xl text-sm leading-6 text-muted">
                When a sampled search returns no articles, its query will appear here so you can
                close the content gap.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
