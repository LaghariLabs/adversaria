import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const supportedMajor = Number(process.versions.node.split(".")[0]) < 25;
const configuredBinary = process.env.NODE_LTS_BINARY;
const fallbacks =
  process.platform === "darwin"
    ? ["/opt/homebrew/opt/node@22/bin/node", "/usr/local/bin/node"]
    : [];
const nodeBinary = supportedMajor
  ? process.execPath
  : [configuredBinary, ...fallbacks].find(
      (candidate) => candidate && existsSync(candidate),
    );

if (!nodeBinary) {
  console.error(
    `Desktop E2E requires Node 20, 22, or 24 (current: ${process.version}). ` +
      "Select an LTS Node release or set NODE_LTS_BINARY to its executable.",
  );
  process.exit(1);
}

const wdio = join(process.cwd(), "node_modules", "@wdio", "cli", "bin", "wdio.js");
const result = spawnSync(nodeBinary, [wdio, "run", "wdio.conf.ts"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
