#!/usr/bin/env bash
#
# Mirror this private workspace into the PUBLIC repo, minus everything that is
# deliberately not public.
#
# Why this exists: the two repos have no shared history, so they drift silently.
# CI (`quality.yml`) is guarded to `github.repository == 'LaghariLabs/adversaria'`
# — the public repo — which means **workspace-only commits are never built or
# linted on any platform**. That is not a theoretical gap: a `-D warnings` error
# sat in `src-tauri/src/permissions.rs` on Windows precisely because that file
# had never reached the public repo, and so had never been compiled by CI.
#
# Running this is therefore how macOS and Windows CI get to see your changes at
# all. Run it before you rely on CI being green.
#
# Usage:
#   ./scripts/sync-public.sh              # stage + show the diff, change nothing remote
#   ./scripts/sync-public.sh --pr         # push a sync branch and open a PR  (recommended)
#   ./scripts/sync-public.sh --push       # commit straight to the default branch
#
# Prefer --pr. `quality.yml` runs on `pull_request` as well as pushes to main, so
# a PR gets you macOS + Windows CI on the changes *before* the public default
# branch moves off the last released state.
#
# Requires: gh (authenticated), git.

set -euo pipefail

PUBLIC_REPO="${ADVERSARIA_PUBLIC_REPO:-LaghariLabs/adversaria}"
MODE="dry-run"
# Written long-hand: under `set -e`, `[ test ] && x` aborts the script when the
# test is false, which would make the default (dry-run) invocation exit silently.
case "${1:-}" in
  --pr)   MODE="pr" ;;
  --push) MODE="push" ;;
  "")     MODE="dry-run" ;;
  *)      echo "Usage: $0 [--pr | --push]" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --- What never leaves this repo -------------------------------------------
# Path prefixes stripped from the public mirror. Derived from the current public
# tree, not invented: strategy//marketing/monetization material, session memory
# (HANDOFF/STATUS), agent instructions, benchmark corpora with meeting text, and
# the landing site.
PRIVATE_PREFIXES=(
  "CLAUDE.md"
  "HANDOFF.md"
  "STATUS.md"
  "STRATEGY.md"
  "SPEC.md"
  "launch-plan-adversaria.html"
  "start_python_service.bat"
  "docs/"
  "experiments/"
  "landing/"
  "marketing/"
  "release/"
  # Local AI-agent tooling — installed skills, hooks and their vendored
  # detectors. Added 2026-08-03 after a sync staged 74 such files and ~140k
  # lines (one bundled detector alone is 8,283), which would have (a)
  # republished third-party skill content under this repo's licence, (b) buried
  # a ~48-file product change in a 357-file PR, and (c) shipped machine-local
  # tooling that has nothing to do with building the app on any platform.
  # NB: the installer wrote THREE copies — .agents/, .claude/skills/ and
  # .github/skills/ (~3.2 MB each). `.github/` itself must stay public: the
  # workflows there are what build macOS and Windows, so scope this to the
  # skills subtree only.
  ".agents/"
  ".claude/"
  ".codex/"
  ".github/skills/"
  "skills-lock.json"
)

# The only docs that DO ship publicly — architecture and the privacy/network
# boundary statement, both of which the README links.
PUBLIC_DOCS=(
  "docs/ARCHITECTURE.md"
  "docs/PRIVACY_NETWORK_BOUNDARIES.md"
)

is_private() {
  local path="$1" allowed prefix
  for allowed in "${PUBLIC_DOCS[@]}"; do
    if [ "$path" = "$allowed" ]; then
      return 1
    fi
  done
  for prefix in "${PRIVATE_PREFIXES[@]}"; do
    case "$path" in "$prefix"*) return 0 ;; esac
  done
  return 1
}

# --- Preconditions ----------------------------------------------------------
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is dirty. Commit or stash first — this mirrors committed state." >&2
  exit 1
fi

command -v gh >/dev/null || { echo "ERROR: gh is not installed." >&2; exit 1; }

SOURCE_SHA="$(git rev-parse --short HEAD)"
SOURCE_SUBJECT="$(git log -1 --format=%s)"
echo "==> Source: $SOURCE_SHA  $SOURCE_SUBJECT"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "==> Cloning $PUBLIC_REPO"
gh repo clone "$PUBLIC_REPO" "$STAGE/public" -- --quiet

# --- Build the filtered tree -----------------------------------------------
# `git ls-files` is the tracked set, so .gitignore (target/, dist/, node_modules)
# is honoured for free and no build artifact or 82 MB installer can slip in.
copied=0
skipped=0
while IFS= read -r path; do
  if is_private "$path"; then
    skipped=$((skipped + 1))
    continue
  fi
  mkdir -p "$STAGE/public/$(dirname "$path")"
  cp "$path" "$STAGE/public/$path"
  copied=$((copied + 1))
done < <(git ls-files)

echo "==> Mirrored $copied files, withheld $skipped"

# Delete anything the public repo still has that the filtered set no longer
# contains, so a rename or deletion here propagates instead of accumulating.
cd "$STAGE/public"
while IFS= read -r path; do
  if [ -f "$REPO_ROOT/$path" ] && ! is_private "$path"; then
    continue
  fi
  git rm -q --ignore-unmatch "$path"
done < <(git ls-files)

git add -A

# --- Leak check -------------------------------------------------------------
# Deterministic and path-based, and it runs against what is actually staged —
# so it catches a mistake in the filter itself rather than trusting it.
leaked=0
while IFS= read -r path; do
  if is_private "$path"; then
    echo "LEAK: $path would be published" >&2
    leaked=1
  fi
done < <(git ls-files)

if [ "$leaked" -ne 0 ]; then
  echo "ERROR: private paths reached the staged tree. Nothing was pushed." >&2
  exit 1
fi

# --- Report -----------------------------------------------------------------
if git diff --cached --quiet; then
  echo "==> Public repo already matches. Nothing to do."
  exit 0
fi

echo
echo "==> Changes to publish:"
git diff --cached --stat
echo

if [ "$MODE" = "dry-run" ]; then
  echo "Dry run. Re-run with --pr (recommended) or --push to publish."
  echo "Publishing is what makes CI build these changes at all."
  exit 0
fi

SYNC_BRANCH="sync/workspace-$SOURCE_SHA"

if [ "$MODE" = "pr" ]; then
  git checkout -q -b "$SYNC_BRANCH"
fi

git commit -q -F - <<EOF
sync: mirror workspace $SOURCE_SHA

$SOURCE_SUBJECT

Mirrored by scripts/sync-public.sh from the private workspace.
EOF

if [ "$MODE" = "push" ]; then
  git push -q origin HEAD
  echo "==> Pushed to the default branch. Watch CI:  gh run watch --repo $PUBLIC_REPO"
  exit 0
fi

git push -q -u origin "$SYNC_BRANCH"
gh pr create \
  --repo "$PUBLIC_REPO" \
  --head "$SYNC_BRANCH" \
  --title "sync: mirror workspace $SOURCE_SHA" \
  --body "$(cat <<EOF
Mirrors the private workspace at \`$SOURCE_SHA\` — *$SOURCE_SUBJECT*.

Opened as a PR rather than pushed to the default branch so that **CI builds this
before the public default branch moves off the last released state**. The two
repos share no history, so anything that has not been mirrored has never been
compiled or linted by CI on any platform.

Merge once the macOS and Windows legs of \`Quality gates\` are green.

Generated by \`scripts/sync-public.sh --pr\`.
EOF
)"
echo "==> PR opened. Watch CI:  gh pr checks --repo $PUBLIC_REPO --watch"
