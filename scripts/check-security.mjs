import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: on Windows the latter yields "/D:/a/..."
// and the leading slash makes resolve() prepend the cwd drive → "D:\D:\a\...".
const root = fileURLToPath(new URL("..", import.meta.url));
const tauri = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json")));
const csp = tauri?.app?.security?.csp;
if (typeof csp !== "string" || !csp.includes("default-src 'self'")) {
  throw new Error("Tauri CSP must be enabled with a self-only default policy.");
}
for (const directive of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
  if (!csp.includes(directive)) throw new Error(`CSP is missing: ${directive}`);
}
if (/https?:\/\/(?!asset\.localhost|ipc\.localhost)/.test(csp)) {
  throw new Error("Webview CSP must not allow remote HTTP origins.");
}

const mainCss = [
  readFileSync(resolve(root, "src/index.css"), "utf8"),
  readFileSync(resolve(root, "src/prototype.css"), "utf8"),
].join("\n");
if (/@import\s+url\(\s*["']?https?:/i.test(mainCss)) {
  throw new Error("Remote CSS imports are forbidden in the webview.");
}

const mainCapability = JSON.parse(
  readFileSync(resolve(root, "src-tauri/capabilities/default.json")),
);
if (mainCapability.windows.length !== 1 || mainCapability.windows[0] !== "main") {
  throw new Error("The main capability must not be shared with auxiliary windows.");
}
if (mainCapability.permissions.includes("core:default")) {
  throw new Error("The production main window must use explicit core permissions.");
}

console.log("Security boundary checks passed.");
