#!/usr/bin/env bash
# Copyright 2026 The Gitea Authors. All rights reserved.
# SPDX-License-Identifier: MIT
#
# Builds the browser test environment for contrib/markdown-draw.
#
#   ./setup.sh
#
# Fetches, into ./vendor (git-ignored):
#   * js-draw       -- through ../install.sh, so the installer is exercised too
#   * monaco-editor -- the version Gitea pins in its package.json, because the
#                      file editor tests drive the real editor, not a stand-in
# and installs playwright-core.
#
# Everything is local to this directory; nothing touches a Gitea instance.

set -euo pipefail

test_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${test_dir}/../../.." && pwd)"
vendor="${test_dir}/vendor"

for tool in curl tar node npm; do
  command -v "$tool" >/dev/null || { echo "error: $tool is required" >&2; exit 1; }
done

mkdir -p "$vendor"

# --- 1. js-draw, via the installer itself
echo "==> js-draw (through ../install.sh)"
"${test_dir}/../install.sh" "${vendor}/custom" >/dev/null
echo "    $(ls "${vendor}/custom/public/assets/js-draw" | tr '\n' ' ')"

# --- 2. monaco-editor, matching whatever Gitea currently pins
monaco_version="$(
  sed -n 's/.*"monaco-editor"[[:space:]]*:[[:space:]]*"\([0-9.]*\)".*/\1/p' \
    "${repo_root}/package.json" | head -1
)"
if [ -z "$monaco_version" ]; then
  monaco_version="0.55.1"
  echo "==> monaco-editor ${monaco_version} (could not read Gitea's pin, using the default)"
else
  echo "==> monaco-editor ${monaco_version} (Gitea's pin)"
fi

if [ -f "${vendor}/monaco/.version" ] && [ "$(cat "${vendor}/monaco/.version")" = "$monaco_version" ]; then
  echo "    already present"
else
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  curl -fsSL -o "${work}/monaco.tgz" \
    "https://registry.npmjs.org/monaco-editor/-/monaco-editor-${monaco_version}.tgz"
  rm -rf "${vendor}/monaco"
  mkdir -p "${vendor}/monaco"
  # only the AMD build is needed, it loads without a bundler
  tar -xzf "${work}/monaco.tgz" -C "$work" package/min
  mv "${work}/package/min" "${vendor}/monaco/min"
  echo "$monaco_version" >"${vendor}/monaco/.version"
  echo "    $(du -sh "${vendor}/monaco" | cut -f1)"
fi

# --- 3. playwright-core
echo "==> playwright-core"
cd "$test_dir"
npm install --no-audit --no-fund --silent

# --- 4. a browser to drive
echo "==> chromium"
if node -e '
  const {chromium} = require("playwright-core");
  const {existsSync} = require("fs");
  let p = "";
  try { p = chromium.executablePath(); } catch {}
  process.exit(p && existsSync(p) ? 0 : 1);
' 2>/dev/null; then
  echo "    found via playwright-core"
elif [ -n "${CHROMIUM:-}" ] && [ -x "${CHROMIUM}" ]; then
  echo "    using \$CHROMIUM=${CHROMIUM}"
elif node "${test_dir}/lib.mjs" --print-chromium >/dev/null 2>&1; then
  echo "    found at $(node "${test_dir}/lib.mjs" --print-chromium)"
else
  echo "    not found. Either run:  npx playwright install chromium"
  echo "    or point CHROMIUM at an existing Chrome/Chromium binary."
fi

echo
echo "done. now run:  ./run.sh"
