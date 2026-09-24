import { describe, expect, it } from "vitest";
import { renderInlineBold, stripInlineBold } from "./inlineBold";
import { render } from "@testing-library/react";

describe("inlineBold", () => {
  it("renders two bold spans in one line", () => {
    const { container } = render(<p>{renderInlineBold("**Rules**: fast and **Gen AI**: fuzzy")}</p>);
    const strongs = container.querySelectorAll("strong");
    expect(strongs).toHaveLength(2);
    expect(strongs[0].textContent).toBe("Rules");
    expect(strongs[1].textContent).toBe("Gen AI");
    expect(container.textContent).toBe("Rules: fast and Gen AI: fuzzy");
    expect(container.textContent).not.toContain("**");
  });

  it("renders plain text with no markers unchanged", () => {
    const { container } = render(<p>{renderInlineBold("plain sentence here")}</p>);
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toBe("plain sentence here");
  });

  it("unclosed marker renders without asterisks and no strong", () => {
    const { container } = render(<p>{renderInlineBold("**Rul")}</p>);
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toBe("Rul");
    expect(container.textContent).not.toContain("*");
  });

  it("renders angle brackets as literal text", () => {
    const { container } = render(<p>{renderInlineBold("<script>alert(1)</script>")}</p>);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("stripInlineBold removes markers", () => {
    expect(stripInlineBold("**Rules**: fast")).toBe("Rules: fast");
    expect(stripInlineBold("plain")).toBe("plain");
    expect(stripInlineBold("**Rul")).toBe("Rul");
    expect(stripInlineBold("a * b")).toBe("a * b");
    expect(stripInlineBold("**A** and **B**")).toBe("A and B");
  });
});
