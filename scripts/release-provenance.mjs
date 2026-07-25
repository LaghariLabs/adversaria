import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [artifactArg, outputArg, ...relatedArtifactArgs] = process.argv.slice(2);
if (!artifactArg || !outputArg) {
  throw new Error(
    "usage: node scripts/release-provenance.mjs <primary-artifact> <output> [related-artifact ...]",
  );
}

const artifact = resolve(artifactArg);
const output = resolve(outputArg);
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const modelProfiles = JSON.parse(readFileSync(new URL("../release/model-profiles.json", import.meta.url)));
const git = (...args) => spawnSync("git", args, { encoding: "utf8" }).stdout.trim();
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const artifactMetadata = (path) => ({
  filename: basename(path),
  bytes: readFileSync(path).byteLength,
  sha256: sha256(path),
});

const provenance = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  app: {
    version: packageJson.version,
    commit: git("rev-parse", "HEAD"),
    worktree_dirty: Boolean(git("status", "--porcelain")),
  },
  sidecars: {
    adversaria_service_version: "0.1.0",
    rapid_mlx_version: modelProfiles.rapid_mlx_version,
  },
  model_profiles: modelProfiles.profiles,
  artifact: {
    ...artifactMetadata(artifact),
  },
  distribution_artifacts: [
    artifact,
    ...relatedArtifactArgs.map((path) => resolve(path)),
  ].map(
    artifactMetadata,
  ),
};

writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 });
console.log(`Provenance: ${output}`);
