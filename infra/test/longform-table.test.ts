import { expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { renderArticleHtml } from "../lib/lambdas/pds/longform-render";

it("renders the pipe table inside a published article's glossary", () => {
  const content = [
    '<details id="protocol-glossary">',
    "<summary>Protocol glossary</summary>",
    "",
    "| Term | Explanation |",
    "| --- | :---: |",
    "| **PDS** | One API \\| many accounts |",
    "| Relay | [Read more](https://example.com/relay) |",
    "",
    "</details>",
  ].join("\n");
  const html = renderArticleHtml({
    content, slug: "glossary", title: "Glossary", createdAt: "2026-11-20T00:00:00Z",
  }, { origin: "https://writer.example.com", siteName: "Writer", author: "writer.example.com" });
  const { document } = new JSDOM(html).window;
  const table = document.querySelector(".table-wrap table");
  expect(table).not.toBeNull();
  expect([...table!.querySelectorAll("thead th")].map(cell => cell.textContent)).toEqual(["Term", "Explanation"]);
  expect(table!.querySelector("tbody td strong")?.textContent).toBe("PDS");
  expect(table!.querySelector("tbody td[align=center]")?.textContent).toBe("One API | many accounts");
  expect(table!.querySelector("tbody td a")?.getAttribute("href")).toBe("https://example.com/relay");
});
