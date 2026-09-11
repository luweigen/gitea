#!/usr/bin/env bash
# Copyright 2026 The Gitea Authors. All rights reserved.
# SPDX-License-Identifier: MIT
#
# Runs the flir-seq tests. See ./README.md.
#
#   ./run.sh                       parser tests, then the browser test
#   ./run.sh path/to/real.seq      also run both against a real camera file

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "== parser and radiometry =="
node run.mjs "$@"

echo
echo "== browser =="
if [ -n "${1:-}" ]; then
  FLIR_SEQ_SAMPLE="$1" node browser.mjs
else
  node browser.mjs
fi
