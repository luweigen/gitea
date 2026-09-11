#!/usr/bin/env bash
# Copyright 2026 The Gitea Authors. All rights reserved.
# SPDX-License-Identifier: MIT
#
# Runs the flir-seq tests. See ./README.md.
#
#   ./run.sh                       the synthetic fixture and ./samples
#   ./run.sh path/to/other.seq     that recording instead of ./samples
#
# The recordings in ./samples ship with the repository, so this needs nothing
# fetched; ./setup.sh installs playwright-core for the browser part.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

recordings=("$@")
if [ ${#recordings[@]} -eq 0 ]; then
  while IFS= read -r f; do recordings+=("$f"); done < <(find samples -name '*.seq' | sort)
fi

echo "== parser, radiometry and translations =="
node run.mjs "${recordings[@]}"

echo
echo "== browser: synthetic fixture =="
node browser.mjs

for f in "${recordings[@]}"; do
  echo
  echo "== browser: $(basename "$f") =="
  FLIR_SEQ_SAMPLE="$f" node browser.mjs
done
