import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const budgetBytes = 500_000;
const distDir = resolve("dist");
const html = await readFile(resolve(distDir, "index.html"), "utf8");
const match = html.match(/<script[^>]+src="([^"]+\.js)"/);

if (!match) {
  throw new Error("Bundle budget check could not find the entry script in dist/index.html");
}

const entryPath = resolve(distDir, match[1].replace(/^\//, ""));
const { size } = await stat(entryPath);
const kb = (size / 1000).toFixed(2);

if (size > budgetBytes) {
  throw new Error(
    `Main entry bundle is ${kb} kB; the Phase 0 budget is ${(budgetBytes / 1000).toFixed(0)} kB`,
  );
}

console.log(`Bundle budget passed: main entry ${kb} kB / 500.00 kB`);
