import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (process.platform !== "darwin") {
  process.exit(0);
}

const appBundle = resolve(
  "src-tauri/target/debug/bundle/macos/Adversaria.app",
);

if (!existsSync(appBundle)) {
  console.error(`E2E app bundle not found: ${appBundle}`);
  process.exit(1);
}

const runCodesign = (args) => {
  const result = spawnSync("codesign", args, {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

// `tauri build --debug` leaves a linker-signed Mach-O in the bundle. AppKit
// may abort in _RegisterApplication and LaunchServices rejects that incomplete
// bundle because its resources are not sealed. A whole-bundle ad-hoc signature
// gives the disposable E2E app a valid local signature without release keys.
runCodesign(["--force", "--deep", "--sign", "-", appBundle]);
runCodesign(["--verify", "--deep", "--strict", "--verbose=2", appBundle]);
