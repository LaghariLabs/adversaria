async function setCssViewport(width: number, height: number) {
  // WebDriver reports physical pixels for a Tauri window on Retina, while the
  // webview reports CSS pixels. Scale iteratively so the acceptance size is the
  // actual layout viewport rather than a half-sized Retina screenshot.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const viewport = await browser.execute(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    if (
      Math.abs(viewport.width - width) <= 2 &&
      Math.abs(viewport.height - height) <= 2
    ) {
      return viewport;
    }

    const windowSize = await browser.getWindowSize();
    await browser.setWindowSize(
      Math.ceil(windowSize.width * (width / viewport.width)),
      Math.ceil(windowSize.height * (height / viewport.height)),
    );
  }

  return browser.execute(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
}

describe("Adversaria desktop startup", () => {
  it("renders the embedded webview and exposes the test-only Tauri bridge", async () => {
    const title = await browser.getTitle();
    expect(title).toContain("Adversaria");

    const windows = await browser.tauri.listWindows();
    expect(windows).toContain("main");

    const logo = await $(".logo-text");
    await logo.waitForDisplayed();
    await expect(logo).toHaveText("Adversaria");

    const domReadyMs = await browser.execute(() => {
      const navigation = performance.getEntriesByType(
        "navigation",
      )[0] as PerformanceNavigationTiming;
      return navigation.domContentLoadedEventEnd;
    });
    expect(domReadyMs).toBeLessThan(5_000);

    if (process.env.CAPTURE_BASELINES === "true") {
      const viewport = await setCssViewport(1440, 900);
      expect(viewport.width).toBeGreaterThanOrEqual(1440);
      expect(viewport.height).toBeGreaterThanOrEqual(900);
      await browser.pause(500);
      await browser.saveScreenshot("docs/baselines/phase-4/wide-1440x900.png");
    }
  });

  it("keeps the primary navigation usable at the supported minimum viewport", async function () {
    const viewport = await setCssViewport(1024, 720);

    // The host display may be too small to hold the minimum supported window:
    // GitHub's macOS runners are 1024x768, which leaves ~645 CSS px once the
    // menu bar and title bar are subtracted. Every assertion below describes
    // the layout *at* 1024x720, so on such a display this is inconclusive, not
    // failing — skip instead of reporting a regression that isn't one. On a
    // real screen the viewport is attainable and the checks run.
    if (viewport.width < 1024 || viewport.height < 720) {
      console.warn(
        `Skipping minimum-viewport layout check: display gave ` +
          `${viewport.width}x${viewport.height}, need 1024x720.`,
      );
      this.skip();
    }

    expect(viewport.width).toBeGreaterThanOrEqual(1024);
    expect(viewport.height).toBeGreaterThanOrEqual(720);

    const tabs = await $$("#view-tabs .nav-btn");
    await expect(tabs).toBeElementsArrayOfSize(6);
    await expect(tabs[0]).toHaveText("Meetings");
    await expect(tabs[5]).toHaveText("Settings");

    const layout = await browser.execute(() => {
      const tabRects = Array.from(
        document.querySelectorAll<HTMLElement>("#view-tabs .nav-btn"),
      ).map((element) => element.getBoundingClientRect());
      return {
        hasHorizontalDocumentOverflow:
          document.documentElement.scrollWidth > document.documentElement.clientWidth,
        tabsInsideViewport: tabRects.every(
          (rect) => rect.left >= 0 && rect.right <= window.innerWidth,
        ),
      };
    });
    expect(layout.hasHorizontalDocumentOverflow).toBe(false);
    expect(layout.tabsInsideViewport).toBe(true);

    if (process.env.CAPTURE_BASELINES === "true") {
      await browser.pause(250);
      await browser.saveScreenshot("docs/baselines/phase-4/minimum-1024x720.png");
    }
  });

  it("loads no remote webview assets", async () => {
    const remoteAssets = await browser.execute(() =>
      performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => /^https?:\/\//i.test(name)),
    );
    expect(remoteAssets).toEqual([]);

    const bodyFont = await browser.execute(() => getComputedStyle(document.body).fontFamily);
    expect(bodyFont.toLowerCase()).toContain("inter");
  });

  it("gives visible interactive controls accessible names and keyboard focus", async () => {
    const violations = await browser.execute(() => {
      const visible = (element: HTMLElement) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const accessibleName = (element: HTMLElement) =>
        element.getAttribute("aria-label")?.trim() ||
        element.getAttribute("title")?.trim() ||
        element.innerText.trim();

      return Array.from(document.querySelectorAll<HTMLElement>("button, a, input, select, textarea"))
        .filter(visible)
        .filter((element) => !accessibleName(element))
        .map((element) => element.outerHTML.slice(0, 160));
    });
    expect(violations).toEqual([]);

    const firstTab = await $("#view-tabs .nav-btn");
    await firstTab.click();
    await browser.execute(() => {
      (document.querySelector("#view-tabs .nav-btn") as HTMLElement | null)?.focus();
    });
    expect(await firstTab.isFocused()).toBe(true);
  });
});
