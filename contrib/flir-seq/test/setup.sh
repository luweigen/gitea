#!/usr/bin/env bash
# Copyright 2026 The Gitea Authors. All rights reserved.
# SPDX-License-Identifier: MIT
#
# Installs playwright-core for the browser test. The parser tests
# (node run.mjs) need nothing at all -- skip this if that is all you want.
#
#   ./setup.sh

set -euo pipefail
test_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for tool in node npm; do
  command -v "$tool" >/dev/null || { echo "error: $tool is required" >&2; exit 1; }
done

echo "==> playwright-core"
cd "$test_dir"
npm install --no-audit --no-fund --silent

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
elif [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ -d "${PLAYWRIGHT_BROWSERS_PATH}" ]; then
  echo "    browser.mjs will look under \$PLAYWRIGHT_BROWSERS_PATH"
else
  echo "    not found. Either run:  npx playwright install chromium"
  echo "    or point CHROMIUM at an existing Chrome/Chromium binary."
fi

echo
echo "done. now run:  ./run.sh"
