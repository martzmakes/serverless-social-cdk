import { expect, it } from "vitest";
import { renderArticleHtml } from "../lib/lambdas/pds/longform-render";

const site = { origin: "https://writer.example.com", siteName: "Writer", author: "writer.example.com" };
const article = { content: "Article body.", slug: "article", title: "Article" };
const eastern = { ...site, articleTimeZone: "America/New_York" };

it.each([
  ["2026-11-25T01:38:37.151Z", "November 24, 2026"],
  ["2026-07-25T04:30:00.000Z", "July 25, 2026"],
  ["2025-04-26T00:00:00.000Z", "April 26, 2025"],
])("renders %s as %s with the original publish timestamp", (createdAt, displayDate) => {
  const html = renderArticleHtml({ ...article, createdAt }, {
    ...eastern,
    related: [{ slug: "related", title: "Related article", createdAt }],
  });
  expect(html.match(/<time datetime="[^"]+">[^<]+<\/time>/g)).toEqual(
    Array(2).fill(`<time datetime="${createdAt}">${displayDate}</time>`),
  );
  expect(html).toContain(`"datePublished":"${createdAt}"`);
});

it("keeps UTC article dates for sites without a configured time zone", () => {
  const createdAt = "2026-11-25T01:38:37.151Z";
  const html = renderArticleHtml({ ...article, createdAt }, site);
  expect(html).toContain(`<time datetime="${createdAt}">November 25, 2026</time>`);
});
