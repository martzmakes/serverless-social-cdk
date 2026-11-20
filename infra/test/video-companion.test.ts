import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { normalizeVideoCompanion } from "../youtube";
import { renderArticleHtml } from "../lib/lambdas/pds/longform-render";

const id = "M7lc1UVf-VE";
const url = `https://www.youtube.com/watch?v=${id}`;

describe("YouTube video companions", () => {
  it.each([
    `${url}&si=share-tracker&t=39`,
    `https://youtu.be/${id}?si=share-tracker#ignored`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://youtube.com/shorts/${id}`,
    `https://youtube.com/live/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
  ])("normalizes a supported video URL %s", (input) => {
    expect(normalizeVideoCompanion({ url: input, title: "  A demo  " })).toEqual({ url, title: "A demo" });
  });

  it.each([
    `http://youtu.be/${id}`,
    `https://youtu.be.example.com/${id}`,
    `https://example.com/?v=${id}`,
    `https://username@youtu.be/${id}`,
    `https://youtu.be:444/${id}`,
    `https://youtu.be/${id}/playlist`,
    "https://www.youtube.com/playlist?list=playlistId",
    "https://www.youtube.com/watch?v=too-short",
    "javascript:alert(1)",
  ])("rejects an unsupported URL %s", (input) => {
    expect(normalizeVideoCompanion({ url: input })).toBeUndefined();
  });

  it("renders the companion after the article as a plain outbound link", () => {
    const article = {
      title: "A demonstration", slug: "demonstration", content: "Article body.", createdAt: "2026-10-01T12:00:00Z",
    };
    const ctx = { origin: "https://writer.example.com", siteName: "Writer", author: "writer.example.com" };
    const title = 'A <img src="https://other.example/tracking"> demonstration';
    const html = renderArticleHtml({ ...article, video: { url, title } }, ctx);
    const { document } = new JSDOM(html).window;
    const aside = document.querySelector(".video-companion")!;
    const link = aside.querySelector("a")!;
    expect(aside.previousElementSibling?.textContent).toBe("Article body.");
    expect(aside.querySelector("strong")?.textContent).toBe(title);
    expect(link.href).toBe(url);
    expect(link.relList.contains("noreferrer")).toBe(true);
    expect(link.target).toBe("_blank");
    expect(document.querySelector('iframe, [src*="youtube"], [rel="preconnect"][href*="youtube"]')).toBeNull();
    expect(aside.querySelector("img")).toBeNull();
    expect(renderArticleHtml({ ...article, video: { url: "javascript:alert(1)" } }, ctx)).toBe(renderArticleHtml(article, ctx));
    expect(renderArticleHtml({ ...article, video: { url } }, ctx)).toContain("Watch on YouTube");
  });
});
