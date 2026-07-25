import type { Options } from "@wdio/types";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every run gets a fresh config/database root. This prevents the packaged test
// app from reading or mutating a developer's real Adversaria data and disables
// keychain-backed DB encryption in the disposable fixture.
const testDataDir = join(tmpdir(), `adversaria-wdio-${process.pid}`);
mkdirSync(testDataDir, { recursive: true });
writeFileSync(
  join(testDataDir, "config.json"),
  JSON.stringify({
    python_service_url: "http://127.0.0.1:9",
    default_prompt_template: "general",
    auto_detect_meetings: false,
    ollama_model: "test-model",
    claude_api_key: null,
    encrypt_db: false,
    beta_onboarded: true,
    signup_synced: true,
  }),
);
process.env.ADVERSARIA_DATA_DIR = testDataDir;

const compiledApp =
  process.env.APP_BINARY ??
  "./src-tauri/target/debug/bundle/macos/Adversaria.app/Contents/MacOS/meeting-note-taker";
const appBundle =
  process.platform === "darwin" && !process.env.APP_BINARY
    ? "./scripts/launch-e2e-macos.sh"
    : compiledApp;

export const config: Options.Testrunner = {
  runner: "local",
  specs: ["./test/e2e/**/*.e2e.ts"],
  maxInstances: 1,
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: appBundle,
        driverProvider: "embedded",
        captureBackendLogs: true,
        captureFrontendLogs: true,
      },
    ],
  ],
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: appBundle,
      },
    },
  ],
  logLevel: "warn",
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 90_000,
  connectionRetryCount: 1,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 60_000,
  },
};
