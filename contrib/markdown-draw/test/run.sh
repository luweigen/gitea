#!/usr/bin/env bash
# Copyright 2026 The Gitea Authors. All rights reserved.
# SPDX-License-Identifier: MIT
#
# Runs the markdown-draw browser suites. See ./README.md.
#
#   ./run.sh                 all suites
#   ./run.sh colour-picker   one suite

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec node run.mjs "$@"
