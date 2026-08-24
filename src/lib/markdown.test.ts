import { describe, expect, it } from "vitest";

import { markdownToHtml } from "./markdown";

function renderMarkdown(markdown: string): HTMLDivElement {
  const host = document.createElement("div");
  host.innerHTML = markdownToHtml(markdown);
  return host;
}

describe("markdownToHtml", () => {
  it("renders ATX headings and caps deeper headings at h4", () => {
    const host = renderMarkdown("# Plan\n#### Detail\n###### Deep");

    expect(host.querySelector("h1")?.textContent).toBe("Plan");
    expect(Array.from(host.querySelectorAll("h4"), (node) => node.textContent)).toEqual([
      "Detail",
      "Deep",
    ]);
  });

  it("joins consecutive paragraph lines and splits on blank lines", () => {
    const host = renderMarkdown("First line\nsecond line\n\nNext paragraph");

    expect(Array.from(host.querySelectorAll("p"), (node) => node.textContent)).toEqual([
      "First line second line",
      "Next paragraph",
    ]);
  });

  it("renders bullets with one level of nesting", () => {
    const host = renderMarkdown("- Parent\n  - Child\n    - Deep child\n- Sibling");
    const outer = host.querySelector("ul");

    expect(outer?.children).toHaveLength(2);
    expect(outer?.querySelector("ul")?.textContent).toContain("Child");
    expect(outer?.querySelector("ul")?.textContent).toContain("Deep child");
  });

  it("renders ordered lists", () => {
    const host = renderMarkdown("1. First\n2. Second");

    expect(Array.from(host.querySelectorAll("ol > li"), (node) => node.textContent)).toEqual([
      "First",
      "Second",
    ]);
  });

  it("renders disabled checked and unchecked task items", () => {
    const host = renderMarkdown("- [ ] Open\n- [x] Done");
    const inputs = Array.from(host.querySelectorAll<HTMLInputElement>("input"));

    expect(inputs).toHaveLength(2);
    expect(inputs.every((input) => input.disabled)).toBe(true);
    expect(inputs[0].checked).toBe(false);
    expect(inputs[1].checked).toBe(true);
    expect(host.querySelectorAll("li.md-task")).toHaveLength(2);
  });

  it("renders a pipe table with a header and two rows", () => {
    const host = renderMarkdown(
      "| Name | Status |\n| --- | :---: |\n| Alpha | Ready |\n| Beta | Blocked |",
    );

    expect(Array.from(host.querySelectorAll("th"), (node) => node.textContent)).toEqual([
      "Name",
      "Status",
    ]);
    expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(host.querySelectorAll("td")).toHaveLength(4);
  });

  it("keeps fenced code escaped and skips inline rendering", () => {
    const host = renderMarkdown("```ts\n<div>**bold**</div>\n```");
    const code = host.querySelector("pre code");

    expect(code?.textContent).toBe("<div>**bold**</div>");
    expect(code?.innerHTML).toContain("&lt;div&gt;");
    expect(code?.querySelector("strong")).toBeNull();
  });

  it("groups consecutive blockquote lines", () => {
    const host = renderMarkdown("> First line\n> second line");

    expect(host.querySelector("blockquote p")?.textContent).toBe(
      "First line second line",
    );
  });

  it("renders horizontal rules", () => {
    const host = renderMarkdown("Before\n\n---\n\nAfter");

    expect(host.querySelectorAll("hr")).toHaveLength(1);
  });

  it("renders inline emphasis, code, strike, and only http links", () => {
    const host = renderMarkdown(
      "**bold** *star* _under_ `code` ~~old~~ [safe](https://example.com) [unsafe](javascript:alert(1))",
    );

    expect(host.querySelector("strong")?.textContent).toBe("bold");
    expect(Array.from(host.querySelectorAll("em"), (node) => node.textContent)).toEqual([
      "star",
      "under",
    ]);
    expect(host.querySelector("code")?.textContent).toBe("code");
    expect(host.querySelector("del")?.textContent).toBe("old");
    expect(host.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(host.querySelector("a")).toHaveAttribute("target", "_blank");
    expect(host.textContent).toContain("[unsafe](javascript:alert(1))");
    expect(host.querySelectorAll("a")).toHaveLength(1);
  });

  it("keeps action_item_id literal", () => {
    const host = renderMarkdown("action_item_id");

    expect(host.querySelector("em")).toBeNull();
    expect(host.textContent).toBe("action_item_id");
  });

  it("renders a _word_ in prose as emphasis", () => {
    const host = renderMarkdown("A _word_ in prose.");

    expect(host.querySelector("em")?.textContent).toBe("word");
    expect(host.textContent).toBe("A word in prose.");
  });

  it("escapes raw script tags instead of creating elements", () => {
    const html = markdownToHtml('<script>alert("x")</script>');
    const host = renderMarkdown('<script>alert("x")</script>');

    expect(html).toContain("&lt;script&gt;");
    expect(host.querySelector("script")).toBeNull();
    expect(host.textContent).toContain('<script>alert("x")</script>');
  });
});
