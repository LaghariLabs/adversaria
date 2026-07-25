# Bundled Rapid-MLX runtime

This project freezes the exact `rapid-mlx==0.10.9` dependency graph from
`uv.lock` into the second macOS sidecar. It is a build-time component only; end
users never need Python, Homebrew, `uv`, or a terminal.

The desktop app launches it on an ephemeral loopback port with a random
per-launch API key, disables telemetry, and supplies an exact locally verified
model snapshot. Model weights are not included in the DMG.

Build with `./build.sh`. The release build then signs every nested Mach-O file
before signing the launcher and application bundle.
